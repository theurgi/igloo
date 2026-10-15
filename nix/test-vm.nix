# The arguments of a runner that exists to be built rather than booted:
# the reference a host run checks the closure against, and the VM each of
# the flake's checks adds one content module to. No workspace, no /root,
# no secrets, no NIC — its only share is the read-only store, so it names
# no host path and evaluates purely.
#
# No key is authorized, so nothing can log in to it. A VM to boot is a
# scratch project under `igloo up`, which goes through the real launch
# path rather than a second one kept beside it.
{
  # One content module, so the reference build goes through the content
  # plane the way a project's does.
  contentModules = [
    (
      { pkgs, ... }:
      {
        environment.systemPackages = [ pkgs.hello ];
      }
    )
  ];
  hostName = "igloo-test";
  mem = 4096;
  sshAuthorizedKey = "# igloo: testVm is built, not booted";
  vcpu = 2;
  vsockCid = 42;
}
