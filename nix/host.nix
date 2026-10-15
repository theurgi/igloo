# The host side of an install: the one prerequisite a user cannot grant
# themselves. The package is home-manager's to install, because it is
# wrapped with the user's layer. Everything else `doctor` checks needs no
# declaration on a systemd host — `/dev/vhost-vsock` is world-accessible
# through systemd's own udev rules, the build sandbox is on by default,
# and the rest of the binaries ride in the package's closure.
{
  config,
  lib,
  ...
}:
let
  cfg = config.programs.igloo;
in
{
  options.programs.igloo = {
    enable = lib.mkEnableOption "the host side of igloo, per-project microVMs for coding agents";

    users = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "alice" ];
      description = ''
        Users who run igloo. Each one gets lingering enabled, because
        without it the systemd user manager stops at logout and takes
        every running VM with it — silently, and hours after a launch
        that looked fine.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    users.users = lib.genAttrs cfg.users (_: {
      linger = true;
    });
  };
}
