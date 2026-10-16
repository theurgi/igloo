# `nix develop`: the tools igloo is worked on with, and the `IGLOO_*`
# programs pointed at this flake's own builds.
{
  broker,
  landlock,
  pkgs,
  storeView,
}:
pkgs.mkShell {
  # The guest's core packages are on PATH deliberately, not for
  # convenience. The runner's virtiofsd wrapper calls `nproc` and `id` by
  # bare name, and it runs in a namespace where /nix/store holds only the
  # runner's closure — so those names have to resolve to *this* `pkgs`,
  # whose store paths are closure members. Resolved against the ambient
  # profile instead they are invisible inside the namespace, and the tell
  # is a boot that stalls at the socket poll with an empty log.
  #
  # `perl` is the tests': their stand-ins for QEMU and `ssh` run under
  # units confined to the store, and bun will not start under those
  # units' `MemoryDenyWriteExecute=`. `util-linux` is the tests' too:
  # their probes inside those units run `ipcs` and `dmesg`, which have to
  # come from the store rather than from whatever the host has. `openssl`
  # is the CLI's, which makes the broker's TLS certificate with it, as the
  # installed package does.
  buildInputs = import ./core-packages.nix pkgs ++ [
    pkgs.bubblewrap
    pkgs.bun
    pkgs.openssh
    pkgs.openssl
    pkgs.perl
    pkgs.shellcheck
    pkgs.util-linux
  ];
  shellHook = ''
    # Current bubblewrap has no setuid mode and works through unprivileged
    # user namespaces, so a setuid wrapper at a fixed path refuses to
    # exec. Point at this devshell's own binary so no host install is
    # needed. Only the fallback sandbox runs it.
    export IGLOO_BWRAP="${pkgs.bubblewrap}/bin/bwrap"

    # What the store's virtio-fs daemon runs under, restricting its
    # /nix/store to the runner's closure.
    export IGLOO_STORE_VIEW="${storeView}/bin/igloo-store-view"

    # The `ssh` helper that turns `vsock/<cid>` into an AF_VSOCK
    # connection. The CLI otherwise falls back to the running system's
    # copy, which is a different systemd from the one this flake pins.
    export IGLOO_SSH_PROXY="${pkgs.systemd}/lib/systemd/systemd-ssh-proxy"

    # The virtio-fs daemon the CLI runs, one process per share. It has to
    # be this `pkgs`' — the same derivation `mkRunner` pins — because the
    # daemon serving the store execs inside a namespace holding only the
    # runner's closure, and any other copy is not in it.
    export IGLOO_VIRTIOFSD="${pkgs.virtiofsd}/bin/virtiofsd"

    # The per-VM credential broker. A store path, because the host
    # confines it to its own closure and a script in the checkout has
    # none.
    export IGLOO_BROKER="${broker}/bin/igloo-broker"

    # What the broker and the published ports run under, keeping them from
    # the user's loopback services and abstract sockets.
    export IGLOO_LANDLOCK="${landlock}/bin/igloo-landlock"

    # Frozen, so a `bun.lock` that disagrees with `package.json` fails
    # here rather than being rewritten on the way into a shell. Changing
    # the lockfile is a `bun install` run by hand. An install that finds
    # nothing to change leaves `node_modules` as old as it was, hence the
    # `touch`.
    if [ -f package.json ]; then
      if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
        echo "igloo: bun install --frozen-lockfile"
        bun install --frozen-lockfile && touch node_modules
      fi
    fi
  '';
}
