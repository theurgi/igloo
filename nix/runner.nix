# `mkRunner`: build the microvm runner derivation for one VM.
#
# Every argument is policy: it is applied at the `policy` priority and
# checked against the merged configuration before a runner comes back, so a
# `contentModules` entry cannot override, widen, or append to it. Callers
# are expected to resolve these outside any directory the guest can write.
{
  lib,
  microvm,
  pkgs,
  system,
}:
let
  # Priority for policy options — the ones `mkRunner` owns and a guest
  # module may not set. 10 beats `mkForce` (50), and the module system
  # filters by priority before merging, so a policy definition discards a
  # guest module's list entries rather than concatenating with them.
  #
  # Keep policy definitions at this priority and nothing else at or below
  # it, or the guarantee silently becomes a merge. Priority alone is not the
  # whole guarantee — a module reaching for a lower number would still win —
  # so `mkRunner` compares the merged result against its arguments before
  # returning a runner.
  policy = lib.mkOverride 10;

  # By path, so that `disabledModules = [ igloo.nixosModules.guest ]`, the
  # same path, disables it.
  coreModule = ./guest.nix;

  # `mkRunner`'s arguments, evaluated into the runner they build and the
  # pins the merged configuration does not hold.
  evaluate =
    {
      # The certificate authority, as PEM, that issued the certificate the
      # broker answers its TLS names with, or null for a VM whose broker
      # answers none. The guest trusts it, so a client reaching such a name
      # through the tunnel verifies the broker as that host.
      #
      # Content, not policy, for the same reason `gitBroker` is: removing it
      # makes a client refuse the broker's certificate and fail. It cannot
      # make a credential reachable.
      brokerAuthority ? null,
      # Environment pointing the guest's model-provider clients at the
      # host's broker: a base URL per provider, and a placeholder where each
      # client expects a key. `{ }` for a VM with no such grant.
      #
      # Content, not policy, for the same reason `gitBroker` is: removing it
      # makes a client reach the provider directly with a placeholder key and
      # fail. It cannot make a credential reachable.
      brokerEnv ? { },
      # Files under the guest's /etc that point a client at the broker, as
      # { "igloo/opencode.json" = "…"; }: configuration a variable in
      # `brokerEnv` names. Content, as `brokerEnv` is.
      brokerEtc ? { },
      # Files pointing a client at the broker where it takes a base URL from
      # its own file in the home directory and nowhere else, as
      # [ { path; program; content; } ], `path` under root's home. Each is
      # written at boot when `program` is installed and `path` does not
      # exist, so a user's own file is never replaced. Content, as
      # `brokerEnv` is.
      brokerFiles ? [ ],
      # NixOS modules composing the guest environment — the content plane.
      # They compose by normal module semantics and may override anything in
      # `coreModule` or disable it whole; they may not set any of the
      # arguments below, whatever priority they reach for.
      contentModules ? [ ],
      # Credentials to place in the guest's runtime storage at boot:
      # { name, hostPath }. Each arrives at /run/credentials/@system/<name>,
      # on a tmpfs, and is gone when the VM stops.
      #
      # `hostPath` is read by QEMU at startup, so it must exist before the
      # VM starts and its contents are fixed for the VM's life — changing a
      # credential means stopping and starting the VM.
      #
      # This is the labelled escape hatch, not the norm: it puts a real
      # credential inside a VM whose root belongs to whatever is running in
      # there, which can copy it anywhere, including into a share that
      # persists.
      credentials ? [ ],
      # Git through the host's credential broker, as
      # { hosts = [ "github.com" ]; } — or null for a VM with no git grant,
      # which is the default.
      #
      # The broker answers each host listed itself, through the tunnel, so
      # an ordinary HTTPS URL reaches it as it is. Each host's SSH forms get
      # an `insteadOf` rewrite to that URL in the guest's system git config.
      #
      # Content, not policy: a module that removes the rewrite leaves an SSH
      # remote with no key to use, and fails. It cannot make a credential
      # reachable, which is the thing worth protecting, and the guest could
      # unset the same config at runtime anyway.
      gitBroker ? null,
      hostName ? "igloo",
      mem ? 4096,
      # Extra `microvm.shares` entries: { mountPoint, proto, source, tag }.
      # The read-only store share is added below and should not be repeated
      # here.
      shares ? [ ],
      # Public half of the caller's per-VM key. The private half stays with
      # the caller.
      sshAuthorizedKey,
      vcpu ? 4,
      # Guest CID for AF_VSOCK: at least 3 (0, 1 and 2 are reserved), and
      # unique across VMs running concurrently on one host. Allocating it is
      # the caller's job.
      vsockCid,
    }:
    # QEMU hangs at exactly 2 GiB, with no output and no exit — so the
    # symptom is a boot that never completes rather than an error.
    # microvm.nix warns during evaluation; fail instead, since an eval
    # warning scrolls past and a hung VM does not explain itself.
    # https://github.com/microvm-nix/microvm.nix/issues/171
    assert lib.assertMsg (mem != 2048) "mem must not be exactly 2048 (QEMU hangs); use 2047 or 4096";
    # A name with a comma in it would not be a bad name — it would be a
    # second `-fw_cfg` option. systemd also uses the name as a filename.
    # NixOS writes a session variable into a shell script and a PAM file
    # inside double quotes, unescaped, so a quote or a backslash in a value
    # would end it or change it, silently. Configuration that needs either
    # goes in `brokerEtc`.
    assert lib.all (
      name:
      lib.assertMsg (
        builtins.match ''.*["\\].*'' brokerEnv.${name} == null
      ) "brokerEnv.${name} holds a quote or a backslash, which a session variable cannot carry"
    ) (lib.attrNames brokerEnv);
    assert lib.all (
      credential:
      lib.assertMsg (builtins.match "[A-Za-z0-9_][A-Za-z0-9_.-]*" credential.name != null)
        "credential name ${credential.name} must be letters, digits, _, . or -, starting with a letter, digit or underscore"
    ) credentials;
    let
      # Send the guest's git to the broker for the hosts it holds a grant
      # for. An HTTPS URL reaches it as written; `git@host:` and
      # `ssh://git@host/` are rewritten to one, since the SSH key is not in
      # the guest, so an SSH remote would otherwise fail, and a remote written
      # either way is the same repository.
      gitBrokerModule =
        { ... }:
        {
          # Plain rather than `mkDefault`: git is what reads this
          # configuration, so a VM brokering git and not installing it is a
          # contradiction, and a content module that sets the same option
          # either agrees or gets a conflict naming it.
          programs.git.enable = true;
          programs.git.config.url = lib.listToAttrs (
            map (
              host:
              lib.nameValuePair "https://${host}/" {
                insteadOf = [
                  "git@${host}:"
                  "ssh://git@${host}/"
                ];
              }
            ) gitBroker.hosts
          );
        };

      # Trust the authority behind the broker's certificate, beside the
      # system's own.
      brokerAuthorityModule =
        { ... }:
        {
          security.pki.certificates = [ brokerAuthority ];
        };

      # Point the guest's model-provider clients at the broker. Session
      # variables reach every login: Claude Code reads its base URL from one,
      # opencode its configuration, and every client its placeholder key.
      brokerEnvModule =
        { ... }:
        {
          environment.sessionVariables = brokerEnv;
          environment.etc = lib.mapAttrs (_: text: { inherit text; }) brokerEtc;
        };

      # The clients that read a base URL from their own file and nowhere
      # else. Written once, at boot, and left alone after: the broker's
      # address is fixed, so a file written once stays right, and one the
      # user keeps is theirs.
      brokerFilesModule =
        { config, pkgs, ... }:
        let
          home = config.users.users.root.home;
        in
        {
          systemd.services.igloo-broker-client-files = {
            description = "Point model clients at the credential broker";
            wantedBy = [ "multi-user.target" ];
            unitConfig.RequiresMountsFor = [ home ];
            serviceConfig = {
              Type = "oneshot";
              RemainAfterExit = true;
            };
            script = lib.concatMapStrings (
              file:
              let
                target = lib.escapeShellArg "${home}/${file.path}";
              in
              ''
                if [ -x ${lib.escapeShellArg "/run/current-system/sw/bin/${file.program}"} ] &&
                  [ ! -e ${target} ] && [ ! -L ${target} ]; then
                  install -D -m 0644 ${pkgs.writeText "igloo-${file.program}-broker" file.content} ${target}
                fi
              ''
            ) brokerFiles;
          };
        };

      # microvm.nix does not add the store share: `microvm.shares` defaults
      # to [] and no guest module appends one, so a runner without it boots
      # with no /nix/store.
      #
      # `source` stays "/nix/store" so the guest-side store logic is
      # untouched. Restricting what the guest actually sees happens
      # host-side, by serving a namespace in which /nix/store holds only
      # this runner's closure.
      #
      # `socket` is microvm.nix's default name, set here so that the check
      # below covers it. The host reads it back off the runner and binds a
      # daemon there, relative to the VM's runtime directory, so a socket
      # name is a path the host writes.
      withSocket = share: share // { socket = "${hostName}-virtiofs-${share.tag}.sock"; };
      allShares = map withSocket (
        [
          {
            mountPoint = "/nix/.ro-store";
            proto = "virtiofs";
            source = "/nix/store";
            tag = "ro-store";
          }
        ]
        ++ shares
      );

      # Credentials reach the guest through QEMU's fw_cfg device, which
      # systemd reads at startup and lays out under
      # /run/credentials/@system/ — a tmpfs, so nothing is written to the
      # guest's disk and nothing survives a stop.
      #
      # Not `-smbios type=11`, the other route systemd accepts: that one
      # carries the value itself on QEMU's command line, where it is
      # readable by anyone who can see /proc/<pid>/cmdline. This carries a
      # path, and QEMU reads the file.
      #
      # QEMU splits these parameters on commas, so a comma in a path has to
      # be doubled or the rest of the path becomes further options.
      credentialArgs = lib.concatMap (credential: [
        "-fw_cfg"
        "name=opt/io.systemd.credentials/${credential.name},file=${
          lib.replaceStrings [ "," ] [ ",," ] credential.hostPath
        }"
      ]) credentials;

      qemuArgs = credentialArgs;

      # Every option `mkRunner` owns, and the value it holds each to. This
      # one attrset makes both the `policy` definitions the guest is built
      # with and the comparison after it, so nothing is pinned without being
      # compared. `same` says how to compare a merged value where `==`
      # cannot; without it, the comparison is `==`.
      pins = {
        "networking.hostName".value = hostName;
        "users.users.root.openssh.authorizedKeys.keys".value = [ sshAuthorizedKey ];

        "microvm.hypervisor".value = "qemu";
        "microvm.mem".value = mem;
        "microvm.vcpu".value = vcpu;

        # Compared on the fields set here. The option's own type may add
        # defaults to each entry, which would make a whole-value comparison
        # fail on a VM that is perfectly correct.
        "microvm.shares" = {
          value = allShares;
          same = held: shareFields held == shareFields allShares;
        };
        # The store reaches the guest through its share and nothing else.
        # A store disk is `microvm.storeDisk`, a `types.path` that QEMU
        # would open as a drive for the guest to read.
        "microvm.storeOnDisk".value = false;

        "microvm.vsock.cid".value = vsockCid;
        # Raises sshd on vsock::22 via systemd-ssh-generator; the host
        # connects with `ssh vsock/<cid>`.
        "microvm.vsock.ssh.enable".value = true;

        # Keep every share a single guest superblock. The host-side store
        # namespace is hundreds of bind mounts under one share, and
        # announcing them makes the guest auto-mount a virtiofs per closure
        # path. Tearing those down at poweroff faults ("VFS: Busy inodes
        # after unmount of virtiofs"), the shutdown job hangs, and QEMU
        # never exits. virtiofsd still serves across the binds; this only
        # suppresses telling the guest.
        "microvm.virtiofsd.extraArgs".value = [ "--no-announce-submounts" ];

        # QMP socket, in QEMU's working directory, which `igloo down`
        # connects to by this name. With no lifetime logic in the guest,
        # this is how a VM is asked to stop.
        "microvm.socket".value = "control.socket";

        # Device passthrough is the caller's to decide, not a guest
        # module's. Pinned empty until there is a reason to expose it.
        "microvm.devices".value = [ ];

        "microvm.qemu.extraArgs".value = qemuArgs;
        "microvm.interfaces".value = [ ];

        # No host→guest forwards at all. Publishing a guest port is a
        # capability to add deliberately, as its own argument.
        "microvm.forwardPorts".value = [ ];

        # Host execution surfaces. The runner's scripts run on the host, as
        # the user who launched the VM, and each of these is interpolated
        # into one of them or into QEMU's command line: shell before launch,
        # shell whose stdout becomes QEMU arguments, host files created and
        # formatted, and a host file handed to the guest. Nothing else here
        # defines them, so without these a content module's definition would
        # be the only one — and `preStart` is `types.lines`, which
        # concatenates rather than conflicts, so it would not even need a
        # priority to win.
        "microvm.credentialFiles".value = { };
        "microvm.extraArgsScript".value = null;
        "microvm.preStart".value = "";
        "microvm.volumes".value = [ ];

        # The hypervisor the host runs, and the package set the runner's
        # scripts are built from. `pkgs` here is igloo's own, resolved
        # outside the guest evaluation — the guest's `pkgs` carries whatever
        # overlays `contentModules` added, so taking these from a guest
        # module's arguments would hand the hypervisor and the scripts' shell
        # to content. The runner below is built from igloo's whatever the
        # merged values are; the comparison refuses a module that names
        # another.
        "microvm.qemu.package" = {
          value = pkgs.qemu_kvm;
          same = held: held.outPath == pkgs.qemu_kvm.outPath;
        };
        # The daemons serving the shares are igloo's own binary, not the
        # runner's, whose virtiofsd reaches only `bin/virtiofsd-run`, which
        # nothing runs. Pinned so that the binary the host runs is in the
        # runner's closure: the store's daemon sees nothing else of the
        # store. A value that keeps the `outPath` and changes what
        # `lib.getExe` finds still drops it, and the launch refuses that
        # runner.
        "microvm.virtiofsd.package" = {
          value = pkgs.virtiofsd;
          same = held: held.outPath == pkgs.virtiofsd.outPath;
        };
        # Two package sets cannot be compared whole — they are deeply
        # recursive — and no single package stands for the set, since what
        # the runner takes from it is `writeShellScript`, which decides the
        # interpreter of every script the host then executes. So build one
        # and compare where it landed.
        "microvm.vmHostPackages" = {
          value = pkgs;
          same =
            held:
            let
              witness = set: (set.writeShellScript "igloo-witness" "").outPath;
            in
            witness held == witness pkgs;
        };

        # No guest has a NIC, so the PHC refclock is the only usable time
        # source, and configured NTP servers would just log failures. NTP is
        # not something the broker carries.
        "services.chrony.servers".value = [ ];
      };

      guest = lib.nixosSystem {
        inherit system;
        modules = [
          microvm.nixosModules.microvm
          coreModule
        ]
        ++ lib.optional (gitBroker != null) gitBrokerModule
        ++ lib.optional (brokerAuthority != null) brokerAuthorityModule
        ++ lib.optional (brokerEnv != { }) brokerEnvModule
        ++ lib.optional (brokerFiles != [ ]) brokerFilesModule
        ++ contentModules
        ++ [
          {
            config = lib.mkMerge (
              lib.mapAttrsToList (name: pin: lib.setAttrByPath (lib.splitString "." name) (policy pin.value)) pins
            );
          }
        ];
      };

      # QEMU loads the kernel and initrd it is handed into the guest's
      # memory, where the guest can read them back, and content chose both.
      # `microvm.initrdPath` is `types.path`, which takes any absolute
      # string, and a kernel or initrd in the store may be a symlink to
      # anywhere. QEMU's unit sees only the store and its own runtime
      # directory, so most such paths would fail at boot; the runner's own
      # build refuses every one instead, naming the option. Resolved in the
      # build sandbox, a store path the build does not depend on is missing
      # too, so that is refused as well — the unit could have opened it.
      #
      # Each is computed here the way microvm.nix computes it, from the
      # `pkgs` the runner below is built with, and the check first finds it
      # on the runner's command line. A change in how microvm.nix derives
      # them then fails the build, rather than leaving this to check a path
      # QEMU is not given.
      bootFiles = {
        "-kernel" = {
          option = "microvm.kernel";
          path = "${guest.config.microvm.kernel.out}/${
            pkgs.linux.target or pkgs.stdenv.hostPlatform.linux-kernel.target
          }";
        };
        # `toString`, as microvm.nix's shell escaping does: interpolating a
        # path value would copy it into the store and check the copy.
        "-initrd" = {
          option = "microvm.initrdPath";
          path = toString guest.config.microvm.initrdPath;
        };
      };
      checkBootFile =
        flag:
        { option, path }:
        ''
          if ! grep -qF -- ${lib.escapeShellArg " ${flag} ${lib.escapeShellArg path} "} "$out/bin/microvm-run"; then
            printf 'igloo: the runner hands QEMU no %s %s; mkRunner no longer computes %s the way microvm.nix does.\n' \
              ${lib.escapeShellArg flag} ${lib.escapeShellArg path} ${lib.escapeShellArg option} >&2
            exit 1
          fi
          resolved=$(realpath -m -- ${lib.escapeShellArg path})
          case $resolved in
            ${builtins.storeDir}/*) ;;
            *)
              printf 'igloo: %s resolves to %s, outside the Nix store. QEMU loads it into the guest, so it has to be a file this VM is built from.\n' \
                ${lib.escapeShellArg option} "$resolved" >&2
              exit 1
              ;;
          esac
          if [ ! -f "$resolved" ]; then
            printf 'igloo: %s resolves to %s, which is not a file this VM is built from. QEMU loads it into the guest, so it has to be one.\n' \
              ${lib.escapeShellArg option} "$resolved" >&2
            exit 1
          fi
        '';

      # Built here rather than taken from `microvm.declaredRunner`. That
      # option and `microvm.runner` are ordinary ones, so a content module
      # could set either to any package, and the host acts on what the
      # runner holds: it serves the directories its share metadata names and
      # runs its `microvm-run`. Built from the configuration the check below
      # compares, the share metadata is policy and `microvm-run` is
      # microvm.nix's own QEMU command line. Both options keep whatever
      # content set them to, and nothing reads them.
      #
      # The arguments microvm.nix's module passes, but with igloo's `pkgs`:
      # `buildRunner` takes `lib` and the kernel image's file name from it,
      # and the guest's carries whatever overlays content added.
      #
      # The package set and QEMU are igloo's too, rather than the merged
      # values `pins` compared. The comparison reads one derivation of each
      # — QEMU's `outPath`, the package set's `writeShellScript` — and a
      # value that keeps that and changes anything else passes it, while
      # `buildRunner` uses the rest: QEMU through its `override`, and the
      # package set through every script and the `runCommandLocal` that
      # makes the runner itself.
      runner =
        (microvm.lib.buildRunner {
          inherit pkgs;
          microvmConfig = guest.config.microvm // {
            inherit hostName;
            hypervisor = "qemu";
            vmHostPackages = pkgs;
            qemu = guest.config.microvm.qemu // {
              package = pkgs.qemu_kvm;
            };
          };
          inherit (guest.config.system.build) toplevel;
        }).overrideAttrs
          (old: {
            buildCommand = old.buildCommand + lib.concatStrings (lib.mapAttrsToList checkBootFile bootFiles);
          });

      # The priority of `pins` keeps a content module from overriding policy
      # by ordinary means, but priority is not a guarantee: a module
      # reaching for `mkOverride 9` would win the merge. So the
      # configuration that came out is compared against `pins`, and a
      # mismatch fails the build instead of booting a VM whose policy is not
      # the one that was set.
      shareFields = map (share: {
        inherit (share)
          mountPoint
          proto
          socket
          source
          tag
          ;
      });
      overridden = lib.attrNames (
        lib.filterAttrs (
          name: pin:
          !((pin.same or (held: held == pin.value)) (
            lib.getAttrFromPath (lib.splitString "." name) guest.config
          ))
        ) pins
      );
    in
    {
      inherit overridden runner;
    };
in
{
  mkRunner =
    args:
    let
      evaluated = evaluate args;
    in
    if evaluated.overridden == [ ] then
      evaluated.runner
    else
      throw ''
        igloo: a content module overrode policy that mkRunner owns: ${lib.concatStringsSep ", " evaluated.overridden}.
        Policy is set by mkRunner's arguments, from outside the workspace. A content module cannot set it.
      '';

  # The pins a set of `mkRunner`'s arguments leaves unheld, by name: the
  # list `mkRunner`'s error gives, which `builtins.tryEval` cannot read.
  # The flake's checks hold each refusal to the option it names with it.
  overridden = args: (evaluate args).overridden;
}
