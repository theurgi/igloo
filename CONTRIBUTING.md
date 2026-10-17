# Contributing

Issues and pull requests are both welcome. A vulnerability is reported privately, as
[`SECURITY.md`](SECURITY.md) says, not in an issue.

[`ARCHITECTURE.md`](ARCHITECTURE.md) is the map: the programs igloo is made of, what each module
does, and the invariants a change has to keep.

## Setting up

igloo is built for `x86_64-linux` alone. Working on it needs Nix with flakes, and a checkout:

```sh
nix develop
```

The devshell has Bun, shellcheck, and what the tests need, and points `IGLOO_BROKER`,
`IGLOO_LANDLOCK`, `IGLOO_STORE_VIEW`, `IGLOO_VIRTIOFSD`, `IGLOO_SSH_PROXY` and `IGLOO_BWRAP` at this
flake's own builds. Entering it runs `bun install --frozen-lockfile` when `node_modules` is missing
or older than `package.json`, so a `bun.lock` that disagrees with `package.json` fails there.
Changing the lockfile is a `bun install` you run yourself. Each install runs the `prepare` script,
which patches TypeScript and oxlint in `node_modules` with Effect's language service.

Some tests start transient units under your systemd user manager. They need one running, with
`XDG_RUNTIME_DIR` set, systemd 257 or newer, and unprivileged user namespaces.

Building the packages works wherever Nix does. Booting a VM needs a NixOS host set up as
[`docs/install.md`](docs/install.md) describes, with `igloo doctor` passing, and nothing else boots
one: not the tests, not CI. In the devshell, `bin/igloo` runs this checkout rather than an installed
igloo, and builds VMs from this checkout's flake
([Running from a checkout](docs/install.md#running-from-a-checkout)). A change to anything that
builds or boots a VM — `mkRunner`, the launch, a unit's confinement, the broker, the C helpers — is
checked by booting one, which [the host check](#the-host-check) does end to end.

## The gate

```sh
bun run check
```

This runs four steps in turn, and stops at the first that fails:

- `format:check`: oxfmt over the TypeScript, JSON and Markdown. Markdown prose is wrapped at 100
  columns. `bun run format` applies it.
- `lint`: oxlint, type-aware, with Effect's rules from `@effect/tsgo`, denying warnings. Run lint as
  `bun run lint`, which uses the patched copy in `node_modules`.
- `typecheck`: `tsc --noEmit`, TypeScript 7 with Effect's language service.
- `test`: vitest, over `src/**/*.test.ts`. It runs on Bun even where `node` is on `PATH`, as
  `bunfig.toml` sets, since the tests use Bun's own APIs.

Lint denies warnings, so a new one fails the gate. Fix it in the code. Where a rule is wrong for
this code, configure it in `.oxlintrc.json`, with a comment giving the reason. Where it is wrong for
one line, suppress it there, with the reason after `--`:

```ts
// oxlint-disable-next-line effecttsgo/strict-effect-provide -- the entry point
```

CI runs more than the gate, and so should you when a change touches what it covers:

- `nix fmt` formats the Nix files with nixfmt. CI runs `nix fmt -- --ci`, which fails on a file it
  would change.
- `shellcheck scripts/*.sh bin/igloo`. A suppression carries its reason inline.
- `nix flake check`, which builds every package and checks what a content module cannot set.
  `testVm` is a `mkRunner` call, so building it compares the policy pins and checks the boot files.
  Each check in `nix/checks.nix` is `testVm` with one content module added that tries to reach host
  execution, through an option policy owns, an overlay or a replaced runner. It has to be refused,
  naming the option, or leave the runner `testVm`'s exactly. One more disables the guest core by
  `nixosModules.guest`, and has to leave none of it and every pin held.

## The host check

`scripts/host-verify.sh` is igloo's end-to-end check, and the only one that boots a VM. Run it in
the devshell, on a host:

```sh
nix develop --command ./scripts/host-verify.sh
```

It checks on a real host what the tests cannot reach:

- **The builds.** `testVm`, the broker, `igloo-landlock` and the package build, and the package's
  `igloo doctor` passes with its environment stripped.
- **What Landlock keeps.** A process under `igloo-landlock` reaches none of the user's abstract
  sockets, and only the TCP ports it is allowed.
- **Launches.** A scratch project is launched about a dozen times: in the fallback sandbox, with
  layers that try to read past what evaluation may, with a networked derivation, a published port,
  delivered and brokered credentials, and under `restricted` and `internet`. Each launch is checked
  from the host and from inside the guest: the virtio-fs daemons' sandboxes, the guest's store, and
  the confinement of QEMU, the broker, the tether and the port forward, read off their running
  processes.
- **The broker against real upstreams.** Its grants and refusals for github.com, api.anthropic.com
  and a stand-in model server; the tunnel, and its refusal of names that resolve inside the host;
  and a broker killed outright, or for memory, started again.

Each check reports `PASS` or `FAIL` with what it proves, or `NOTE` for what is recorded without a
verdict, such as a timing or a check that was skipped.

### What it needs

- A NixOS host with igloo installed through both modules, as [`docs/install.md`](docs/install.md)
  describes, and `igloo doctor` passing: KVM, vsock and a lingering user manager among the rest. The
  launches run the checkout's `bin/igloo` with the installed igloo's user layer, so a run checks the
  install as well as the checkout. With no installed igloo, a `NOTE` says so and the launches have
  no user layer.
- The devshell. The script checks for it before it does anything else.
- Network: for the builds, and for checks that reach public hosts such as github.com,
  api.anthropic.com and pypi.org through the broker.
- 5 to 20 minutes, most of it the first guest build. It runs one VM at a time.

### Opting in

Some checks need a real credential. Without the token or the key below, they are skipped, with a
`NOTE` saying so. At its start, the script says whether each arrived and how long it is, never its
value. A credential is written to a scratch file and nowhere else, and is scrubbed from the output.

| Variable                         | What it does                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IGLOO_VERIFY_GITHUB_TOKEN`      | A GitHub token. With it, a guest clones a repository through the broker. A fine-grained, read-only token is enough.                                                                                                                                                                                                              |
| `IGLOO_VERIFY_GITHUB_REPO`       | The repository that clone fetches, as `owner/name`. `git/git` by default. One you name stays out of the output.                                                                                                                                                                                                                  |
| `IGLOO_VERIFY_GITHUB_WRITE_REPO` | A scratch repository, not the one cloned, that the token can push to. With it, a branch is pushed there and deleted again; the token then needs Contents write on it. It needs a commit, such as a README: on an empty one the branch pushed would become the default, which GitHub will not delete. It stays out of the output. |
| `IGLOO_VERIFY_OPENROUTER_KEY`    | An OpenRouter key. With it, three streaming model calls go through the broker, spending a few tokens of credit.                                                                                                                                                                                                                  |
| `IGLOO_VERIFY_OPENROUTER_MODEL`  | The model those calls name. `openai/gpt-4o-mini` by default.                                                                                                                                                                                                                                                                     |
| `IGLOO_VERIFY_OUT`               | The directory to write to, created if missing, and outside the checkout. A new temporary directory by default.                                                                                                                                                                                                                   |
| `IGLOO_VERIFY_PORT`              | The host port a guest port is published on. `45080` by default.                                                                                                                                                                                                                                                                  |

The output stays outside the checkout because every launch takes the checkout as a `path:` input,
which copies all of it into the store, ignored files included.

### What it touches

No existing project. Its VM is a scratch project in a temporary directory, launched with scratch
user layers for the credential checks, and stopped on the way out even when a check fails. VMs that
were already running are counted, never named, and left running.

While it runs, it stages stand-ins for other VMs under `$XDG_RUNTIME_DIR/igloo`, puts a probe file
in your home directory, listens on the host's loopback, and publishes a guest port there. It removes
them all on the way out. What it leaves is its output, and the store paths it built: runners and the
packages. Nothing roots them, so the next garbage collection removes them.

### Reading the results

The script prints each verdict as it goes, and the output directory at its start and its end. It
exits 0 when nothing failed, 1 when a check did, and 2 when it could not start.

| Path              | What it holds                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `summary.md`      | Start here: each check's verdict and what it proves, the time per section, and what the run leaves out. |
| `environment.txt` | The commit, the host's kernel, Nix and systemd, and the `IGLOO_*` variables in play.                    |
| `steps/`          | Each command's whole output, named by the check that ran it. A `FAIL` names the file to read.           |
| `artifacts/`      | What the checks read: unit properties, the guest's answers, built scripts, boot records, and timings.   |
| `REDACTED.txt`    | How many of each label the scrub put in.                                                                |

The checks record counts rather than lists, and leave out what identifies the machine where they
can. On the way out, `scripts/redact.sh` scrubs the directory in place for what they cannot choose
the words of, such as Nix's errors and the guest's console. Your home directory, user name and host
name; the machine's addresses and networks, gateways, DNS servers and search domains; its interface
and network names and hardware addresses; and the opt-in credentials are each replaced by a label in
angle brackets. It finds those values by reading the machine, so it runs on the machine the output
came from: `scripts/redact.sh <dir>` scrubs the text files of any directory, in place. Read the
output before attaching any of it to an issue all the same.

## Dependencies

`effect`, `@effect/platform-bun` and `@effect/vitest` are pinned to one exact version, and move
together: a bump changes all three at once, to the same version. `@effect/tsgo`, which patches
TypeScript and oxlint, is pinned exactly too. Dependabot watches the GitHub Actions only; `bun.lock`
and `flake.lock` are bumped by hand.

### The `cliDeps` hash

The flake fetches the CLI's production dependencies in a fixed-output derivation, `cliDeps` in
`nix/packages.nix`, whose `outputHash` changes whenever `bun.lock` does. After a change to
`bun.lock`, build the CLI:

```sh
nix build .#default
```

It fails on a hash mismatch and prints the hash it got. Put that in `cliDeps`' `outputHash` and
build again. `bun run check` cannot catch a stale hash; CI's build does. A change to `version` in
`package.json` leaves the hash as it is.

## The C helpers

`src/landlock.c` and `src/store-view.c` are one file each, with no dependency but libc. The flake
compiles them as `packages.landlock` and `packages.storeView`, with `-std=c11 -O2 -Wall -Wextra`,
and the devshell points `IGLOO_LANDLOCK` and `IGLOO_STORE_VIEW` at those builds, so a change reaches
a devshell entered after it. The tests stand fakes in for both, so `bun run check` runs neither:
`igloo doctor` runs each, and booting a VM runs both.

## Writing code

- **Comments are for a reader with only the source.** Say why the code is as it is, where it
  applies. Leave out references to docs, issues and pull requests, the history of a decision,
  measurements offered as evidence, how sure anyone was, and remarks about the writing itself.
- **`ARCHITECTURE.md` stays true.** A change to what a module does, to an invariant, or to the code
  an invariant names changes `ARCHITECTURE.md` in the same commit.
- **Nix goes under `nix/`.** `flake.nix` wires the outputs, and what they are is defined in a file
  under `nix/`. A running VM's drift report hashes every file there, and a test fails on a Nix file
  anywhere else in the tree, since an edit to it would go unreported.
- **`docs/` stays true.** A change to a command, a flag, a policy setting, a module option or a
  broker profile changes the page that documents it. A flake reference to igloo in the README or
  `docs/` names the release by its tag, `v` and `package.json`'s `version`, and a test fails on one
  that names anything else, so a version bump changes them too.
- **Nothing host-identifying.** No real user names, host names, home directories, addresses or email
  addresses in code, tests, docs or commit messages. Use placeholders such as `alice`, `/home/you`
  and `example.com`.
- `index.ts` is the only reader of the process environment; everything else is passed what it needs.
  `broker.ts` imports nothing, Effect included, since it is packaged from that one file.

## Commit messages

- **The subject** says what the change does, in the imperative: capitalized, with no full stop, in
  about 72 characters or fewer. A change to one part of the repository may name it first:
  - `Broker: stream request bodies, and refuse none for its size`
  - `devshell: touch node_modules after an install`
  - `Confine QEMU's unit`
- **The body**, when the subject is not enough, is prose wrapped at 72 columns: why the change was
  made, and what a reader of the diff would not see in it.

## Pull requests

1. Fork the repository, and branch from `main`.
2. Make the change, with tests for what it changes, and `bun run check` passing.
3. Open a pull request against `main`. Say what it changes and why, and how you checked it,
   including whether you booted a VM, or ran the host check, for a change that builds or boots one,
   since CI cannot.
4. CI runs on the pull request, and has to pass before it is merged.

For anything larger than a fix, open an issue first.
