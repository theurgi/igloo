# What a content module cannot set, as `nix flake check` checks it. Each
# case is testVm with one content module added that tries to reach host
# execution: through an option policy owns, an overlay or a replaced
# runner. Each is held to one of three outcomes: refused while
# evaluating, refused while building, or no effect on the runner at all.
# One more case disables the guest core, which content may do, and has to
# leave the core gone and every pin held.
{
  guest,
  lib,
  mkRunner,
  overridden,
  pkgs,
  testVm,
}:
let
  reference = (mkRunner testVm).drvPath;

  withContent = module: testVm // { contentModules = testVm.contentModules ++ [ module ]; };

  # A definition at a priority that beats the policy floor, where the
  # comparison after the merge is the only thing left. `mkRunner` has to
  # throw, and for the option the case overrides and no other: a case
  # that fails for some unrelated reason, a definition of the wrong type
  # say, throws as well.
  refusedOnEvaluation =
    name:
    { option, module }:
    let
      args = withContent module;
      found = overridden args;
    in
    assert lib.assertMsg (found == [ option ])
      "${name}: mkRunner should refuse ${option} alone, and refuses ${
        if found == [ ] then "nothing" else lib.concatStringsSep ", " found
      }";
    assert lib.assertMsg (
      !(builtins.tryEval (mkRunner args).drvPath).success
    ) "${name}: mkRunner returned a runner with ${option} overridden";
    pkgs.runCommandLocal "igloo-check-${name}" { } "touch $out";

  # A kernel or an initrd from outside the store, which QEMU would load
  # into the guest. The runner's own build has to refuse it, naming the
  # option, rather than fail for some other reason.
  refusedOnBuild =
    name:
    { option, module }:
    pkgs.runCommandLocal "igloo-check-${name}"
      { failed = pkgs.testers.testBuildFailure (mkRunner (withContent module)); }
      ''
        if ! grep -qF -- ${lib.escapeShellArg "igloo: ${option} resolves to "} "$failed/testBuildFailure.log"; then
          echo ${lib.escapeShellArg "${name}: the runner's build failed without refusing ${option}:"} >&2
          cat "$failed/testBuildFailure.log" >&2
          exit 1
        fi
        touch $out
      '';

  # A definition the policy floor discards, or an option `mkRunner` never
  # reads. Either way the runner is testVm's, the same derivation.
  unchanged =
    name: module:
    assert lib.assertMsg (
      (mkRunner (withContent module)).drvPath == reference
    ) "${name}: the content module changed the runner, which is no longer testVm's";
    pkgs.runCommandLocal "igloo-check-${name}" { } "touch $out";
in
lib.mapAttrs refusedOnEvaluation {
  preStart-override = {
    option = "microvm.preStart";
    module =
      { lib, ... }:
      {
        microvm.preStart = lib.mkOverride 9 "echo IGLOO-INJECTED";
      };
  };
  extraArgsScript-override = {
    option = "microvm.extraArgsScript";
    module =
      { lib, ... }:
      {
        microvm.extraArgsScript = lib.mkOverride 9 "/bin/echo";
      };
  };
  credentialFiles-override = {
    option = "microvm.credentialFiles";
    module =
      { lib, ... }:
      {
        microvm.credentialFiles = lib.mkOverride 9 { IGLOO_PROBE = "/etc/hostname"; };
      };
  };
  volumes-override = {
    option = "microvm.volumes";
    module =
      { lib, ... }:
      {
        microvm.volumes = lib.mkOverride 9 [
          {
            image = "/tmp/p.img";
            mountPoint = "/mnt/p";
            size = 16;
          }
        ];
      };
  };
  qemu-package-override = {
    option = "microvm.qemu.package";
    module =
      { lib, pkgs, ... }:
      {
        microvm.qemu.package = lib.mkOverride 9 pkgs.hello;
      };
  };
  virtiofsd-package-override = {
    option = "microvm.virtiofsd.package";
    module =
      { lib, pkgs, ... }:
      {
        microvm.virtiofsd.package = lib.mkOverride 9 pkgs.hello;
      };
  };
  storeOnDisk-override = {
    option = "microvm.storeOnDisk";
    module =
      { lib, ... }:
      {
        microvm.storeOnDisk = lib.mkOverride 9 true;
      };
  };
  # Not a host execution surface, but pinned all the same, and so
  # compared: the definitions and the comparison come from one attrset in
  # mkRunner.
  chrony-servers-override = {
    option = "services.chrony.servers";
    module =
      { lib, ... }:
      {
        services.chrony.servers = lib.mkOverride 9 [ "pool.ntp.org" ];
      };
  };
  # A substituted package set is caught by what `writeShellScript`
  # produces, so the substitution has to change that. Replacing the
  # function itself is both the most direct way to do it and the thing
  # being defended against: the runner's every script is built with it.
  #
  # Substituting `runtimeShell` from `prev` instead does not work as a
  # case: dash's own build chain reads `runtimeShell`, so the overlay is a
  # cycle and evaluation dies of infinite recursion inside the witness
  # rather than being refused by name.
  vmHostPackages-override = {
    option = "microvm.vmHostPackages";
    module =
      { lib, pkgs, ... }:
      {
        microvm.vmHostPackages = lib.mkOverride 9 (
          pkgs.extend (
            _final: prev: {
              writeShellScript = name: text: prev.writeShellScript name (text + "\n# tampered\n");
            }
          )
        );
      };
  };
  # A share's socket name is a path the host binds a daemon at, so it is
  # policy like the rest of the share: refused even when nothing else
  # about the share changed.
  shares-socket-override = {
    option = "microvm.shares";
    module =
      { lib, ... }:
      {
        microvm.shares = lib.mkOverride 9 [
          {
            mountPoint = "/nix/.ro-store";
            proto = "virtiofs";
            socket = "../igloo-escape.sock";
            source = "/nix/store";
            tag = "ro-store";
          }
        ];
      };
  };
}
# Definitions a content module can write today, at no special priority.
# Pinning these options would not stop a store path that is a symlink out
# of the store.
// lib.mapAttrs refusedOnBuild {
  initrd-plain-path = {
    option = "microvm.initrdPath";
    module = {
      microvm.initrdPath = "/etc/os-release";
    };
  };
  initrd-store-symlink = {
    option = "microvm.initrdPath";
    module =
      { pkgs, ... }:
      {
        microvm.initrdPath = "${pkgs.runCommand "igloo-escape-initrd" { } "ln -s /etc/os-release $out"}";
      };
  };
  kernel-store-symlink = {
    option = "microvm.kernel";
    module =
      { pkgs, ... }:
      {
        microvm.kernel =
          pkgs.runCommand "igloo-escape-kernel" { }
            "mkdir $out; ln -s /etc/os-release $out/bzImage";
      };
  };
}
// lib.mapAttrs unchanged {
  # The host execution surfaces, each at no special priority, below the
  # policy floor.
  preStart-plain = {
    microvm.preStart = "echo IGLOO-INJECTED";
  };
  extraArgsScript-plain = {
    microvm.extraArgsScript = "/bin/echo IGLOO-INJECTED";
  };
  credentialFiles-plain = {
    microvm.credentialFiles.IGLOO_PROBE = "/etc/hostname";
  };
  volumes-plain = {
    microvm.volumes = [
      {
        image = "/tmp/igloo-probe.img";
        mountPoint = "/mnt/probe";
        size = 16;
      }
    ];
  };
  # A store disk is a `types.path` QEMU would open as a drive for the
  # guest. `mkForce` on the path, because microvm.nix defines one of its
  # own whenever the store is on a disk.
  storeDisk-plain =
    { lib, ... }:
    {
      microvm.storeOnDisk = true;
      microvm.storeDisk = lib.mkForce "/etc/igloo-probe-store-disk";
    };

  # The runner replaced whole, through the options that name it rather
  # than any part of it. mkRunner builds its own and reads neither.
  declaredRunner-replaced =
    { config, ... }:
    {
      microvm.declaredRunner = config.microvm.runner.qemu.overrideAttrs (old: {
        buildCommand =
          old.buildCommand + "echo /igloo-check-escape > $out/share/microvm/virtiofs/ro-store/source\n";
      });
    };
  # `runner` is an attribute set with one definition already, so a
  # replacement needs a priority to win the merge.
  runner-qemu-replaced =
    { lib, pkgs, ... }:
    {
      microvm.runner.qemu = lib.mkForce (
        pkgs.runCommand "igloo-check-replaced-runner" { } ''
          mkdir -p $out/bin $out/share/microvm/virtiofs/escape
          echo escape.sock > $out/share/microvm/virtiofs/escape/socket
          echo /igloo-check-escape > $out/share/microvm/virtiofs/escape/source
          echo exit 1 > $out/bin/microvm-run
        ''
      );
    };

  # An overlay reaches the package set without naming an option, which is
  # the route a priority cannot oppose. The hypervisor the host executes
  # comes from igloo's own package set, so a tampered one that still
  # builds as QEMU does not reach it.
  overlay-qemu = {
    nixpkgs.overlays = [
      (_final: prev: {
        qemu_kvm = prev.qemu_kvm.overrideAttrs (old: {
          postInstall = (old.postInstall or "") + "\n# tampered\n";
        });
      })
    ];
  };

  # A package or package set that keeps what the pin compares and changes
  # what the runner would use, so the comparison passes it. The runner is
  # built from igloo's own instead. Each comes at a priority that wins the
  # merge, or through an `apply` on the option, which needs none.
  qemu-package-same-outPath =
    { lib, pkgs, ... }:
    {
      microvm.qemu.package = lib.mkOverride 9 (pkgs.qemu_kvm // { override = _: pkgs.hello; });
    };
  qemu-package-apply =
    { lib, pkgs, ... }:
    {
      options.microvm.qemu.package = lib.mkOption {
        apply = qemu: qemu // { override = _: pkgs.hello; };
      };
    };
  # `runCommandLocal` is what makes the runner, so the package set's
  # substitute is returned in its place, holding a share of its own.
  vmHostPackages-runner-replaced =
    { lib, pkgs, ... }:
    {
      microvm.vmHostPackages = lib.mkOverride 9 (
        pkgs
        // {
          buildPackages = pkgs.buildPackages // {
            runCommandLocal =
              _name: _env: _script:
              pkgs.runCommand "igloo-check-replaced-runner" { } ''
                mkdir -p $out/bin $out/share/microvm/virtiofs/escape
                echo escape.sock > $out/share/microvm/virtiofs/escape/socket
                echo /igloo-check-escape > $out/share/microvm/virtiofs/escape/source
                echo exit 1 > $out/bin/microvm-run
              '';
          };
        }
      );
    };
  # The comparison builds a script named `igloo-witness`; this set builds
  # that one as igloo's would and every other one differently.
  vmHostPackages-apply =
    { lib, ... }:
    {
      options.microvm.vmHostPackages = lib.mkOption {
        apply =
          set:
          set
          // {
            writeShellScript =
              name: text: set.writeShellScript name (if name == "igloo-witness" then text else "exit 1");
          };
      };
    };
}
// {
  # The core, disabled by the path the flake exports it as. Only the core
  # enables nix-ld, so the module's assertion fails the runner's
  # evaluation while the core is still applied. The core is also what
  # sets `stateVersion`, which nixpkgs warns about on every evaluation
  # without one.
  core-disabled =
    let
      args = withContent (
        { config, ... }:
        {
          disabledModules = [ guest ];
          assertions = [
            {
              assertion = !config.programs.nix-ld.enable;
              message = "core-disabled: nixosModules.guest is disabled, and the guest core is still applied";
            }
          ];
          system.stateVersion = "24.11";
        }
      );
      found = overridden args;
    in
    assert lib.assertMsg (found == [ ])
      "core-disabled: with the guest core disabled, mkRunner refuses ${lib.concatStringsSep ", " found}";
    builtins.seq (mkRunner args).drvPath (
      pkgs.runCommandLocal "igloo-check-core-disabled" { } "touch $out"
    );
}
