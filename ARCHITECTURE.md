# Architecture

This is for someone deciding whether to trust igloo, or about to change it: the programs igloo is
made of, what each module in `src/` does, and the invariants igloo keeps, each with the code that
holds it. The README's [threat model](README.md#what-it-protects-against) says what igloo protects
against; this says how, and where to look.

The code is the authority. Every invariant below names the code that holds it so that it can be
checked there, and a claim here that the code does not bear out is a bug in one or the other.

## The programs

- **The CLI**, `igloo` (`src/index.ts`). TypeScript on Bun, written with Effect. The flake compiles
  it with `bun build --compile` and wraps it (`cli` in `nix/packages.nix`) with `IGLOO_FLAKE` set to
  the flake's own store path, `IGLOO_REVISION` to its commit when it has one, and an `IGLOO_*`
  variable naming each helper below, so an installed igloo builds VMs from the store and runs the
  helpers it was built with. The home-manager module wraps it once more with `IGLOO_USER_LAYER`, the
  user layer it builds into the store. The CLI runs on the host as the user, starts a VM's units,
  and exits; the VM does not depend on it afterwards.
- **The runner flake**, one per project (`.igloo/runner/flake.nix`, written by `Flake.render`). It
  takes igloo's flake as a `path:` input and calls `lib.mkRunner`, with the composed policy as
  arguments and the content layers as `contentModules`. `mkRunner` (`nix/runner.nix`) evaluates the
  guest's NixOS system and builds its runner with microvm.nix: `bin/microvm-run` is QEMU's command
  line, and `share/microvm/virtiofs/<tag>/` describes the shares.
- **The broker**, `igloo-broker` (`src/broker.ts`). One process per VM that holds a grant or has a
  tunnel destination. It holds that VM's credentials, serves brokered requests on one Unix socket
  and an HTTPS tunnel on another, and constructs every upstream request itself. For the hosts its
  git grants reach, it answers TLS on a third socket, which the tunnel hands those connections to.
  It is packaged from that one file and Bun, and imports nothing: not Effect, and nothing else in
  `src/`.
- **`igloo-landlock`** (`src/landlock.c`). Runs a command under a Landlock ruleset: TCP connections
  only to the ports named, TCP binds only on the ports named, no abstract Unix socket, and, given
  paths, reads and writes only beneath them; and under a seccomp filter that refuses the sockets
  Landlock does not govern. The broker and the published ports run under it, and so does nix
  whenever it evaluates a layer or a policy file.
- **`igloo-store-view`** (`src/store-view.c`). Runs a command in a user and mount namespace whose
  `/nix/store` holds only the store paths listed. The store's virtio-fs daemon runs under it.

The CLI also runs programs igloo did not write: `nix`; `systemd-run` and `systemctl`, against the
user's systemd manager; QEMU, through the runner's `microvm-run`; `virtiofsd`, one per share; `ssh`,
reaching the guest's sshd over vsock through systemd's `systemd-ssh-proxy`; `ssh-keygen` and
`openssl`, for the keys a project keeps; and `bwrap`, for `igloo fallback` only.

## A running VM

A VM is a set of transient systemd user units in one slice, `igloo-<id>.slice`, where `<id>` is
`<label>-<cid in hex>` and the label is the project directory's name.

| Unit                         | Runs                                                                                               | Confinement                               | Started                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------- |
| `igloo-<id>-virtiofsd-<tag>` | `virtiofsd` for one share: `ro-store`, `workspace` or `home`; the store's under `igloo-store-view` | virtiofsd's own sandbox                   | always                              |
| `igloo-<id>-qemu`            | the runner's `bin/microvm-run`                                                                     | `Systemd.Hypervisor`                      | always                              |
| `igloo-<id>-broker`          | `igloo-broker`, under `igloo-landlock`                                                             | `Systemd.CredentialHolder`                | when the VM has a grant or a tunnel |
| `igloo-<id>-tether`          | `ssh -R`: the guest's `127.0.0.1:3128` to the broker's socket, and `:3129` to the tunnel's         | `Systemd.Forwarder`, a network of its own | with the broker                     |
| `igloo-<id>-ports`           | `ssh -L`: each published port, from the host's `127.0.0.1` to the guest's; under `igloo-landlock`  | `Systemd.Forwarder`, the host's network   | when the project publishes ports    |

In the project, which is on disk:

- `.igloo/project.json`, the marker that makes a directory a project.
- `igloo.nix` and `igloo-policy.nix`, the project's layer: content and policy.
- `workspace/`, the guest's `/workspace`, and `.igloo/home/`, the guest's `/root`.
- `.igloo/ssh/id`, the key the host reaches the guest with. Its public half is built into the guest.
- `.igloo/tls/`, for a project whose broker answers a name: `certificate.pem` and `key.pem`, what
  the broker answers with, and `authority.pem`, the authority that issued them, which the guest
  trusts. The authority's own key is deleted once it has signed.
- `.igloo/runner/flake.nix`, the runner flake, and `.igloo/runners/current`, the gc-root that keeps
  the built runner.
- `.igloo/logs/<boot id>/` and `.igloo/logs/latest`, a record per launch, and
  `.igloo/launched-from.json`, what the running VM was launched from.

In `$XDG_RUNTIME_DIR/igloo/`, a tmpfs:

- `<id>/`, QEMU's working directory: the vhost-user sockets, QMP's `control.socket`, `store-paths`,
  and the credential values, `credentials/` for delivered ones and `broker-credentials/` for
  brokered ones.
- `<id>-broker/`, the broker's: `http.sock` for brokered requests, `proxy.sock` for the tunnel, and
  `tls.sock` for the names it answers.

## A launch

`igloo up`, and `igloo attach` before it opens a shell:

1. `Project.find` walks up from the working directory to the marker, refusing one inside another
   project's workspace or home. `Config.resolve` refuses a policy file in the workspace, reads the
   policy files in one confined `nix eval`, composes them (`Config.compose`) and lists the content
   layers that exist.
2. For a broker that answers a name, `Tls.ensure` makes or finds the project's certificate.
   `Spec.fromConfig` decides where each credential goes, the broker's grants, what the guest is told
   about the broker, and the runner's arguments, the authority the guest trusts among them.
   `Flake.write` writes the runner flake.
3. If the VM is already running, nothing is built: `up` says which of its inputs changed since it
   launched (`LaunchInputs`) and makes sure its broker, tether and ports are up. Otherwise:
4. The slice is stopped and the runtime directory emptied.
5. The credentials are fetched (`Secrets.write`), first, since a source may prompt for a passphrase.
6. The runner is evaluated once, confined, to a `.drv` (`Vm.ts`'s `instantiate`). The build plan is
   checked (`BuildPlan.check`) and that same `.drv` built (`Vm.ts`'s `build`), pinned by the
   gc-root.
7. The shares are read off the runner (`Virtiofs.shares`) and held to the ones the launch asked for
   (`Virtiofs.match`), and its closure listed (`StoreView.closure`). A virtio-fs daemon starts for
   each share, and once every socket exists, QEMU. The launch waits until `ssh` over vsock answers.
8. The broker, then the tether, then the published ports.

Each step is timed into the launch's boot record (`BootLog`), which keeps the units' logs beside it.
`down` powers the guest off over QMP and stops the slice.

## The modules

Every module but `index.ts` has its tests beside it, in `src/<Module>.test.ts`.

| Module                         | What it does                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `index.ts`                     | The CLI's commands, and the one module of it that reads the process environment.              |
| `Binaries.ts`                  | The external programs igloo runs, each overridable by an `IGLOO_*` variable.                  |
| `Project.ts`                   | The marker, finding a project, and every path derived from its root.                          |
| `Cid.ts`                       | The vsock CID, a hash of the project's canonical root.                                        |
| `Config.ts`                    | Finding, evaluating and composing the layers: the policy, and the content modules.            |
| `Evaluation.ts`                | The confinement for every nix evaluation of a layer or policy file.                           |
| `Spec.ts`                      | What a composed configuration means for a VM: credentials, grants, the runner's arguments.    |
| `Flake.ts`                     | The runner flake.                                                                             |
| `BuildPlan.ts`                 | What building a runner would run, and which of it igloo refuses.                              |
| `Vm.ts`                        | The launch, `attach`, `down` and `ls`, and the command lines of the broker and the forwards.  |
| `Systemd.ts`                   | The transient user units a VM runs as, and their three confinements.                          |
| `Virtiofs.ts`                  | One virtio-fs daemon per share: the runner's shares, checked, and each daemon's command line. |
| `StoreView.ts`, `store-view.c` | The guest's closure-only `/nix/store`, through `igloo-store-view`.                            |
| `landlock.c`                   | `igloo-landlock`.                                                                             |
| `Qmp.ts`                       | `down`'s power event, sent only to QEMU's own process.                                        |
| `Secrets.ts`                   | Fetching credential values into files on the runtime tmpfs. No value is returned from it.     |
| `Tls.ts`                       | The broker's TLS certificate and the authority the guest trusts, made with `openssl`.         |
| `broker.ts`                    | The broker: brokered requests, the tunnel, and what the guest is told to reach them.          |
| `Fallback.ts`                  | `igloo fallback`'s bubblewrap sandbox, for when a VM will not start.                          |
| `Preflight.ts`                 | `igloo doctor`'s checks, each failure with a remedy.                                          |
| `BootLog.ts`                   | The record each launch leaves under `.igloo/logs/`.                                           |
| `NixLog.ts`                    | nix's errors and warnings from a launch, kept in its record.                                  |
| `LaunchInputs.ts`              | What a VM was launched from, and the report of what has changed since.                        |
| `Report.ts`                    | `igloo report`: the version, `doctor` and a boot record, with what identifies replaced.       |
| `Format.ts`                    | `ls`'s table, and how a failure is printed.                                                   |

And the flake's outputs, the per-system ones for `x86_64-linux` only, each with the file that
defines it; `flake.nix` wires them together:

| Output                      | Defined in         | What it is                                                                                                    |
| --------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `packages.default`, `igloo` | `nix/packages.nix` | The CLI, as `cli` wraps it.                                                                                   |
| `packages.broker`           | `nix/packages.nix` | The broker: `bun` and `src/broker.ts`.                                                                        |
| `packages.landlock`         | `nix/packages.nix` | `igloo-landlock`.                                                                                             |
| `packages.storeView`        | `nix/packages.nix` | `igloo-store-view`.                                                                                           |
| `packages.testVm`           | `nix/test-vm.nix`  | A runner that is built and never booted. Building it checks the pins and the boot files.                      |
| `checks`                    | `nix/checks.nix`   | The packages, and `testVm` with content modules that have to be refused, change nothing, or disable the core. |
| `lib.mkRunner`              | `nix/runner.nix`   | One VM's runner, from policy arguments and content modules.                                                   |
| `nixosModules.default`      | `nix/host.nix`     | The host side: lingering for the users who run igloo.                                                         |
| `nixosModules.guest`        | `nix/guest.nix`    | The guest core every VM starts from, with the packages in `nix/core-packages.nix`.                            |
| `homeModules.default`       | `nix/home.nix`     | The user layer, built into the store, and the CLI wrapped with `IGLOO_USER_LAYER` naming it.                  |
| `overlays.default`          | `flake.nix`        | The CLI as this flake built it, as `pkgs.igloo`.                                                              |
| `devShells.default`         | `nix/devshell.nix` | The development shell, with the `IGLOO_*` programs pointed at this flake's own builds.                        |
| `formatter`                 | `flake.nix`        | `nix fmt`: nixfmt over the Nix files.                                                                         |

A running VM's drift report covers every file under `nix/`, found by walking it
(`LaunchInputs.ofIgloo`), so igloo's Nix lives there or in `flake.nix` and nowhere else; a test
fails on a Nix file anywhere else in the tree.

## Invariants

What igloo guarantees, each with what holds it. A way to break one is a vulnerability, to be
reported as [`SECURITY.md`](SECURITY.md) says. Where one has a limit, it says so.

### Policy never comes from the workspace

What a VM may do — its network mode and tunnel destinations, published ports, credentials and their
grants, model servers, memory and CPUs — is read from two files only: the user layer's
`igloo-policy.nix`, in the directory `IGLOO_USER_LAYER` names, which home-manager builds into the
store, and the project's, at the project root beside `workspace/` rather than in it. A policy file
in the workspace is refused, not ignored (`Config.resolve`, through `auditWorkspace`). So is a
project inside another project's `workspace/` or `.igloo/home/`, whose guest could have written its
marker and the policy beside it (`Project.find`, and `Project.init` before it makes one). So is a
project whose `workspace/` or `.igloo/home/` is a link: its guest writes wherever the link leads,
below no marker `Project.find` could weigh, so `up`, `attach` and `init` refuse it
(`Project.refuseLinkedShares`). A project cannot set what is the user layer's to set — memory, CPUs,
the broker's memory and the ceilings — or ask for a network mode or a tunnel destination above a
ceiling the user layer set (`Config.compose`, through `settings` and `checkKeys`). A credential or a
model server the user layer declares reaches only the projects its `projects` lists
(`Config.compose`). Which directories are shared is not a setting (`Spec.fromConfig`, `mkRunner`).

Policy reaches the guest's build as `mkRunner`'s arguments, every one applied from one `pins`
attrset at `mkOverride 10`, above `mkForce`. That priority and `pins` are both in `nix/runner.nix`,
and nothing else in the Nix a VM is built from sits at or below it; `nix/checks.nix` does, as
content that has to be refused. The runner's evaluation compares the merged configuration with each
pin and throws if any differs, so a content module, one imported from the workspace included, cannot
override, widen or add to policy at any priority. Content may come from the workspace: it decides
what is in the VM, not what the VM may do.

**Held by:** `Project.find`, `Project.refuseLinkedShares`, `Config.resolve`, `Config.compose`, and
`pins` and the comparison after it in `mkRunner` (`nix/runner.nix`).

### No guest has a network card

Under every network mode. `microvm.interfaces` and `microvm.forwardPorts` are pinned empty, and QEMU
runs in a network namespace of its own, with no interface but loopback, able to open Unix sockets
and nothing else (`Systemd.Hypervisor`). Everything that leaves the guest goes through the broker,
over the tether. `none`, `restricted` and `internet` differ only in what the broker allows:
`Config.compose` turns the mode into the tunnel's scope and refuses a brokered credential, a model
server or a tunnel destination under `none`, and `Spec.fromConfig` starts a broker only for a VM
with a grant or somewhere to tunnel to. The broker does not know the network mode.

**Held by:** `mkRunner`'s `pins`, `Systemd.Hypervisor`, `Config.compose`, `Spec.fromConfig`.

### The guest sees its workspace, its home and its own closure, and nothing else of the host

`microvm.shares` is pinned to three shares: the store, the project's `workspace/` and its
`.igloo/home/` (`Spec.fromConfig`). `microvm.storeOnDisk` is pinned off, and `microvm.devices` and
`microvm.volumes` empty. The store's virtio-fs daemon runs under `igloo-store-view`, in a mount
namespace whose `/nix/store` holds the runner's closure and nothing else, each path bound read-only,
and serves it with `--readonly`. An empty closure stops the launch rather than serving the whole
store. The rest of the project, the host's key in `.igloo/ssh/` among it, is not shared. A launch
serves a runner's shares only if they are those three, each by its tag with its source exactly and
its socket a bare file name, and which one is the store's is decided by that comparison.

**Held by:** `mkRunner`'s `pins`, `Spec.fromConfig`, `Vm.launch`, `Virtiofs.match`, `store-view.c`,
`Virtiofs.argv`.

### The broker constructs every upstream request from its grants

A request is authorized by its method and its path, with git's `service` parameter for a ref
advertisement, and by nothing else it carries (`decide`). On the TLS listener, the name a request
was addressed to is read as well, and only as one of the hosts the broker's git grants reach: it
stands where the path form puts the host, and the rest is `decide`'s (`decideAddressed`). The
upstream URL is built from the profile's fixed host and the grant's own copy of what it allows: a
git request for the repository as the grant spells it, a push only for one in its `write`
(`routeGit`), a read through a git grant's API under `repos/` and that repository or of the API's
root, a write there for one in its `write` at a path `apiWrites` lists, or a `POST` to the API's
fixed `graphql` path (`routeApi`), an upload of a release's asset for one in its `write` at the
fixed path its API takes one at (`routeUploads`), a model provider's request for an endpoint its
profile lists in `inferenceEndpoints` (`routeInference`), and a model server's on loopback, at the
port its grant names (`routeModelServer`). Nothing the guest sends reaches the upstream URL but an
OpenRouter model listing's query, and an API request's path past its repository and its query: each
query rebuilt so that each name and value is encoded, and the path's segments as the URL parser left
them, with every `.` and `..` resolved, so that none leaves the repository. A path holding a
percent-escape or an empty segment is refused, but for the one ending a host's root, and so is a
push or a REST write for a repository no grant's `write` lists, a push at its ref advertisement as
well as at the push, and a REST write `apiWrites` does not list.

A GraphQL query is the one request a grant's repositories do not bound. It names what it reads and
writes in its body, much of it by node IDs that say which repository they belong to only after a
lookup, so not even reading the body could match it against a grant; it is sent with the credential,
its body unread like every other, and the token's own scope is its bound (`routeApi`). A push is
bounded to its repository but not to its refs, which it names in its body: which branches and tags
it updates is the repository's rulesets' to bound. A REST write is bounded to its repository and its
path, and what it sets, a merge's base branch or a release's tag and commit, is in its body, for the
rulesets to bound as they bound a push.

On the TLS listener, a read no grant serves — a GET or HEAD, or git's fetch — is sent to the host it
was addressed to, with its path and query as the guest sent them and no credential at all, when the
tunnel's destinations take in that host (`decideAddressed`). The guest could have sent the same
request through the tunnel had the broker not answered the name. Anything else no grant serves is
refused.

The credential is always the broker's. A git request's headers are built, carrying of the guest's
only git's protocol version, checked against a pattern, and its body's gzip encoding
(`upstreamHeaders`). A model request carries the guest's headers less its credentials, the
hop-by-hop ones and any its `Connection` names, `Host`, `Expect`, `Content-Length` and
`Accept-Encoding`, and those a front end could take another method, path or origin from, such as
`X-HTTP-Method-Override`, `Forwarded` and `X-Original-URL` (`unforwardedRequestHeaders`), and a
listing carries no body headers (`bodyHeaders`); the broker's credential is set after the guest's
are dropped. An anonymous read is built as a model request is, and no credential is set. A redirect
is never followed, a 401 becomes the broker's own refusal (`relay`), and an answer loses its cookies
and authentication challenges on the way back (`responseHeaders`). The redirects of an API request
and an anonymous read alone go back to the guest as they came: an API's leads to a signed URL for a
log or an asset, and the broker neither follows it nor sends its credential there. An API answer's
`Link` naming a page by the repository's number is put back in the `repos/<owner>/<repo>/` form
(`pagesOf`), so a client following it stays within the grant.

The body is streamed upstream as it arrives, in chunks, never read and never refused for its size
(`handle`, `serveRequests`). An asset's upload sent with a `Content-Length` and no
`Transfer-Encoding` goes with that length instead, and is held to it: a body that runs past it or
ends short of it ends the request and its connection, so that no byte past the stated length reaches
the upstream, which would read it as the start of another request (`uploadLength`, `heldTo`).
`headerTimeoutMs` ends a request whose upstream has not answered in time, a body that never ends
among them. What a provider does for a model, its hosted tools included, is the provider's, so under
`restricted` workspace data can leave through one to any address.

**Held by:** `broker.ts`: `decide`, `decideAddressed`, `routeApi`, `routeGit`, `routeInference`,
`routeModelServer`, `routeUploads`, `upstreamHeaders`, `uploadLength`, `heldTo`, `relay`,
`responseHeaders`, `pagesOf`, `handle`.

### The tunnel reaches only public addresses, on port 443

The tunnel carries `CONNECT` and nothing else: to port 443, and to a hostname, never an address or a
pattern (`parseConnect`). Under `restricted` the name has to be one the policy lists, matched
exactly, with no wildcard or suffix match (`allowTunnel`); under `internet`, any name. Every address
the name resolves to is then judged as an address: none in a loopback, private, link-local,
carrier-grade NAT, benchmarking, multicast or reserved range, none of those carried in an IPv6
address — mapped, compatible, translated or behind the NAT64 prefix, however it is spelled — and no
IPv6 address outside global unicast, or in 6to4 or Teredo (`isReachableAddress`), and none of this
host's own (`isHostAddress`). The connection is made to an address that was checked, never to the
name again (`publicDestinations`). What the tunnel carries is TLS the broker cannot read, and
nothing is injected.

A listed name that resolves to a routable address private to a VPN this host is on passes every
check here, and is reached.

The one exception is a host the broker's git grants reach, `tlsNames`. A `CONNECT` to one is not
tunnelled anywhere: whatever the destinations, it is joined to the broker's own TLS listener
(`serveTunnel`), where each request is decided and constructed as on the broker's port, and a read
no grant serves is sent on without a credential where the destinations take in the host
(`serveTls`). That listener answers with a certificate for those hosts from an authority made for
the project, which the guest trusts (`mkRunner`'s `brokerAuthority`). The authority's name
constraints limit it to the hosts any profile's grant can reach (`tlsNamesCovered`), and its key is
deleted once it has signed (`Tls.ensure`), so what the project keeps can answer those hosts to its
own guest and sign nothing.

**Held by:** `broker.ts`: `parseConnect`, `allowTunnel`, `isReachableAddress`, `isHostAddress`,
`publicDestinations`, `serveTunnel`, `serveTls`; `Tls.ensure`.

### The broker reaches no other VM, no Unix socket but its own, and no TCP port but those it uses

The broker runs under `igloo-landlock` (`Vm.brokerArgv`). It may connect over TCP only to the ports
`connectPorts` names — 443, for every profile and the tunnel; 53, for a resolver that retries over
TCP; and each granted model server's port — on any address. It may bind no TCP port, and connect to
no abstract Unix socket made outside its restriction. Landlock governs TCP sockets alone, so
`igloo-landlock` also refuses the sockets that would reach a port without it: every IP socket that
is neither TCP nor UDP, among them MPTCP's, SCTP's and SMC's, every `AF_SMC` socket, and io_uring,
which would make one without `socket()`. It refuses to run the broker on a kernel without Landlock
ABI 6 or seccomp filters rather than run it unrestricted.

Its unit has user, mount, PID and IPC namespaces of its own and no capabilities, and an empty root.
In that root are the store, read-only, which holds bun, the broker and `igloo-landlock`; the files
glibc reads to resolve a name — `/etc/nsswitch.conf`, `/etc/host.conf`, `/etc/hosts`,
`/etc/resolv.conf` and `/etc/gai.conf`, whichever the host has — read-only; its own credentials,
which systemd places there; its own socket directory, writable; and, if its programs are outside the
store, those files, read-only, and nothing beside them (`Vm.ts`'s `ensureBroker`). Nothing else of
the host's file system is there. So no other VM's directories reach it — their credential values,
QMP sockets and brokers' sockets, whether that VM started before the broker or after — nor its own
VM's, which holds QEMU's control socket; nor the sockets the user's session keeps in `/run/user`,
the session bus and the systemd user manager's, either of which would start a unit for it outside
this confinement; nor any socket the system serves under `/run`: the system bus, nscd's, systemd's
services over varlink and the journal's. Its network is the host's.

With nscd out of reach, glibc resolves a name itself: from the hosts file, and through the
nameservers `/etc/resolv.conf` lists, which under systemd-resolved is its stub on loopback. It loads
none of the NSS modules the host configures, since the store's glibc finds none. A resolver file the
host replaces rather than rewrites in place reaches the broker as it was when the broker started.

Left open: UDP, which Landlock does not cover; a listen on a TCP socket never bound, which takes a
port the kernel picks without Landlock seeing it; and a service listening on one of the ports it may
reach. These are open to a broker that a request has taken over, and to nothing the broker does by
design.

**Held by:** `Vm.brokerArgv`, `Vm.ts`'s `ensureBroker`, `connectPorts` in `broker.ts`, `landlock.c`,
`Systemd.ts`'s `hardening` and `CredentialHolder`.

### Evaluation of layers and policy files is confined

igloo evaluates Nix that someone else wrote in two places: the policy files, in one `nix eval`
(`Config.ts`'s `readPolicyFiles`), and the runner with its content layers, once per launch
(`Vm.ts`'s `instantiate`). Both run nix through `Evaluation.command`, which confines it twice.

Within nix, by `Evaluation.args`: nix's restricted evaluation, which reads the store, the files
named and, for the runner, the workspace, and fetches only the revisions igloo's own `flake.lock`
locks, from GitHub, or nothing for the policy files; an empty `nix-path`; `builtins.exec` off; and
import-from-derivation off, since it would build before anything had checked the build.

Restricted mode checks what the evaluation reads, and not all that nix reads for it:
`builtins.getFlake "path:<directory>"` would copy any directory the user can read into the store,
where the evaluation could read it. So nix also runs under `igloo-landlock`, with the rules
`Evaluation.confinement` makes. It may read the store, the files named, the workspace for the
runner, and the two flakes it evaluates there, the runner's and igloo's; and `/proc/self/maps` and
`/proc/stat`, for its garbage collector. It may write only a cache directory made for the one
evaluation, which `NIX_CACHE_HOME` points it at in place of the user's, and connect over TCP only to
ports 443 and 53. The rest of the project directory, where the VM's private key is, is readable to
neither (`Evaluation.forRunner`). Any new evaluation goes through `Evaluation.command`.

Left open: what a file's metadata says, its existence among it, since Landlock refuses a file when
it is opened and not when it is looked up; and UDP. A `nix.conf` outside the store is not read
during an evaluation.

**Held by:** `Evaluation.command`, `Evaluation.args`, `Evaluation.confinement`,
`Evaluation.forRunner`, `landlock.c`, and their two callers.

### Building a runner runs nothing that can reach the network

`up` evaluates the runner once, to a `.drv`, and asks nix what building it would build. If that
includes a fixed-output derivation, an impure one or one marked `__noChroot`, each of which a
builder can reach the network from, `up` refuses, naming each and saying how to build it by hand
after reviewing it (`BuildPlan.check`, `BuildPlan.describe`). A plan in a form igloo does not read
stops the launch too. Then it builds that same `.drv`, not a second evaluation, with `fallback` off,
so a substitution that fails cannot turn into a build (`Vm.ts`'s `build`). A derivation whose output
is already valid or can be substituted runs no builder, so it is not refused. A new source is the
user's to build.

Everything else builds in nix's sandbox, without the network, which holds where Nix has
`sandbox = true`. `igloo doctor` checks that (`Preflight.run`); `up` does not.

**Held by:** `Vm.ts`'s `instantiate` and `build`, `BuildPlan.check`.

### A credential's value goes only where its mode sends it

`Secrets` fetches each value on the host and returns none: it writes each to a file on the runtime
tmpfs, mode 0600 in a 0700 directory, and `down` removes them (`Secrets.write`, `Vm.down`). A source
the guest could have written, a file or a command named by its path inside the workspace or the home
through any symlink, is refused (`Secrets.ts`'s `outsideGuest`). A command runs in the directory of
the layer that declared it (`Spec.fromConfig`), and a file source has to be an absolute path outside
the store (`Config.ts`'s `readSource`). An error names the credential and its source, never the
value or anything the source printed (`SecretsError`).

A brokered value reaches the broker by `LoadCredential=`, from the file's path, and so never on a
command line: a unit's `credentials` has no field that could carry a value (`Systemd.Unit`). QEMU's
unit cannot see the directory it is written to (`Vm.launch`), and no VM's broker can: its root holds
nothing of the host's but the store, the resolver's files, its own socket directory and its programs
(`Systemd.CredentialHolder`, `Vm.ts`'s `ensureBroker`). The broker holds it in memory, sends it only
in the header its profile's upstream takes (`upstreamHeaders`), and logs credentials by name, never
by value (`audit`). A delivered value reaches the guest through QEMU's `fw_cfg` device, which is
given the file's path rather than the value (`mkRunner`'s `credentialArgs`), and lands on a tmpfs in
the guest. From there it is the guest's.

The broker's TLS key is not a credential's value but is held as one. `Tls.ensure` makes it on the
host and keeps it in `.igloo/tls/`, mode 0600 in a 0700 directory, outside both shares, as the
host's SSH key is kept in `.igloo/ssh/`. It reaches the broker by `LoadCredential=` under a name no
secret may take (`Config.ts`'s `composeSecrets`), and the broker takes it out of the credentials its
grants name before it serves anything, so no grant can send it upstream (`broker.ts`'s `main`).

**Held by:** `Secrets.ts`, `Systemd.startArgs`, `Systemd.CredentialHolder`, `Vm.launch`, `Vm.ts`'s
`ensureBroker`, `broker.ts`'s `upstreamHeaders`, `audit` and `main`, `mkRunner`'s `credentialArgs`,
`Tls.ensure`.

### QEMU sees the store, its VM's runtime directory and two devices, and nothing else of the host

QEMU's unit has an empty, read-only root holding the store, read-only; its VM's runtime directory,
writable, with the brokered credentials' directory in it hidden; and `/dev/kvm` and
`/dev/vhost-vsock`. Its namespaces are its own: user, mount, PID, network and IPC. It may open Unix
sockets and no other kind, so neither IP nor vsock; its guest's vsock it drives through the device.
It has no capabilities and no memory both writable and executable. The whole store is readable to
it, as it is to every user of the host.

Its runtime directory is writable to it, so a fresh `up` empties that directory before writing into
it (`Vm.launch`). QEMU loads a kernel and an initrd that content chose into the guest, so one that
resolves outside the store, or to a store path the runner was not built from, fails the runner's
build (`mkRunner`'s `checkBootFile`).

**Held by:** `Systemd.Hypervisor`, `Vm.launch`, `mkRunner`'s `checkBootFile`.

### Each virtio-fs daemon serves the guest from virtiofsd's own sandbox

`Virtiofs.argv` asks for it by name, `--sandbox=namespace` and `--seccomp=kill`: the worker serving
the guest has user, mount, PID and network namespaces of its own, its share as its root, and a
seccomp filter that kills it for any call serving does not need. A daemon that cannot enter the
sandbox exits rather than serve without it. The daemons' units are not otherwise confined, since the
sandbox is made of namespaces a confined unit could not create.

**Held by:** `Virtiofs.argv`.

### The tether and ports units see the store, the user database and their key, and little else

Both are `ssh` clients facing the guest's sshd, which the guest's root controls. Each unit has an
empty, read-only root holding the store, `/etc/passwd` and any of its programs that is outside the
store, and the tether's also holds the broker's socket directory. The project's key arrives by
`LoadCredential=`, so nothing of the project is in either root. Each has user, mount, PID and IPC
namespaces of its own and no capabilities. The tether also has its own network, with no IP. The
ports unit keeps the host's network to listen on its loopback, under `igloo-landlock`, which lets it
bind the ports it publishes, connect to nothing over TCP, and make none of the sockets Landlock does
not govern; each port is bound on `127.0.0.1` alone.

Left open: a `listen()` on a socket never bound still gets a port the kernel picks, which Landlock
does not see, as the broker's does; and UDP, for the ports unit. Both units keep `AF_VSOCK`, which
reaches every CID: other VMs' sshd, which refuses them without that project's key, and any vsock
service on the host.

**Held by:** `Systemd.Forwarder`, `Vm.ts`'s `forwardUnit`, `Vm.portsArgv`, `Vm.portsOptions`,
`landlock.c`.

### The runner is igloo's own, and only its `microvm-run` runs

`mkRunner` builds the runner with microvm.nix's `buildRunner`, from the configuration it checked
against the pins, but with igloo's own QEMU and igloo's own `pkgs` as the package set its scripts
come from, whatever the merged configuration holds; the pins on both refuse a content module that
names another. It reads neither `microvm.runner` nor `microvm.declaredRunner`, which a content
module could set. The options the runner's host-side scripts are built from — `preStart`,
`extraArgsScript`, `credentialFiles` and `volumes` — are pinned empty. Of the runner, the host reads
the share metadata, refused unless it names exactly the shares the launch asked for
(`Virtiofs.match`), and runs `bin/microvm-run` under QEMU's confinement. The virtio-fs daemons are
igloo's own binary with igloo's own arguments (`Virtiofs.argv`): the runner's virtiofsd is pinned
only so that binary is in its closure, which the store's daemon needs, and a launch refuses a runner
whose closure lacks it.

`down` sends the power event over QMP itself, to the QEMU unit's `MainPID` alone, checked on the
connection with `SO_PEERCRED` (`Qmp.powerdown`), and then waits on the unit rather than the socket.

**Held by:** `mkRunner`'s `runner` and `pins`, `Vm.launch`, `Virtiofs.match`, `Qmp.powerdown`,
`Vm.down`.

### The CLI does not own a VM's lifetime

A VM is a set of transient systemd user units in one slice (`Vm.launch`). The broker, the tether and
the ports are bound to QEMU's unit with `BindsTo=`, so none of them outlives its guest
(`Systemd.startArgs`). `down` stops the slice, which kills every process in it (`Vm.down`). The
NixOS module enables lingering for igloo's users, so their user manager, and the VMs it runs,
outlive a logout.

**Held by:** `Vm.launch`, `Vm.down`, `Systemd.startArgs`, `nixosModules.default`.

### A project's identity is its canonical root path

`Project.find` resolves the starting directory through its symlinks before walking up to the marker,
and everything a VM is known by derives from the root it finds there: the CID, a pure function of
that path (`Cid.forIdentity`), and the id that names the VM's slice and units (`Project.forRoot`).
The user layer's `projects` lists are matched against it. `--cid` replaces the derived CID for one
command. A change to `Cid.forIdentity` moves every project's CID, and strands every VM running under
the old one.

**Held by:** `Project.find`, `Project.forRoot`, `Cid.forIdentity`.

## Outside the invariants

- What the README's [threat model](README.md#what-it-protects-against) says igloo does not protect.
- **`igloo fallback`**, which is weaker isolation by design: a bubblewrap sandbox on the host's
  kernel and network, with the whole store read-only. It clears the environment and does not source
  `/root`'s startup files, which the guest writes (`Fallback.argv`).
- **`attach`, and the readiness checks `up` makes,** run `ssh` to the guest's sshd as the user,
  without a unit's confinement.
- **`igloo report`'s redaction.** It replaces what identifies by the fields igloo writes, by the
  values it knows and by the shapes of addresses and URLs (`Report.render`), so of text igloo does
  not write, Nix's errors and the guest's console among it, it can promise nothing more than that.
- Each limit an invariant above states.
