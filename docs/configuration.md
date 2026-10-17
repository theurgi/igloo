# Configuration

A VM is configured in three layers, each building on the one before:

1. **The guest core**, igloo's own: the floor every VM starts from.
2. **The user layer**, from `programs.igloo` in your home-manager configuration. It applies to every
   VM you run.
3. **The project layer**: two optional files in the project's root directory, beside `workspace/`
   and not inside it.

Each layer has two halves, and the split between them is the core of igloo's design:

- **Content** says what is _in_ the VM: packages, services, files. It is a NixOS module, it reaches
  the guest, and the layers compose by ordinary module semantics, so a project's module overrides
  yours and yours overrides the core.
- **Policy** says what the VM is _allowed to do_: how much memory and CPU it gets, what it can
  reach, which credentials it can use. It is an attribute set the host reads. It never reaches the
  guest, and igloo composes it under rules of its own, set per key.

| Layer   | Content                                        | Policy                           |
| ------- | ---------------------------------------------- | -------------------------------- |
| Core    | the [guest core](#the-guest-core)              | the [defaults](#policy-settings) |
| User    | `programs.igloo.guest.modules` and `.packages` | `programs.igloo.policy`          |
| Project | `igloo.nix`                                    | `igloo-policy.nix`               |

The options under `programs.igloo` are described in [Install](install.md#the-home-manager-module).

## Content

### The project's `igloo.nix`

A NixOS module, like any other:

```nix
{ pkgs, ... }:
{
  environment.systemPackages = with pkgs; [
    nodejs_22
    pnpm
  ];
  imports = [ ./workspace/nix/guest.nix ];
}
```

`pkgs` is igloo's own nixpkgs, which tracks `nixos-unstable` at the revision igloo's `flake.lock`
pins, with unfree packages allowed. A package from anywhere else belongs in
`programs.igloo.guest.packages`, which can take any package your home-manager configuration can
reach.

The module is evaluated on the host under confinement, because a project's configuration may be one
somebody else wrote. The evaluation can read the module itself, the Nix store and the project's
workspace, and nothing else on the host. It can fetch only the inputs igloo itself is locked to. In
practice:

- Importing from the workspace works, as in the example, so a repository can carry its own guest
  configuration.
- Importing a file that sits beside `igloo.nix`, outside the workspace, fails.
- `builtins.fetchTarball`, `builtins.getFlake` and the like fail for anything igloo does not already
  pin.
- Import from derivation fails, naming the option `allow-import-from-derivation`.

A file at `workspace/igloo.nix` is not read: igloo prints a note saying so and goes on. Import it
from the project's `igloo.nix` if you mean to use it. Remember that the guest can edit anything in
the workspace, so a VM built from such a file is configured by whatever ran in the last one. That is
also why igloo won't fetch a new source such a file names, as the next section explains.

### What igloo builds

Building a VM runs on the host, and some derivations reach the network when built. A fixed-output
derivation, which is what `fetchurl`, `fetchFromGitHub` and the other fetchers produce, downloads
its output, and Nix checks only the hash afterwards. Content can come from the workspace, so
building one could send what the evaluation can read anywhere, whatever the project's `network`
says.

So igloo builds nothing that can reach the network. Before building, `igloo up` asks Nix what the
build would run:

- A fixed output that is already in your store, or that a binary cache has, runs no builder, and is
  used as usual. That covers nixpkgs packages, and normally the sources of a nixpkgs package you
  rebuild with different options.
- A fixed output nothing has cached, such as a new `fetchurl` or an overridden `src`, stops `up`
  before anything is built. So does an impure derivation, or one with `__noChroot`. The message
  names each derivation. Review it with `nix derivation show <drv>`, build it yourself with the
  command the message gives, and run `igloo up` again.
- A download from a binary cache that fails is not retried by building, whatever your `nix.conf`
  says about `fallback`. Run `igloo up` again.

This applies to every layer, because igloo can't tell which layer a derivation came from. Your own
packages are normally built already by home-manager.

### What content cannot set

Content cannot change policy. The settings policy decides are applied at a priority no module can
reach by ordinary means, and the build compares the result against what policy asked for. A module
that overrides one fails the build:

```text
igloo: a content module overrode policy that mkRunner owns: microvm.mem.
Policy is set by mkRunner's arguments, from outside the workspace. A content module cannot set it.
```

The options owned this way are the VM's memory, CPUs, shares, whether the store comes from a disk
image instead of its share, network interfaces, forwarded ports, devices, volumes, credential files,
hypervisor and its arguments, the virtio-fs daemons' arguments, the control socket, vsock CID and
SSH setting, the host-side binaries and scripts that run the VM, the guest's hostname, root's
authorised SSH keys, and the guest's NTP servers.

### The guest core

Every VM starts from `nixosModules.guest`. Any of it can be overridden by a content module.

- **Packages:** `bash`, `cacert`, `coreutils`, `diffutils`, `findutils`, `gawk`, `gnugrep`,
  `gnused`, `gnutar`, `gzip`, `less`, `ncurses`, `openssh`, `which` and `xz`, plus terminfo for
  Ghostty and kitty. `git` is installed only when the VM has a
  [`github` grant](credentials.md#github).
- **`programs.nix-ld`** is enabled, so prebuilt binaries a language toolchain downloads — rustup's,
  uv's Python, an `npm i -g` package — can run.
- **Unfree packages** are allowed.
- **SSH** is reachable only through the vsock management channel, as root, with a key.
- **The clock** is kept in step with the host's through the KVM PTP device, so a host suspend does
  not leave the guest behind.
- **A login shell** starts in `/workspace`.

## Policy

### Where policy comes from

The user layer's policy is `programs.igloo.policy`. A project's is `igloo-policy.nix` in its root
directory: a plain attribute set, not a function and not a NixOS module.

```nix
{
  network = "restricted";
  tunnel = [
    "registry.npmjs.org"
  ];
  ports = [ 5173 ];
}
```

The file is evaluated under the same confinement as content, more tightly still: it can read itself
and the Nix store, and nothing else. There is no `lib`, no `config` and no `pkgs` in scope, so write
absolute paths out in full.

**Policy never comes from the workspace.** A file at `workspace/igloo-policy.nix` is refused, and
the launch stops:

```text
igloo: /…/demo/workspace/igloo-policy.nix is in the workspace, which the guest can write, so policy may not come from there. Move it to /…/demo/igloo-policy.nix.
```

The guest can write the workspace, so policy read from there would let the VM widen its own
boundary. Ignoring the file instead would leave you believing a setting applied that never did.

Every key is checked against the layer it is allowed in. A key in the wrong layer, an unknown key,
or a value of the wrong shape stops the launch with a message that names the file, the key, and
where it belongs. A message about the user layer names `programs.igloo.policy` rather than the
generated file.

### Policy settings

| Key              | Allowed in       | Default             | What it decides                                          |
| ---------------- | ---------------- | ------------------- | -------------------------------------------------------- |
| `mem`            | user             | `4096`              | Guest memory, in MiB.                                    |
| `vcpu`           | user             | `4`                 | Guest CPUs.                                              |
| `brokerMem`      | user             | unset: no bound     | The most memory the VM's broker may use, in MiB.         |
| `network`        | user and project | `"internet"`        | What the VM can reach: `none`, `restricted`, `internet`. |
| `networkCeiling` | user             | unset: no ceiling   | The most any project may ask for.                        |
| `tunnel`         | project          | `[ ]`               | Destinations under `restricted`.                         |
| `tunnelCeiling`  | user             | unset: none allowed | The destinations a project may list in `tunnel`.         |
| `ports`          | project          | `[ ]`               | Guest ports published on the host's loopback.            |
| `secrets`        | user and project | none                | Credentials, brokered or delivered.                      |
| `modelServers`   | user and project | none                | Model servers on this machine the broker may call.       |

**`mem`** and **`vcpu`** are positive whole numbers. They are the user layer's alone, because how
much a VM gets is a property of the machine it runs on, not of the repository. `mem = 2048` is
refused: QEMU hangs at exactly 2 GiB, with no output and no exit. Use 2047 or 4096.

**`brokerMem`** bounds the broker, the host process that holds a VM's brokered credentials and
carries its requests, as a positive whole number of MiB. A bounded broker uses no swap, so the bound
is all the memory it has. It is the user layer's alone, like `mem`. Unset, the broker has no bound,
as an agent running on the host would have none. Its memory grows with how many requests and tunnels
the guest has open at once, not with how much they carry, and a bound set too low fails the requests
that reach it. Either way, if memory runs out the kernel kills the broker before anything else, and
its unit starts it again. See [Troubleshooting](troubleshooting.md#when-the-broker-is-killed).

**`network`** set in the user layer is the default for every project. Set in a project, it is that
project's request, which may narrow `networkCeiling` and not widen it. The default is `"internet"`
because a coding agent that cannot reach its API is the wrong place to start, and `"none"` is one
line away. **`networkCeiling`** bounds both: a user-layer `network` above it is an error, as is a
project asking for more. A ceiling below `"internet"` with no `network` beside it is also the
default: `networkCeiling = "restricted"` on its own gives every project `restricted`, and a project
may still ask for `none`. [Network](network.md#network-modes) describes what each mode reaches.

**`tunnel`** lists the hostnames a project reaches under `restricted`, and every one has to be in
the user layer's **`tunnelCeiling`**. An unset ceiling allows nothing, so a project can list no
destination until you have allowed it. [Network](network.md#tunnel-destinations) has the rules a
destination follows.

**`ports`** publishes guest ports on the host's loopback, as a number for the same port on both
sides or as `{ guest = 5173; host = 5174; }`. It is the project's alone.
[Network](network.md#published-ports) has the details.

**`secrets`** declares credentials. A project's own go to that project. The user layer's go to the
projects each one lists. [Credentials](credentials.md) covers both.

**`modelServers`** names model servers listening on this machine's loopback, such as llama-server or
Ollama, that the VM may call through the broker. Like `secrets`, a project's own go to that project,
and the user layer's to the projects each one lists.
[Model servers on this machine](credentials.md#model-servers-on-this-machine) covers them.

### A user layer's policy

```nix
{ config, ... }:
{
  programs.igloo.policy = {
    mem = 8192;
    vcpu = 6;
    network = "restricted";
    networkCeiling = "internet";
    tunnelCeiling = [
      "registry.npmjs.org"
      "pypi.org"
      "files.pythonhosted.org"
    ];
    secrets.openrouter = {
      source.command = [
        "pass"
        "show"
        "openrouter/api-key"
      ];
      mode = "broker";
      profile = "openrouter";
      projects = [ "${config.home.homeDirectory}/projects/demo" ];
    };
  };
}
```

## Applying a change

The layers are read every time a VM boots, and only then. A VM that is already running keeps the
configuration it booted with: run `igloo down` and then `igloo up` to apply a change. `up` against a
running VM lists what has changed since it was launched; see
[the drift report](troubleshooting.md#the-drift-report).

## Known limits

- A project's `igloo.nix` can import from the workspace but not from beside itself.
- Content is evaluated without network access, so a package from another flake has to come through
  `programs.igloo.guest.packages`.
- A source no binary cache has must be built by you before `igloo up` will use it. Nothing roots it
  afterwards, so garbage collection can remove it, and the next build that needs it stops again.
- `programs.igloo.policy` is freeform, so home-manager accepts a misspelt key and igloo refuses it
  at the next launch.
