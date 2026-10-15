# Troubleshooting

## Start with `igloo doctor`

```sh
igloo doctor
```

It checks every host prerequisite in one pass and gives a remedy for each failure. Most launch
failures that a prerequisite explains end by suggesting it. [Install](install.md#check-the-host)
lists the checks.

## Boot records

Every launch writes a directory under the project's `.igloo/logs/`, and `.igloo/logs/latest` points
at the newest. The last 20 are kept. A failed launch prints where its record is:

```text
igloo: guest did not answer on vsock within 90s; try `igloo doctor`
igloo: the boot record is /…/demo/.igloo/logs/2026-10-06T09-14-03-512Z-3f9a
```

An `up` or `attach` that found the VM already running, with nothing to report and nothing to
restart, removes its record again, so `latest` stays on the launch worth reading.

| File                  | What it holds                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `boot.json`           | The summary: the outcome, the start and finish, each step with its duration and result, and the whole failure.                                                                 |
| `boot.jsonl`          | The same story as it happened, one JSON line per event: each note printed, each step, the runner that was built. A launch that hung or was killed has this and no `boot.json`. |
| `nix.log`             | nix's errors and warnings from evaluating the layers and building the runner, as the terminal showed them. Nix 2.30 or later.                                                  |
| `serial.log`          | The guest's console. The only account of a boot that fails before the guest answers.                                                                                           |
| `virtiofsd-<tag>.log` | Each share's virtio-fs daemon: `ro-store`, `workspace` and `home`.                                                                                                             |
| `broker.log`          | The broker's log, one line per request. See [Credentials](credentials.md#pointing-an-agent-at-the-broker).                                                                     |
| `tether.log`          | The SSH connection that carries the guest's ports 3128 and 3129 to the broker.                                                                                                 |
| `ports.log`           | The SSH forward that publishes the project's `ports`.                                                                                                                          |

The steps of a launch, as `boot.json` names them: `brokered-credentials`, `delivered-credentials`,
`evaluate`, `plan`, `build`, `closure`, `virtiofsd`, `guest`, `broker`, `tether` and `ports`. A step
the VM does not need is not run.

## Reporting a bug with `igloo report`

```sh
igloo report
```

It prints what a bug report needs as markdown to paste into one: igloo's version, with the commit it
was built from when its flake recorded one; `igloo doctor`'s output; and the latest launch's boot
record. Run it in the project where the launch went wrong. For an earlier launch, name its boot id,
or its directory as a failed launch prints it:

```sh
igloo report 2026-10-06T09-14-03-512Z-3f9a
igloo report /…/demo/.igloo/logs/2026-10-06T09-14-03-512Z-3f9a
```

It reads no layer and evaluates nothing, so it works for a project whose `igloo.nix` is the problem.
Outside a project it gives the version and `doctor` alone. It prints to stdout and nothing else: it
sends nothing and writes no file. `boot.json` is shown whole, and each other file as its last lines,
with a line saying how many it left out, so that the report fits in one issue body.

Each value below is replaced by a placeholder, the same one wherever the value appears, so the logs
still read. The report starts with how many of each kind it replaced, never what they were.

- Your home directory, as `~`, your user name and this machine's host name.
- The project's directory and its name, which is also the guest's host name, and the guest's CID, a
  hash of the directory. Every unit's name is made of the name and the CID.
- Credential names, as `boot.jsonl` and `broker.log` list them, and in `broker.log` repositories,
  model servers' names, the hosts requests were for, tunnel destinations and the addresses they
  resolved to. Each of these fields is replaced by what it holds rather than by its value, unless
  that is a name igloo itself uses, and each value wherever else it appears too.
- Email addresses, and IP addresses other than loopback.
- In each URL, everything but the scheme, and the host when it is loopback or one igloo names:
  `cache.nixos.org`, `github.com`, `api.anthropic.com` and `openrouter.ai`.

A value shorter than three characters, or an everyday word such as `dev`, `root` or `nixos`, is left
as it is, so that a user called `dev` does not take `/dev` with them.

Read the report before you post it. The text igloo doesn't write itself, such as Nix's errors, in
`nix.log` and `boot.json`, and the guest's console in `serial.log`, is searched only for those
values and shapes. Anything else left in it is what your own guest, or a program igloo ran, printed.

## The drift report

`igloo up` against a running VM builds nothing and starts nothing new, so a changed configuration
waits for the next boot. When something the VM was launched from has changed since, `up` says so:

```text
igloo: demo is already running
igloo: it was launched before these changed:

  /…/demo/igloo.nix
  the broker grants and memory, tunnel destinations and published ports

`igloo down` then `igloo up` to apply them.
```

What it compares:

- **The generated flake**, `.igloo/runner/flake.nix`, which carries every policy setting that
  reaches the guest and names the content layers.
- **Each content layer**: the project's `igloo.nix`, and the user layer's, named
  `programs.igloo.guest`.
- **igloo's own `flake.nix`, `flake.lock` and every file under `nix/`**, which change when igloo is
  updated.
- **The broker's executable**, for a VM that has a broker, and the helper that restricts it and the
  published ports, for a VM that has either.
- **The broker grants and memory, tunnel destinations and published ports**, which are host-side
  only.

What it cannot see: a file a content layer imports for itself, such as a module in the workspace,
and a credential's value.

## When the broker is killed

The broker streams what the guest's requests and tunnels carry rather than holding it, so its memory
grows with how many the guest has open at once. Nothing bounds it unless you set
[`brokerMem`](configuration.md#policy-settings). If the host runs out of memory, the kernel kills
the broker before anything else, because its unit marks it as the first process to go. It is killed
the same way when it passes its `brokerMem` bound.

Its unit starts it again two seconds later. The requests it had in flight fail, and agents retry
them. `igloo ls` shows a restarted broker in the `BROKER` column:

```text
NAME  STATUS   UPTIME  MEMORY  BROKER                                 PROJECT
demo  running  2h 5m   4.3G    up, restarted 1×, 1 killed for memory  /…/demo
```

If it is killed again after its unit has started it five times within a minute, the unit stops
starting it. The guest then has no brokered credential and no tunnel, and `igloo ls` shows the
broker as `stopped` and says so. Run `igloo up` in the project to start it again. The VM keeps
running.

## `igloo fallback`

```sh
igloo fallback
```

A shell on the host, in a bubblewrap sandbox laid out like the guest: the project's workspace at
`/workspace`, where it starts, and the guest's home at `/root`. It is for when the VM will not boot.
It needs only the project's marker and bubblewrap: no build, no configuration, no key and no VM,
since any of those can be why the VM will not start.

**The isolation is much weaker than a VM's.** The sandbox shares the host's kernel and the host's
network, with no network policy applied and no broker, so brokered credentials do not work there. It
has the whole Nix store and `/etc` read-only, and runs as you. It does keep out the environment of
the shell that started it: everything is cleared except `TERM`, `COLORTERM`, `LANG`, `LC_ALL`,
`NIX_SSL_CERT_FILE`, `SSL_CERT_FILE`, `TERMINFO` and `TZ`, so a credential exported there does not
follow you in.

- **`PATH`** starts with the guest's packages, as of the last VM that was built for the project,
  then the host's `PATH`, then `/root/.bun/bin` and `/root/.local/bin`. With no VM built yet, only
  the host's tools are there.
- **Startup files in `/root` are not read.** They were written by whatever ran in the guest, and
  this shell runs on the host as you. `. ~/.bash_profile` reads them anyway, if you decide to.
- **Leaving the shell** ends the session, and anything it left running is stopped with it, because
  the sandbox runs in a systemd scope of its own. If systemd cannot provide one, a note says that
  leftover processes will keep running.
- **If the VM is running** too, a note says so: both are writing the same `/root`.

The session is recorded under `.igloo/logs/` like a launch, with the sandbox's full bubblewrap
command line and the shell's exit status.

## Messages and what to do

| Message                                                 | What to do                                                                                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `guest did not answer on vsock within 90s`              | Run `igloo doctor`: `ssh vsock proxy` and `/dev/vhost-vsock` are the usual causes. Then read `serial.log`.                          |
| `QEMU exited during boot`                               | Read `serial.log`. If another VM is running with the same CID, give one of them `--cid`.                                            |
| `virtiofsd … exited during startup`, or bound no socket | Read the share's `virtiofsd-<tag>.log`, and run `igloo doctor` for `virtiofsd` and `store view`.                                    |
| `evaluating the layers failed: nix exited …`            | Nix's own error is above it. A content layer that does not evaluate is the usual cause.                                             |
| `this runner needs … built that can reach the network`  | Review each derivation named, build it yourself, and run `igloo up` again. See [Configuration](configuration.md#what-igloo-builds). |
| `nix build exited …`                                    | Nix's own error is above it. A failed download from a binary cache is not retried by building: run `igloo up` again.                |
| `a content module overrode policy that mkRunner owns`   | A content layer sets an option policy decides. See [Configuration](configuration.md#what-content-cannot-set).                       |
| `host port … is already in use`                         | Stop what holds the port, or publish the guest port on another host port.                                                           |
| `the broker exited during startup`                      | Read `broker.log`, and run `igloo doctor` for `landlock`.                                                                           |
| `no igloo project at or above …`                        | Run the command inside a project, or create one with `igloo init`.                                                                  |
| `XDG_RUNTIME_DIR is unset`                              | Run igloo in a login session of your own. A shell reached through `su` or `sudo` often has none.                                    |
| `IGLOO_USER_LAYER names …, which does not exist`        | Run the `igloo` that home-manager installed, or unset `IGLOO_USER_LAYER`.                                                           |

Configuration errors name the file and the setting, and say where the setting belongs.

## Units

A VM is a set of transient systemd user units in a slice of its own, named after the project's label
and CID:

```sh
systemctl --user list-units 'igloo-*'
```

`igloo down` stops a VM's units without reading any configuration, and `igloo down --all` stops
every VM, including ones whose project directory is gone. Neither should need `systemctl` by hand.

## Checking the whole host

With a checkout of igloo, `scripts/host-verify.sh` checks igloo end to end on your host: it builds
it, launches scratch VMs, and probes what each part is kept from. When `doctor` passes and a launch
still fails, its `summary.md` says which part, and is worth attaching to a bug report.
[Contributing](../CONTRIBUTING.md#the-host-check) says what it needs, what it touches and how to
read what it writes.

That output is already scrubbed of what identifies your machine, by `scripts/redact.sh`. The script
scrubs the text files of any directory the same way, in place, on the machine they came from. For a
boot record, use [`igloo report`](#reporting-a-bug-with-igloo-report) instead, which also replaces
the project's name and what `broker.log` names. Read what you attach.

## Environment variables

The installed `igloo` sets what it needs. These exist for running igloo some other way, and for the
remedies `doctor` prints.

| Variable            | Names                                                                        |
| ------------------- | ---------------------------------------------------------------------------- |
| `IGLOO_FLAKE`       | The igloo flake VMs are built from. Set by the package.                      |
| `IGLOO_REVISION`    | That flake's commit, for `igloo report`. Set by the package if known.        |
| `IGLOO_USER_LAYER`  | The user layer's directory. Set by the home-manager module.                  |
| `IGLOO_BROKER`      | The broker. Set by the package.                                              |
| `IGLOO_BWRAP`       | `bwrap`. Set by the package.                                                 |
| `IGLOO_LANDLOCK`    | The helper the broker and the published ports run under. Set by the package. |
| `IGLOO_SSH_PROXY`   | systemd's `systemd-ssh-proxy`. Set by the package.                           |
| `IGLOO_STORE_VIEW`  | The helper that restricts a guest's store. Set by the package.               |
| `IGLOO_VIRTIOFSD`   | `virtiofsd`. Set by the package.                                             |
| `IGLOO_NIX`         | `nix`. Found on `PATH` by default.                                           |
| `IGLOO_SSH`         | `ssh`. The package puts its own on `PATH`.                                   |
| `IGLOO_SYSTEMCTL`   | `systemctl`. Found on `PATH` by default.                                     |
| `IGLOO_SYSTEMD_RUN` | `systemd-run`. Found on `PATH` by default.                                   |
| `IGLOO_LOGINCTL`    | `loginctl`. Found on `PATH` by default.                                      |

`nix`, `systemctl`, `systemd-run` and `loginctl` are deliberately the running system's.
