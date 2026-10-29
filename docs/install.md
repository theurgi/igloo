# Install

igloo is installed in two halves, because they are owned by different configurations. The NixOS
module grants the one thing only root can grant. The home-manager module installs the `igloo`
command, wrapped with your _user layer_: the configuration every VM you run starts from.

## Requirements

- NixOS on `x86_64-linux`, with flakes enabled through `nix.settings`, in NixOS or home-manager.
  igloo builds for no other system, and Nix reads no `nix.conf` outside the Nix store while it
  evaluates a project's configuration.
- systemd 257 or newer, which NixOS has from 25.05. Every VM runs as systemd user units with
  properties systemd added in 257, and an older `systemd-run` refuses them before a VM starts.
- home-manager, either as a NixOS module or standalone.
- A CPU with hardware virtualisation, enabled in the firmware. Every VM runs under KVM.
- Linux 6.12 or newer, with Landlock enabled: `landlock` appears in `/sys/kernel/security/lsm`. Nix
  evaluates a project's configuration under it, kept from your files, and the broker runs under it,
  kept from your loopback services and abstract sockets. No VM starts without it.

On NixOS the rest holds by default: `/dev/kvm` and `/dev/vhost-vsock` are usable through systemd's
udev rules, the Nix build sandbox is on, and the binaries igloo runs come with its package. Two
settings can break it:

- **`nix.settings.sandbox`** must be `true`, the default. A project's configuration is Nix that
  builds on your machine, and the sandbox is what keeps that build off your files and network.
  `relaxed` is refused too.
- **`security.allowUserNamespaces`** must stay `true`, the default. A hardened configuration may
  turn it off, and igloo needs unprivileged user namespaces to restrict each VM's view of the Nix
  store.

`igloo doctor` checks all of this; see [below](#check-the-host).

## Add the flake

In the system flake, add igloo as an input and import both modules. This example uses home-manager
as a NixOS module:

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    igloo.url = "github:theurgi/igloo/v0.2.5";
  };

  outputs =
    { igloo, home-manager, nixpkgs, ... }:
    {
      nixosConfigurations.workstation = nixpkgs.lib.nixosSystem {
        modules = [
          ./configuration.nix
          igloo.nixosModules.default
          {
            programs.igloo = {
              enable = true;
              users = [ "alice" ];
            };
          }
          home-manager.nixosModules.home-manager
          {
            home-manager.users.alice = {
              imports = [ igloo.homeModules.default ];
              programs.igloo.enable = true;
            };
          }
        ];
      };
    };
}
```

With standalone home-manager, the NixOS half stays in the system configuration and the home-manager
half goes in the home configuration:

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    igloo.url = "github:theurgi/igloo/v0.2.5";
  };

  outputs =
    { igloo, home-manager, nixpkgs, ... }:
    {
      homeConfigurations.alice = home-manager.lib.homeManagerConfiguration {
        pkgs = nixpkgs.legacyPackages.x86_64-linux;
        modules = [
          ./home.nix
          igloo.homeModules.default
          { programs.igloo.enable = true; }
        ];
      };
    };
}
```

Rebuild, then run `igloo doctor`.

## The NixOS module

`nixosModules.default` is the host side of an install.

| Option                  | Type            | Default | Description                                           |
| ----------------------- | --------------- | ------- | ----------------------------------------------------- |
| `programs.igloo.enable` | boolean         | `false` | Enable the host side of igloo.                        |
| `programs.igloo.users`  | list of strings | `[ ]`   | Users who run igloo. Each one gets lingering enabled. |

**Why lingering matters.** A VM is a set of systemd user units, owned by your user manager rather
than by the `igloo` process that started it. Without lingering, the user manager stops when your
last session ends and takes every running VM with it — silently, and possibly hours after a launch
that looked fine. `programs.igloo.users` sets `users.users.<name>.linger = true` for each user
listed.

The NixOS module installs no package. The `igloo` command comes from home-manager, because it is
wrapped with your user layer.

## The home-manager module

`homeModules.default` installs `igloo` and declares your user layer.

| Option                          | Type             | Default                            |
| ------------------------------- | ---------------- | ---------------------------------- |
| `programs.igloo.enable`         | boolean          | `false`                            |
| `programs.igloo.package`        | package          | `igloo.packages.${system}.default` |
| `programs.igloo.policy`         | attribute set    | `{ }`                              |
| `programs.igloo.guest.modules`  | list of paths    | `[ ]`                              |
| `programs.igloo.guest.packages` | list of packages | `[ ]`                              |

- **`enable`** installs `igloo`, wrapped with this user's layer.
- **`package`** is the igloo package to wrap. Changing a setting below rebuilds only the wrapper,
  not the package.
- **`policy`** is the user layer's policy: memory, CPUs, network, tunnel destinations and
  credentials. It is freeform here, and igloo checks it when it reads it, naming the setting and the
  layer it belongs in. Every key is described in [Configuration](configuration.md#policy-settings).
  The value is serialised to JSON, so write paths as strings: a path literal such as `./token` is
  copied into the world-readable Nix store.
- **`guest.modules`** are NixOS modules for every VM you run, as paths. They are evaluated later,
  when a VM is built, against igloo's own nixpkgs rather than home-manager's. Each must be inside
  the Nix store — in a flake-based configuration every path is — and home-manager refuses the
  configuration if one is not. A module's relative imports keep working.
- **`guest.packages`** are packages for every VM you run. They are built with home-manager's `pkgs`
  and passed to the guest as store paths, so anything your configuration can reach works, including
  another flake's packages. A package from a different nixpkgs than igloo's can put a second copy of
  its dependencies in the guest.

A user layer that installs a few tools and an agent, and gives each VM more memory and CPUs:

```nix
{ pkgs, ... }:
{
  programs.igloo = {
    enable = true;
    guest.packages = with pkgs; [
      git
      ripgrep
      claude-code
    ];
    guest.modules = [ ./igloo/guest.nix ];
    policy = {
      mem = 8192;
      vcpu = 6;
    };
  };
}
```

`claude-code` is unfree, so home-manager's nixpkgs needs `allowUnfree` for that example to build.
Inside the guest, unfree packages are already allowed.

The layer is a directory in the Nix store holding `igloo.nix` and `igloo-policy.nix`, and the
wrapper points `igloo` at it. Nothing is written under `~/.config`, and a home-manager rollback
rolls the command and its configuration back together. A changed layer reaches a VM the next time it
boots; see [the drift report](troubleshooting.md#the-drift-report).

## `overlays.default`

The overlay adds `igloo` to a package set: the package exactly as this flake built it, not rebuilt
against your nixpkgs. The modules do not need it. It is for installing igloo some other way, such as
`environment.systemPackages = [ pkgs.igloo ];`. An `igloo` installed like that has no user layer, so
its VMs get the guest core and their project's own layer only.

## Other flake outputs

- `packages.x86_64-linux.default`, also named `igloo`: the CLI.
  `nix run github:theurgi/igloo/v0.2.5 -- doctor` checks a host before anything is installed.
- `nixosModules.guest`: the guest core, the NixOS module every VM starts from. It is described in
  [Configuration](configuration.md#the-guest-core).
- `lib.mkRunner`, and the `broker`, `landlock`, `storeView` and `testVm` packages: the pieces the
  CLI builds VMs from. They are not a stable interface.

## Check the host

```sh
igloo doctor
```

`doctor` runs every check and reports each one, with a remedy for each failure. It exits non-zero if
any check failed, so a script can use it as a gate.

| Check                  | What it checks                                                              |
| ---------------------- | --------------------------------------------------------------------------- |
| `igloo flake`          | The igloo flake that VMs are built from has a `flake.nix`.                  |
| `user layer`           | Which user layer this `igloo` carries, and that it exists.                  |
| `nix`                  | `nix` starts.                                                               |
| `nix build sandbox`    | `sandbox = true` in Nix's configuration.                                    |
| `ssh`                  | `ssh` starts.                                                               |
| `ssh vsock proxy`      | systemd's `systemd-ssh-proxy`, which `ssh` reaches a guest through, exists. |
| `systemd-run`          | `systemd-run` is systemd 257 or newer.                                      |
| `systemd user manager` | Your systemd user manager answers, and runs systemd 257 or newer.           |
| `user manager lingers` | Lingering is enabled for you.                                               |
| `/dev/kvm`             | You can open `/dev/kvm` for reading and writing.                            |
| `/dev/vhost-vsock`     | You can open `/dev/vhost-vsock`, the management channel to every guest.     |
| `virtiofsd`            | The virtio-fs daemon that serves the guest's shares starts.                 |
| `store view`           | The helper that restricts a guest's Nix store to its own closure works.     |
| `landlock`             | The helper evaluation and the broker run under can restrict itself.         |
| `bubblewrap`           | `bwrap` can open a sandbox. Only `igloo fallback` needs it.                 |
| `XDG_RUNTIME_DIR`      | It is set and writable. Each running VM keeps its sockets there.            |

`doctor` is not run before every launch, because most checks cost a process and the facts change
about once per machine. When a launch fails in a way a prerequisite explains, its message says to
run `doctor`.

## Updating

`igloo.url` names a release by its tag, so `nix flake update` leaves igloo where it is. To move to
another release, change the tag in `igloo.url`, then:

```sh
nix flake update igloo
```

Then rebuild. A running VM keeps running on the version it started with. `igloo up` in its project
reports which of igloo's `flake.nix`, `flake.lock` and files under `nix/` changed, and `igloo down`
then `igloo up` moves it to the new version.

## Running from a checkout

For working on igloo itself: `nix develop` in a checkout, then `bin/igloo` runs the checkout's
source rather than the installed package. It has no user layer unless `IGLOO_USER_LAYER` names a
directory holding `igloo.nix` and `igloo-policy.nix`. The `user layer` line of `igloo doctor`, run
with the installed `igloo`, prints the one home-manager built.
