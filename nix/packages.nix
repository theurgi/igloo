# What igloo ships: the CLI, the broker it starts for a VM, and the two C
# helpers the host runs.
{
  lib,
  pkgs,
  self,
  system,
}:
let
  # The per-VM credential broker, as a store path rather than a file in the
  # checkout. Its closure is what the host confines it to, so it has to have
  # one — and the source it runs is fixed at build time, where a path into
  # the checkout would be a file the guest's workspace sits beside.
  #
  # `bun` is the whole of its closure besides the script, which is why the
  # script has no imports.
  broker = pkgs.writeShellScriptBin "igloo-broker" ''
    exec ${pkgs.bun}/bin/bun ${../src/broker.ts} "$@"
  '';

  # Runs the store's virtio-fs daemon in a namespace whose /nix/store holds
  # only the runner's closure. A store path, like the broker, because the
  # wrapper and the devshell name it; C, because it is a handful of system
  # calls and the closure it brings is the libc virtiofsd already has.
  storeView = pkgs.runCommandCC "igloo-store-view" { } ''
    mkdir -p $out/bin
    $CC -std=c11 -O2 -Wall -Wextra -o $out/bin/igloo-store-view ${../src/store-view.c}
  '';

  # Runs the broker and the published ports unable to reach the user's
  # loopback services or abstract sockets. C, because it is a handful of
  # system calls that have to be made before the program it runs starts a
  # thread, and its closure is the libc that program already has.
  landlock = pkgs.runCommandCC "igloo-landlock" { } ''
    mkdir -p $out/bin
    $CC -std=c11 -O2 -Wall -Wextra -o $out/bin/igloo-landlock ${../src/landlock.c}
  '';

  # One source for the release, which `src/index.ts` imports for
  # `--version`. The root package's own version is not part of the tree
  # `bun install` produces, so a bump leaves `cliDeps`' hash as it is.
  inherit (lib.importJSON ../package.json) version;

  # The commit this flake was taken from, for `igloo report`: the version
  # alone does not say which commit a checkout or an install of `main`
  # runs. A tree with uncommitted changes has only `dirtyRev`, and a
  # `path:` input neither.
  revision = self.rev or self.dirtyRev or null;

  # Just the two files that decide the dependency tree. The fetch below is
  # a fixed-output derivation, so its inputs must not include source files:
  # otherwise every edit invalidates a hash that has to be updated by hand.
  cliManifest = pkgs.runCommand "igloo-manifest" { } ''
    mkdir -p $out
    cp ${../package.json} $out/package.json
    cp ${../bun.lock} $out/bun.lock
  '';

  # Resolving dependencies needs the network, and only a fixed-output
  # derivation may have it — hence the hash, which has to be updated
  # whenever `bun.lock` changes. A build with the wrong one prints the right
  # one.
  #
  # `--production` because everything else in `package.json` is a lint, test
  # or type-check tool, and `--ignore-scripts` because the `prepare` script
  # patches binaries that `--production` did not install.
  cliDeps = pkgs.stdenvNoCC.mkDerivation {
    pname = "igloo-deps";
    inherit version;

    src = cliManifest;

    nativeBuildInputs = [ pkgs.bun ];

    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      bun install --frozen-lockfile --production --ignore-scripts --no-progress
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -R node_modules $out/node_modules
      runHook postInstall
    '';

    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    outputHash = "sha256-oHQFH1G3EErWx5ty20FyH29jgQdMheVhQxAHvBtol1I=";
  };

  # The compiled CLI, which `cli` wraps. A derivation of its own because the
  # wrapper names `self`, which changes with every file in the repository:
  # kept apart, an edit to the docs, the scripts, the tests or the C helpers
  # changes the wrapper and does not rebuild this.
  cliUnwrapped = pkgs.stdenvNoCC.mkDerivation {
    pname = "igloo-unwrapped";
    inherit version;

    # What `bun build` reads.
    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [
        ../package.json
        ../tsconfig.json
        (lib.fileset.fileFilter (file: file.hasExt "ts" && !lib.hasSuffix ".test.ts" file.name) ../src)
      ];
    };

    nativeBuildInputs = [ pkgs.bun ];

    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      ln -s ${cliDeps}/node_modules node_modules
      bun build --compile --sourcemap src/index.ts --outfile igloo
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      install -Dm755 igloo $out/bin/igloo
      runHook postInstall
    '';
  };

  # The CLI as something a host installs, rather than a checkout someone
  # puts on PATH. Three properties come from this and not from the code:
  #
  # - `IGLOO_FLAKE` is `self`, so the flake a VM is built from is a store
  #   path. Nothing a guest can reach is on the path from `igloo up` to a
  #   running VM. `IGLOO_REVISION` is its commit, when it has one.
  # - the binaries are the ones this flake pins, the same set the devshell
  #   exports, so the installed tool and the development tool resolve
  #   identically.
  # - `PATH` carries the closure's own tools, which the transient units
  #   inherit — so a launch does not depend on the shell it was started
  #   from.
  #
  # `nix`, `systemctl`, `systemd-run` and `loginctl` are deliberately left
  # to PATH: they have to be the running system's, not this flake's.
  cli = pkgs.stdenvNoCC.mkDerivation {
    pname = "igloo";
    inherit version;

    dontUnpack = true;

    nativeBuildInputs = [ pkgs.makeWrapper ];

    installPhase = ''
      runHook preInstall
      makeWrapper ${cliUnwrapped}/bin/igloo $out/bin/igloo \
        --inherit-argv0 \
        --set IGLOO_FLAKE ${self} \
        ${lib.optionalString (revision != null) "--set IGLOO_REVISION ${revision}"} \
        --set IGLOO_BROKER ${broker}/bin/igloo-broker \
        --set IGLOO_BWRAP ${pkgs.bubblewrap}/bin/bwrap \
        --set IGLOO_LANDLOCK ${landlock}/bin/igloo-landlock \
        --set IGLOO_SSH_PROXY ${pkgs.systemd}/lib/systemd/systemd-ssh-proxy \
        --set IGLOO_STORE_VIEW ${storeView}/bin/igloo-store-view \
        --set IGLOO_VIRTIOFSD ${pkgs.virtiofsd}/bin/virtiofsd \
        --prefix PATH : ${
          lib.makeBinPath [
            pkgs.coreutils
            pkgs.openssh
          ]
        }
      runHook postInstall
    '';

    meta = {
      description = "Per-project microVMs for coding agents";
      homepage = "https://github.com/theurgi/igloo";
      license = lib.licenses.mit;
      mainProgram = "igloo";
      platforms = [ system ];
    };
  };
in
{
  inherit
    broker
    cli
    landlock
    storeView
    ;
}
