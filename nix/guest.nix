# Guest configuration shared by every VM. All of it is overridable by a
# caller's `contentModules`; see `mkRunner` for what is not.
{ lib, pkgs, ... }:
{
  # Working loader for non-Nix ELF binaries. Language package managers
  # routinely download prebuilt executables (rustup toolchains, uv's
  # CPython, elan, anything installed with `npm i -g`), and without this
  # they fail with "No such file or directory" on a binary that exists.
  programs.nix-ld.enable = true;

  # Several agent CLIs are unfree; a caller installing one shouldn't
  # have to rediscover this.
  nixpkgs.config.allowUnfree = true;

  # Building a NixOS system from a flake otherwise pins the whole
  # nixpkgs tree into the closure, so that `nix run nixpkgs#…` resolves
  # offline. Nothing here uses that, and it dominates the closure's file
  # count. `setNixPath` must go with it — NixOS asserts
  # `setNixPath -> setFlakeRegistry`.
  nixpkgs.flake.setFlakeRegistry = false;
  nixpkgs.flake.setNixPath = false;

  environment.systemPackages = import ./core-packages.nix pkgs ++ [
    # SSH forwards the host's TERM, which for these emulators is not in
    # the base terminfo db; ncurses tools then fail with "unknown
    # terminal type". `enableAllTerminfo` also covers them, but pulls in
    # termite→vte, which is uncached and fails to build.
    pkgs.ghostty.terminfo
    pkgs.kitty.terminfo
  ];

  services.openssh = {
    # The management channel is AF_VSOCK (see `mkRunner`), and nothing
    # forwards a host port to guest :22. Binding TCP to loopback anyway
    # keeps "not listening" true independently of "not routable".
    listenAddresses = [
      {
        addr = "127.0.0.1";
        port = 22;
      }
    ];
    settings = {
      PasswordAuthentication = false;
      PermitRootLogin = "yes";
    };
    # Keep host keys on /root, which callers back with a persistent
    # share. The default location is the guest's tmpfs rootfs, so
    # sshd-keygen regenerates a 4096-bit RSA key on every boot, which is
    # slow, and the guest's identity changes each time. Falls back to
    # ephemeral when /root is not shared, which is right for a
    # throwaway VM.
    hostKeys = [
      {
        path = "/root/.igloo/ssh-host-keys/ssh_host_ed25519_key";
        type = "ed25519";
      }
      {
        bits = 4096;
        path = "/root/.igloo/ssh-host-keys/ssh_host_rsa_key";
        type = "rsa";
      }
    ];
  };

  # This adds an `Include` of a file in the Nix store to
  # /etc/ssh/ssh_config, and OpenSSH refuses to read a config file owned
  # by neither root nor the caller. The store is served over virtiofs
  # with host uid 0 unmapped, so every file in it is owned by nobody and
  # every `ssh` invocation in the guest dies with "Bad owner or
  # permissions" before it connects — `git` over SSH remotes included.
  #
  # Nothing is lost: the include configures reaching *other* machines
  # over vsock/AF_UNIX, and the guest is only ever the far end of such a
  # connection, which is the server side.
  programs.ssh.systemd-ssh-proxy.enable = false;

  # Discipline the clock against the host's via the KVM PTP device
  # rather than NTP alone, so a host suspend cannot leave the guest
  # minutes behind (which surfaces as TLS "certificate not yet valid").
  # The refclock works with no network at all. `/dev/ptp_kvm` is
  # systemd's stable symlink for the device; `makestep 1.0 -1` steps
  # instead of slewing at any point in the process's life, since
  # slewing a post-suspend gap would take hours.
  #
  # RTC trimming is off because the emulated RTC has no drift of its own
  # to correct, and leaving it on restricts what `extraConfig` may hold.
  # The chrony module disables timesyncd itself.
  boot.kernelModules = [ "ptp_kvm" ];
  services.chrony = {
    enable = true;
    enableRTCTrimming = false;
    extraConfig = ''
      refclock PHC /dev/ptp_kvm poll 2 dpoll -2 stratum 2 prefer
      makestep 1.0 -1
    '';
  };

  environment.loginShellInit = ''
    if [ -d /workspace ]; then cd /workspace; fi
  '';

  # SSH is the only login surface. Boot logs still reach ttyS0 for
  # host-side capture; this only stops a login prompt respawning on an
  # unattended line.
  systemd.services."serial-getty@ttyS0".enable = lib.mkForce false;

  # Nothing here should delay boot waiting for a network: a guest has no
  # network card.
  networking.networkmanager.enable = lib.mkForce false;
  systemd.services.systemd-networkd-wait-online.enable = lib.mkForce false;

  # Guest root can flush any in-guest rule, so this filter is not a
  # boundary — egress policy has to be enforced host-side. It does sit
  # on the boot critical path, serialising the chain sshd waits on.
  networking.firewall.enable = false;

  # The rootfs is a tmpfs rebuilt every boot, so almost nothing consults
  # this. Pinned to a known-good release rather than tracked.
  system.stateVersion = "24.11";
}
