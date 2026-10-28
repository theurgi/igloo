# igloo

igloo runs coding agents in per-project NixOS microVMs. Each project gets its own VM, configured
declaratively in layers, with its network reach and its credentials decided on the host rather than
inside the guest.

> **Alpha.** Expect rough edges, and expect the interfaces — policy keys, module options, broker
> profiles — to change between releases. Each page under [`docs/`](docs/) says plainly what it knows
> does not work yet.

## What it protects against

The agent is assumed to be hostile, or to be steered by something that is: a prompt injection, a
poisoned dependency, a script it was talked into running. It has root inside its VM. What igloo
keeps out of its reach:

- **The host's files.** The guest sees its project's `workspace/` and its own `/root`, and a Nix
  store holding only its own closure. Nothing else on the host is shared.
- **Credentials.** A brokered credential stays on the host. The guest can make the requests its
  grant allows — this provider, these repositories — and never holds the key.
- **The network.** No guest has a network card. Everything that leaves goes through a broker on the
  host, which reaches only what the project's policy allows, and never the host itself or a private
  address range, but for a model server the policy names on the host's loopback.
- **Its own boundary.** Policy is read only from files outside the workspace, and a guest module
  that tries to override it fails the build. The Nix that configures a VM is evaluated in a confined
  mode that cannot read the rest of the host, and igloo builds nothing from it that can reach the
  network: a source no binary cache has is yours to build, after reviewing it.

What it does not protect: anything the guest can already reach. The workspace and `/root` are the
agent's to read, change and — under the default `internet` network mode — send anywhere on the
public internet. A credential handed to the guest with `mode = "deliver"`, or a login an agent
stores in `/root`, is the agent's too. Files the guest writes are untrusted on the host: running
`git` on the host in a workspace the agent has written runs its hooks and its configuration as you.

The VM boundary is KVM and QEMU. QEMU runs as your user, confined to the Nix store, its own VM's
runtime directory and the two devices it drives, so a guest that escapes into it finds none of your
files, processes or sockets there. The virtio-fs daemons that serve the shares talk to the guest
too, each from virtiofsd's own sandbox, which holds its share and nothing else.

The broker holds the project's credentials and serves the guest's requests. Of the host's files it
sees the Nix store, its own sockets and credentials, and the files the host resolves names from:
none of yours, and none of the sockets the system serves under `/run`. Its network is the host's,
under Landlock: it connects over TCP only to port 443, port 53 and any granted model server's port,
and to no abstract socket. It cannot open the other kinds of socket that would slip past those
rules, such as MPTCP's, but it could still use UDP, which Landlock does not cover, or listen on a
port the kernel picks, which Landlock does not see.

The `ssh` sessions that carry the broker's tether and the published ports talk to the guest's sshd,
which the guest controls, so they are confined too: each sees the Nix store, the user database and
its project's key, the tether the broker's sockets as well, and none of your files or processes. The
tether has no IP network at all. The published ports' session shares your network to listen on its
loopback, and may bind only its own ports and connect to nothing over TCP; like the broker, it
cannot open a socket that would slip past those rules, and could still listen on a port the kernel
picks. Both sessions can still reach anything listening on vsock: other VMs' sshd, which refuses
them without that project's key, and any vsock service on the host.

[`ARCHITECTURE.md`](ARCHITECTURE.md#invariants) says how: each guarantee as an invariant, with the
code that holds it. A way to break one is a vulnerability; [`SECURITY.md`](SECURITY.md) says how to
report it.

## Requirements

NixOS on `x86_64-linux`, with flakes and home-manager. That is the only setup igloo is built and
tested for; other Linux distributions and architectures are not supported.

## Quick start

Add igloo to the system flake, enable both modules, and rebuild —
[`docs/install.md`](docs/install.md) has the details:

```nix
{
  inputs.igloo.url = "github:theurgi/igloo/v0.2.3";

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

Then check the host and start a project:

```sh
igloo doctor
igloo init ~/projects/demo
cd ~/projects/demo
igloo attach    # builds and boots the VM, then opens a shell in it
```

The first launch builds the VM, which takes minutes on a cold store. Exiting the shell leaves the VM
running; `igloo down` stops it.

## Documentation

- [Install](docs/install.md) — host prerequisites, the NixOS and home-manager modules, and
  `igloo doctor`.
- [Getting started](docs/getting-started.md) — the commands, and what a project is.
- [Configuration](docs/configuration.md) — the layers, and every policy setting.
- [Network](docs/network.md) — network modes, tunnel destinations and published ports.
- [Credentials](docs/credentials.md) — brokering, delivering, and pointing an agent at the broker.
- [Troubleshooting](docs/troubleshooting.md) — `igloo doctor`, boot records, `igloo report`, the
  drift report and `igloo fallback`.

## Contributing

Issues and pull requests are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers setting up, the
checks a change has to pass, and how to open a pull request.
