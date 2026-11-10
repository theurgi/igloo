# The user layer, declared rather than hand-written, and the `igloo` that
# carries it. The layer is a store directory holding the two files a
# project's layer holds, and with them the templates a new project's
# files are written from. The installed `igloo` is wrapped with
# `IGLOO_USER_LAYER` naming it — so nothing is written under `~/.config`
# for anyone to mistake for a file to edit, and a generation's `igloo` and
# its configuration roll back together.
#
# **Nothing here re-validates policy.** `Config.ts` already checks keys
# against the layer they are allowed in and says where a misplaced one
# belongs; a typed option per setting would be a second schema to keep in
# step with it, and the failure mode of drifting is worse than the typo it
# would catch. So `policy` is freeform, which also means it merges across
# modules the way any other attribute set does.
{ cli }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.igloo;

  policyJson = pkgs.writeText "igloo-policy.json" (builtins.toJSON cfg.policy);

  # Read back through `builtins.fromJSON` rather than rendered as Nix:
  # the policy plane is data, `import`ed with no arguments and read key
  # by key, and generating Nix syntax for it would invite the belief
  # that `lib.mkIf` works in the result. It does not, by design.
  #
  # The store path is absolute because this file is reached through a
  # symlink, and a relative path beside it would resolve next to the
  # link's target instead.
  policyFile = pkgs.writeText "igloo-policy.nix" ''
    builtins.fromJSON (builtins.readFile ${policyJson})
  '';

  # A module path usually names a file inside some store path — in a
  # flake-based configuration, that configuration's own source.
  # `toString` keeps the path but drops the dependency, so nothing would
  # hold that source and the next garbage collection would delete what
  # the layer imports. Interpolating the path instead is shorter and
  # wrong: it copies the one file out on its own, and the module's
  # relative imports stop resolving. So the path is kept as it is, and
  # the store path holding it is attached as a dependency. A path
  # outside the store is refused by an assertion below, since igloo
  # could not read it.
  modulePath =
    module:
    let
      path = toString module;
      holder = builtins.match "(${lib.escapeRegex builtins.storeDir}/[^/]+)(/.*)?" path;
    in
    if holder == null then
      path
    else
      builtins.appendContext path {
        ${builtins.head holder} = {
          path = true;
        };
      };

  # Packages are passed as store paths, not as names for the guest's
  # nixpkgs to resolve. That is what lets a layer use anything the
  # configuration declaring it can reach — another flake's packages, a
  # different pin, an overlay — without the layer itself having to fetch
  # anything. They are built by *this* `pkgs`, so a divergent pin can put
  # two of something in the guest's closure.
  guestFile = pkgs.writeText "igloo.nix" ''
    { ... }:
    {
      imports = [
        ${lib.concatMapStringsSep "\n    " modulePath cfg.guest.modules}
      ];
      environment.systemPackages = map builtins.storePath [
        ${lib.concatMapStringsSep "\n    " (p: "\"${p}\"") cfg.guest.packages}
      ];
    }
  '';

  # A path is copied into the store under a name of its own: under its
  # basename, a directory such as `.templates` would be refused, since no
  # store path begins with a dot. Anything else is a derivation or a store
  # path already.
  templates =
    if builtins.isPath cfg.templates then
      builtins.path {
        path = cfg.templates;
        name = "igloo-templates";
      }
    else
      cfg.templates;

  # The same two names a project's layer uses, in one directory, so a
  # layer reads the same whichever of the two it is. The templates are
  # the user layer's alone: a project is not there yet when they are
  # written.
  layer = pkgs.linkFarm "igloo-user-layer" (
    [
      {
        name = "igloo.nix";
        path = guestFile;
      }
      {
        name = "igloo-policy.nix";
        path = policyFile;
      }
    ]
    ++ lib.optional (cfg.templates != null) {
      name = "templates";
      path = templates;
    }
  );

  # A wrapper around the package's own wrapper, which already sets
  # everything else igloo needs, so a new layer is a new shell script
  # rather than a new build of the CLI.
  wrapped = pkgs.symlinkJoin {
    name = "igloo";
    paths = [ cfg.package ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram $out/bin/igloo --set IGLOO_USER_LAYER ${layer}
    '';
    meta.mainProgram = "igloo";
  };
in
{
  options.programs.igloo = {
    enable = lib.mkEnableOption "igloo, with this user's layer";

    package = lib.mkOption {
      type = lib.types.package;
      default = cli;
      defaultText = lib.literalExpression "igloo.packages.\${system}.default";
      description = ''
        The igloo package to install. It is wrapped with this user
        layer, so changing a setting rebuilds the wrapper and not the
        package.
      '';
    };

    policy = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = { };
      example = lib.literalExpression ''
        {
          network = "internet";
          mem = 8 * 1024;
          vcpu = 4;
          tunnelCeiling = [ "pypi.org" ];
        }
      '';
      description = ''
        The user layer's policy, written to `igloo-policy.nix`. Freeform
        on purpose: igloo validates these keys itself, naming the file
        and the layer a misplaced setting belongs in.
      '';
    };

    templates = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = lib.literalExpression "./igloo/templates";
      description = ''
        A directory of files every new project starts with, laid out
        like a project's root: `.vscode/settings.json` in it becomes
        `.vscode/settings.json` in the project, and
        `workspace/CLAUDE.md` becomes `workspace/CLAUDE.md`. A link in
        it is made as a link. `igloo init` writes them when it creates
        a project, filling in `@project_root@`, `@project_name@` and
        each `@name@` given as `--set name=value`, and never again:
        from then on a file is the project's. A path, or a derivation
        that builds the directory, for a value this configuration
        knows, such as a package's path.
      '';
    };

    guest = {
      modules = lib.mkOption {
        type = lib.types.listOf lib.types.path;
        default = [ ];
        example = lib.literalExpression "[ ./igloo/vm.nix ]";
        description = ''
          NixOS modules for every VM this user runs, as paths. Paths and
          not inline values: these are evaluated later, on the host,
          against the runner's own `pkgs` rather than this one. Each
          must be inside the store — any path is, in a flake-based
          configuration — because that evaluation reads nothing on the
          host outside the store, the layer files and the project's
          workspace. It is kept alive by this configuration, along with
          the rest of the source it sits in, so its relative imports
          keep resolving.
        '';
      };

      packages = lib.mkOption {
        type = lib.types.listOf lib.types.package;
        default = [ ];
        example = lib.literalExpression ''
          (with pkgs; [ bun git ripgrep ])
          ++ (with inputs.llm-agents.packages.''${system}; [ claude-code opencode ])
        '';
        description = ''
          Packages every VM this user runs gets. Evaluated here and
          passed to the guest as store paths, so anything this
          configuration can reach works — including another flake's
          packages, without the layer having to fetch them itself.
        '';
      };
    };
  };

  config = lib.mkIf cfg.enable {
    # Here rather than at launch, where the same path would fail as
    # nix refusing to read a file, with nothing to say which setting
    # named it.
    assertions = map (module: {
      assertion = lib.hasPrefix "${builtins.storeDir}/" (toString module);
      message = ''
        programs.igloo.guest.modules: ${toString module} is outside the
        Nix store. igloo builds a VM without reading anything on the
        host but the store, the layer files and the project's
        workspace, so it could not import this. In a flake-based
        configuration every path is in the store.
      '';
    }) cfg.guest.modules;
    home.packages = [ wrapped ];
  };
}
