{
  description = "igloo — per-project microVMs for coding agents";

  inputs = {
    microvm = {
      inputs.nixpkgs.follows = "nixpkgs";
      url = "github:microvm-nix/microvm.nix";
    };
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    {
      microvm,
      nixpkgs,
      self,
      ...
    }:
    let
      inherit (nixpkgs) lib;

      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};

      inherit
        (import ./nix/runner.nix {
          inherit
            lib
            microvm
            pkgs
            system
            ;
        })
        mkRunner
        overridden
        ;

      testVm = import ./nix/test-vm.nix;

      inherit
        (import ./nix/packages.nix {
          inherit
            lib
            pkgs
            self
            system
            ;
        })
        broker
        cli
        landlock
        storeView
        ;
    in
    {
      # `nix flake check` builds the packages, and checks that a content
      # module cannot reach host execution and can disable the guest core.
      checks.${system} =
        self.packages.${system}
        // import ./nix/checks.nix {
          inherit (self.nixosModules) guest;
          inherit
            lib
            mkRunner
            overridden
            pkgs
            testVm
            ;
        };

      devShells.${system}.default = import ./nix/devshell.nix {
        inherit
          broker
          landlock
          pkgs
          storeView
          ;
      };

      # `nix fmt` runs nixfmt over every Nix file in the checkout, and
      # `nix fmt -- --ci` fails instead where one is not formatted.
      formatter.${system} = pkgs.nixfmt-tree;

      lib = { inherit mkRunner; };

      nixosModules = {
        # The host side of an install — this is what a system configuration
        # imports.
        default = import ./nix/host.nix;

        # The guest core, exposed separately so a caller can import, inspect or
        # `disabledModules` it, outside `mkRunner` or from a content module
        # passed to it. Exported as a path, not the module in it, because a
        # module imported by path is disabled by naming that path, and
        # `mkRunner` imports the core by this one. Named for the machine it
        # configures: this one is for the VM igloo builds, and `default` above
        # is for the machine igloo runs on. Reading it the other way round
        # produces a system configuration that evaluates and does nothing.
        guest = ./nix/guest.nix;
      };

      # Separate from `nixosModules` because the two halves of an install are
      # owned by different configurations: the system grants what only root can
      # grant, and the user installs igloo with the layer that applies to their
      # own VMs.
      homeModules.default = import ./nix/home.nix { inherit cli; };

      # The package as this flake built it, not rebuilt against the consumer's
      # `pkgs` — which is what an overlay usually does and what would break it
      # here. `IGLOO_VIRTIOFSD` has to be the same derivation `mkRunner` pins,
      # because the daemon serving the store execs inside a namespace holding
      # only the runner's closure; a copy from another nixpkgs is not in it.
      overlays.default = _final: _prev: { igloo = cli; };

      packages.${system} = {
        inherit
          broker
          landlock
          storeView
          ;
        testVm = mkRunner testVm;
        igloo = cli;
        default = cli;
      };
    };
}
