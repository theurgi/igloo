# Getting started

This page assumes igloo is [installed](install.md) and `igloo doctor` passes.

## A first project

```sh
igloo init ~/projects/demo
cd ~/projects/demo
igloo up
igloo attach
```

`init` creates the project. `up` builds the VM and boots it. The first build takes minutes on a cold
store, and later ones reuse what is already built. `attach` opens a shell in the VM, landing in
`/workspace`. Leaving the shell leaves the VM running. From the project directory on the host:

```sh
igloo ls     # what is running, and how much memory each VM holds
igloo down   # power this project's VM off
```

The workspace is an ordinary directory on the host. To work on an existing repository, clone it into
`workspace/` before the first `up`. The VM has only the guest core's packages until a layer adds
more, so it has no agent yet: [Configuration](configuration.md) covers adding packages, and
[Credentials](credentials.md) covers giving an agent a model to call.

## What a project is

A project is a directory holding the marker `.igloo/project.json`. Every command except `init` finds
its project by walking up from the current directory, the way `git` finds a repository, so they work
from any subdirectory. A project cannot be inside another project's `workspace/` or `.igloo/home/`:
that project's guest writes there, so it could write the marker and a policy beside it. Every
command refuses one, `init` included.

```text
demo/
├── igloo.nix              the project's content layer (optional)
├── igloo-policy.nix       the project's policy layer (optional)
├── .igloo/                igloo's own state; not shared with the guest
│   ├── project.json       the marker
│   ├── .gitignore         `*`, so none of this is committed
│   ├── home/              the guest's /root
│   ├── ssh/               the key the host connects to the guest with
│   ├── runner/            the generated flake that builds this VM
│   ├── runners/current    a garbage-collector root for the VM's closure
│   ├── launched-from.json what the running VM was launched from
│   └── logs/              one directory per launch, and `latest`
└── workspace/             the guest's /workspace
```

`init` creates the marker, `.igloo/` with `home/` and its `.gitignore`, and `workspace/`. It does
not create either layer file. A project with neither is normal, and gets the guest core plus your
user layer. [Configuration](configuration.md) describes both files.

A project's identity is its canonical root path, with symlinks resolved. The guest's CID — the
address of its management channel — is derived from that path, and so is the name of each systemd
unit the VM runs as. Moving or renaming a project directory makes it a different project, so run
`igloo down` before moving one. A VM left running under the old path still shows in `igloo ls` and
stops with `igloo down --all`.

A project's _label_ is its directory's name. It is what `igloo ls` shows and what the guest's
hostname is made from, with anything other than lowercase letters, digits and `-` replaced by `-`.
Two projects can share a label.

To remove a project, `igloo down` it and delete the directory.

## What the guest sees

| Guest path   | Host source      | Notes                                          |
| ------------ | ---------------- | ---------------------------------------------- |
| `/workspace` | `workspace/`     | Read-write. Where a login shell starts.        |
| `/root`      | `.igloo/home/`   | Read-write, and kept across boots.             |
| `/nix/store` | the host's store | Read-only, and holding only this VM's closure. |

Everything else is a tmpfs, built fresh on every boot. A file written outside `/workspace` and
`/root` is gone after `igloo down`, and so is anything installed imperatively. Packages come from
the layers instead.

`/root` is where state that should outlive a boot lives: shell configuration in `~/.bash_profile`,
each agent's configuration and history, and the guest's SSH host keys. It is also written by
whatever runs in the guest, so treat its contents as untrusted on the host.

The guest has no network card. What it can reach goes through the broker on the host, as
[Network](network.md) describes.

Some things do not work inside the guest:

- **Nix builds.** The store is read-only, so `nix build`, `nix profile install` and `nix-env` fail.
  Add packages to a layer and restart the VM.
- **An agent's own self-update.** It installs a second copy into `/root`, which then shadows the one
  the layer provides and no longer changes when the layer does. Update agents through the layer.

## Commands

Every command except `init` acts on the project found from the current directory. `--cid` applies to
all of them, and is described [below](#--cid).

### `igloo init [dir]`

Create the project skeleton in `dir`, or in the current directory if `dir` is omitted. `dir` is
created if it does not exist. `init` is idempotent: an existing marker is left alone. It prints the
project's label, root and CID, and the paths of the two layer files. If the project is somewhere
other than the current directory, it prints the `cd` that reaches it.

### `igloo up`

Build the VM and start it, then wait until it answers on its management channel. A launch reads the
layers, fetches the project's credentials, builds the VM, starts its shares, boots it, and starts
the broker and the published ports if the project has any. Each step is recorded in a
[boot record](troubleshooting.md#boot-records).

A credential source that asks for a passphrase or a hardware-key touch asks on the terminal that ran
`up`, before the build.

`up` against a VM that is already running builds nothing and starts nothing beyond restarting a
broker or a published port that has stopped. If the configuration changed since the VM was launched,
it lists what changed; see [the drift report](troubleshooting.md#the-drift-report).

The VM does not belong to the `igloo` process. It runs as transient systemd user units in a slice of
its own, so closing the terminal or killing `igloo` does not touch it.

### `igloo attach`

Open a shell in the VM, running `up` first if the VM is not running. Each `attach` is a new session,
so several terminals can attach to one VM. Exiting the shell ends the session and leaves the VM
running. The exit status is the shell's.

### `igloo down [--all]`

Power the guest off and stop its units. The guest gets a power-button event and 30 seconds to shut
down cleanly, so writes it has cached against the shares are flushed. After that its units are
killed. Credential values held for the VM on the host are removed at the same time.

`down` reads no configuration, so a mistake in a layer file never makes a running VM unstoppable.

`--all` stops every VM your user manager is running, concurrently, including ones whose project
directory has since moved or been deleted.

### `igloo ls [--verbose]`

List the VMs your user manager is running, with their status, uptime, memory, broker and project
root. Status is `running`, `starting`, or `broken`. A broken VM is a half-started one: its virtio-fs
daemons are running and its QEMU is not. `igloo down` clears it. Memory is shown for every VM
because a VM nobody has attached to for days still holds its whole allocation. The broker column is
`-` for a VM without one, and otherwise says whether it is up, how often it has been restarted, and
how many of the VM's processes were killed for memory; see
[Troubleshooting](troubleshooting.md#when-the-broker-is-killed).

`--verbose` adds each VM's CID, systemd slice and runtime directory.

### `igloo fallback`

Open a sandbox on the host with the same `/workspace` and `/root`, for when the VM will not boot.
See [Troubleshooting](troubleshooting.md#igloo-fallback).

### `igloo doctor`

Check the host's prerequisites. See [Install](install.md#check-the-host).

### `igloo report [record]`

Print what a bug report needs, as markdown: the version, `doctor`'s output and the latest launch's
boot record, or the one named by its id or directory, with what identifies you and your machine
replaced. See [Troubleshooting](troubleshooting.md#reporting-a-bug-with-igloo-report).

### `--cid`

```sh
igloo up --cid 70000
```

Override the guest's CID, which is otherwise derived from the project's path. Use it only when two
projects' derived CIDs collide, which shows as the second VM's QEMU exiting during boot. The
override is not remembered, so pass the same `--cid` to every command for that project: `up`,
`attach`, `down` and `fallback`. Pick a value from 65536 to 4294967294. `ls` cannot read a smaller
one back, and shows such a VM with no CID. `init`, `ls`, `doctor`, `report` and `down --all` ignore
`--cid`.

### Built-in flags

The CLI library adds flags to every command: `--help` (`-h`), `--version` (`-v`),
`--completions <bash|zsh|fish|sh>` to print a shell completion script, `--wizard` to build a command
interactively, and `--log-level`.

## Known limits

- The only way into a VM is `igloo attach`. Nothing sets up SSH configuration for other tools to
  connect with.
- A changed layer applies only when the VM next boots. `up` says when that is pending, but does not
  apply it.
- A CID collision between two projects is possible, if unlikely, and is resolved by hand with
  `--cid`.
