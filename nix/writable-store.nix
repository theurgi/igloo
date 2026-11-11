# A Nix store the guest can add to, kept on the guest's disk.
#
# The store the host shares stays read-only and becomes the lower layer of
# an overlay. What the guest fetches or builds lands in the upper layer, on
# /persist, beside Nix's database, so both outlive a stop.
{
  config,
  lib,
  ...
}:
let
  cfg = config.igloo.writableStore;

  state = "/persist/nix";

  # The tunnel, where the VM has one. A unit does not get session
  # variables, and Nix reaches a substituter through nothing else.
  proxyEnv = lib.filterAttrs (
    name: _:
    lib.elem name [
      "HTTPS_PROXY"
      "https_proxy"
      "NO_PROXY"
      "no_proxy"
    ]
  ) config.environment.sessionVariables;
in
{
  options.igloo.writableStore.enable = lib.mkEnableOption ''
    a Nix store the guest can add to, kept on the guest's disk, so that
    `nix build`, `nix develop` and a flake's devshell work in the guest and
    what they fetch outlives a stop. Needs the VM to have a disk
  '';

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.fileSystems ? "/persist";
        message = "igloo.writableStore keeps the store on the guest's disk, and this VM has none: set `disk` in its policy.";
      }
    ];

    microvm.writableStoreOverlay = "${state}/rw-store";

    # Nix's record of which paths are valid, and its gc roots. On the tmpfs
    # root it would be rebuilt each boot from the VM's closure alone, and
    # every path in the upper layer would be a file Nix does not know and
    # fetches again. systemd creates the source directory on first boot.
    fileSystems."/nix/var" = {
      device = "${state}/var";
      fsType = "none";
      options = [ "bind" ];
      depends = [ "/persist" ];
      # The closure is registered before systemd starts.
      neededForBoot = true;
    };

    nix.settings.experimental-features = lib.mkDefault [
      "nix-command"
      "flakes"
    ];

    # Root uses the store directly. The daemon serves any other user, and
    # fetches on their behalf.
    systemd.services.nix-daemon.environment = proxyEnv;

    # The database outlives the closure it was filled from. After a change
    # to the VM's configuration, paths the old closure supplied are gone
    # from the lower layer and still recorded as valid, so whatever in the
    # upper layer refers to one is broken, and Nix does not fetch what it
    # believes it has.
    #
    # Verifying drops the records nothing refers to, with no network.
    # Those that are referred to are fetched again, into the upper layer.
    # The tunnel opens some time after boot, so that is retried.
    systemd.services.igloo-store-reconcile = {
      description = "Reconcile Nix's database with the store";
      wantedBy = [ "multi-user.target" ];
      unitConfig.RequiresMountsFor = [
        "/nix/store"
        "/nix/var"
      ];
      environment = proxyEnv;
      path = [ config.nix.package ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      script = ''
        # Prints the valid paths that are missing and referred to.
        missing() {
          nix-store --verify 2>&1 | sed -n "s/^path '\(.*\)' disappeared, but it still has valid referrers!$/\1/p"
        }

        left=$(missing)
        if [ -z "$left" ]; then
          exit 0
        fi
        echo "missing from the store and referred to, fetching again:"
        echo "$left"

        for _ in $(seq 60); do
          nix-store --verify --repair || true
          left=$(missing)
          if [ -z "$left" ]; then
            exit 0
          fi
          sleep 2
        done

        echo "could not be fetched; what refers to these is broken:" >&2
        echo "$left" >&2
        exit 1
      '';
    };
  };
}
