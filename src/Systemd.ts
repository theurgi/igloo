import { Duration, Effect, Schema, Stream, String as Str } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

export class SystemdError extends Schema.TaggedError<SystemdError>()('SystemdError', {
  message: Schema.String,
  unit: Schema.String,
}) {}

/**
 * Escape a name for use as one component of a slice name.
 *
 * systemd reads `-` in a slice name as a hierarchy separator: unescaped,
 * `igloo-foo-bar.slice` is a *child* of `igloo-foo.slice`, so stopping the
 * slice named for `foo` would also stop the one named for `foo-bar`. Escaping
 * keeps every name a leaf directly under `igloo.slice`.
 */
export const escapeSliceComponent = (name: string): string => name.replaceAll('-', '\\x2d')

/** Recover the name `escapeSliceComponent` was given. */
export const unescapeSliceComponent = (component: string): string =>
  component.replaceAll('\\x2d', '-')

/**
 * A process holding credentials on the host, which has to reach the network to
 * use them: an empty root holding the store, the resolver's files and
 * `readable`, all read-only, its own credentials and `writable`, and nothing
 * else; and the first process the kernel kills when memory runs out. What the
 * user can read elsewhere is not hidden from it but absent, and so is every
 * socket the system serves under `/run`.
 *
 * The resolver's files are the host's `/etc/nsswitch.conf`, `/etc/host.conf`,
 * `/etc/hosts`, `/etc/resolv.conf` and `/etc/gai.conf`, whichever it has. With
 * no nscd to ask, glibc resolves a name itself: from the hosts file, and
 * through the nameservers `/etc/resolv.conf` lists, which under
 * systemd-resolved is its stub on loopback. It loads none of the NSS modules
 * the host configures, since the store's glibc finds none, so of
 * `nsswitch.conf` only the order of those two applies. Each is bound as the
 * file its path names when the unit starts, so one the host later replaces
 * rather than rewrites keeps its old contents here until the next start.
 *
 * Two deliberate holes. `MemoryDenyWriteExecute=` is absent because the broker
 * is a JIT runtime and would not start under it. `AF_INET`/`AF_INET6` stay
 * reachable because a broker that cannot make an upstream request has no
 * purpose; `AF_UNIX` is how anything reaches it in the first place.
 *
 * The host's network brings with it every service listening on loopback and
 * every abstract Unix socket, which no property here can take away from a unit
 * that keeps that network: a user manager does not enforce `IPAddressDeny=`.
 * The broker's launch narrows both by running it under `igloo-landlock`: no
 * abstract socket, and TCP only to the ports it uses. What is left is a service
 * on one of those ports, anything over UDP, and a TCP listener of its own on a
 * port the kernel picks, which a listen on a socket never bound gets without
 * Landlock seeing it. The broker's own code connects only to its profiles'
 * fixed hosts, to a granted model server's port on loopback and, through the
 * tunnel, to names it refuses when they resolve inside this machine, and
 * listens only on its Unix sockets, so what is left is
 * open to a broker that a request has taken over, and to nothing it does by
 * design.
 *
 * Left out: `PrivateTmp=` and `ProtectSystem=`, for a hypervisor's reasons;
 * and any bound on what it consumes but `memoryMax`, and that only when one is
 * given. What it consumes follows from what the guest asks of it, which a
 * harness on the host would be bounded in by nothing but the machine, and a
 * bound that came out low would fail the guest's requests for asking.
 */
export interface CredentialHolder {
  readonly kind: 'credentials'
  /**
   * Absolute, as systemd's `MemoryMax=` spells it, e.g. `256M`, and with no
   * swap beyond it. Absent, none.
   */
  readonly memoryMax?: string | undefined
  /** Host paths it sees read-only besides the store and the resolver's files. Each must exist. */
  readonly readable?: readonly string[] | undefined
  /** The only host paths it sees writable. Each must exist. */
  readonly writable: readonly string[]
}

/**
 * A process running a guest, whose kernel, initrd and much of whose command
 * line come from content a guest module chose: an empty root holding the store
 * read-only, `writable` and `devices`, and nothing else. What the user can read
 * elsewhere is not hidden from it but absent.
 *
 * Two deliberate holes. `AF_UNIX` stays, for its own control and vhost-user
 * sockets. The whole store is readable rather than only the VM's closure, since
 * every user of the host can read it anyway.
 *
 * Left out: `PrivateTmp=` and `ProtectSystem=`, since its root has no /tmp and
 * nothing writable but `writable`; `ProtectHostname=` and `ProtectClock=`, since
 * changing either takes a capability it has none of; and any bound on what it
 * consumes. The guest's size is policy, which the hypervisor itself enforces,
 * and a cgroup bound would need an estimate of the hypervisor's own overhead on
 * top; one that came out low would kill a VM for using what it was given.
 */
export interface Hypervisor {
  readonly kind: 'hypervisor'
  /**
   * Device nodes it may open. One the host lacks is left out rather than
   * failing the start, so the process reports it by name. No spaces:
   * `DeviceAllow=` takes a path unquoted.
   */
  readonly devices: readonly string[]
  /**
   * Paths inside `writable` it may not reach. One that does not exist is
   * skipped, since there is nothing there to hide.
   */
  readonly hidden: readonly string[]
  /** The only host paths it sees besides the store, all writable. Each must exist. */
  readonly writable: readonly string[]
}

/**
 * An `ssh` client holding a forward open into a guest, whose server is the
 * guest's sshd and so guest root's to control: an empty root holding the store
 * and `readable`, all read-only, and nothing else. The client has no sandbox of
 * its own, so this is the whole of what keeps a bug the guest can reach in it
 * from reaching the user.
 *
 * Without `hostNetwork` it has a network namespace of its own, which leaves
 * behind the user's abstract Unix sockets and every loopback port, and no IP at
 * all. With it, it has the host's network, which a forward that listens on the
 * host's loopback needs, and every loopback service and abstract socket come
 * with it. The launch narrows both by running it under `igloo-landlock`: no
 * abstract socket, a TCP bind only on the ports it publishes, and no TCP
 * connect.
 *
 * Deliberate holes. `AF_VSOCK`, because it reaches its guest through a vsock,
 * and a network namespace does not contain vsock: it can connect to every
 * guest's sshd, which refuses it without that project's key, and to anything on
 * the host that listens on vsock. `AF_UNIX`, for the descriptor its proxy hands
 * back and for a forward to a socket in `readable`. With the host's network,
 * UDP, which Landlock does not cover, and a listen on a TCP socket never bound,
 * which takes a port the kernel picks without Landlock seeing it.
 *
 * Left out: `PrivateTmp=`, `ProtectSystem=`, `ProtectHostname=` and
 * `ProtectClock=`, for a hypervisor's reasons; and any bound on what it
 * consumes, which would be a guess at what the forwards carry, and one that came
 * out low would cut a guest off from its broker or the user off from a port.
 */
export interface Forwarder {
  readonly kind: 'forwarder'
  /** Whether it keeps the host's network. */
  readonly hostNetwork: boolean
  /** The only host paths it sees besides the store, all read-only. Each must exist. */
  readonly readable: readonly string[]
}

/**
 * How a unit is confined: one of three presets, each whole.
 *
 * Presets rather than a set of switches, because each is an account of what one
 * kind of process needs, and every property in it has a reason that holds for
 * that kind as a whole. A unit that wanted part of one would be another kind.
 */
export type Confinement = CredentialHolder | Forwarder | Hypervisor

/**
 * A transient user service to launch. `argv[0]` must be an absolute path:
 * systemd requires one for `ExecStart`, and the unit is not started from a
 * shell that could resolve it.
 */
export interface Unit {
  readonly argv: readonly [string, ...string[]]
  /**
   * Units this one is bound to: it starts after them, and stops when any of
   * them stops.
   *
   * `BindsTo=` rather than `Requires=` because the failure that matters is a
   * bound unit *dying* rather than failing to start. Without it a unit attached
   * to a VM outlives the guest it was launched against, and its restart loop
   * re-attaches it to nothing.
   */
  readonly boundTo?: readonly string[] | undefined
  /**
   * The unit's human label, and the only place a caller can attach a string of
   * its own to a running unit — systemd accepts no arbitrary metadata on a
   * transient unit. It survives for exactly as long as the unit does.
   *
   * Absent, `systemd-run` fills it with `[systemd-run] <command line>` rather
   * than leaving it empty, so a reader cannot treat any particular value as
   * "unset". A caller that reads this back has to be able to recognise its own
   * descriptions.
   */
  readonly description?: string | undefined
  /**
   * Environment for the unit, and with systemd's own variables, such as
   * `CREDENTIALS_DIRECTORY`, all of it: `start` keeps the user manager's from
   * the unit, and the invoking shell's never reaches it. Anything the process
   * needs — `PATH` above all — has to be passed here.
   */
  readonly env?: Record<string, string> | undefined
  /** Absent, the unit runs with everything its user has. */
  readonly confine?: Confinement | undefined
  /**
   * Credentials to place in the unit's `$CREDENTIALS_DIRECTORY`, by name and
   * path.
   *
   * A path, never a value. systemd's other mechanism, `SetCredential=`, takes
   * the value inline — and every property here becomes a `systemd-run`
   * argument, so an inline value would sit in `/proc/<pid>/cmdline`, which is
   * world-readable, for as long as the launcher runs. There is deliberately no
   * field here that could carry one.
   *
   * Reading the file is part of starting the unit, so a source that has gone
   * away fails the start instead of yielding a unit running without it.
   */
  readonly credentials?: readonly { readonly name: string; readonly path: string }[] | undefined
  /** Both stdout and stderr are appended here. Absent → the journal. */
  readonly logFile?: string | undefined
  /** Without the `.service` suffix. */
  readonly name: string
  /**
   * Restart the unit when it exits, bounded by a start limit.
   *
   * The bound is not tuning. `Restart=always` on its own turns a permanent
   * failure — a port already taken, a credential source that is gone — into a
   * loop that never stops restarting, so anything waiting on the unit waits out
   * its whole budget instead of failing when the cause is already known. The
   * limit is what makes such a failure terminal.
   */
  readonly restart?:
    | { readonly burst: number; readonly delaySec: number; readonly intervalSec: number }
    | undefined
  /** Without the `.slice` suffix. Stopping it stops every unit inside. */
  readonly slice: string
  readonly workingDirectory: string
}

/**
 * A path as systemd reads one in a path-list property: quoted, so a space does
 * not split it in two and a `:` is not taken for the separator before a bind's
 * destination. `prefix` is systemd's own, such as `-` for "skip it if absent",
 * and goes inside the quotes.
 */
const quoted = (path: string, prefix = ''): string =>
  `"${prefix}${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

/**
 * The allowlist a process facing a guest starts from: an empty, read-only root,
 * with the store bound into it.
 */
const storeOnly: readonly string[] = [
  '--property=TemporaryFileSystem=/:ro',
  '--property=BindReadOnlyPaths=/nix/store',
]

/** What glibc reads to resolve a name without nscd. */
const resolverFiles: readonly string[] = [
  '/etc/nsswitch.conf',
  '/etc/host.conf',
  '/etc/hosts',
  '/etc/resolv.conf',
  '/etc/gai.conf',
]

/**
 * The oldest systemd whose `systemd-run` and user manager both take every
 * property here: `PrivatePIDs=` and the `self` value of `PrivateUsers=`, both
 * in `hardening`, are new in 257. An older `systemd-run` refuses either before
 * any unit exists, and an older manager refuses what a newer `systemd-run`
 * sends it.
 */
export const minimumVersion = 257

/**
 * What every confined unit gets, whichever kind it is: no way to gain
 * privilege, nothing of the user's other programs — their processes,
 * terminals and shared memory — none of the kernel's own interfaces, and only
 * the system calls an ordinary service makes.
 */
const hardening: readonly string[] = [
  // A user namespace of its own, which systemd would add implicitly to sandbox
  // a user unit at all; stated, because what follows depends on it. The user's
  // other processes are in a different one, and the kernel refuses
  // ptrace-mode access across that line, so their `/proc/<pid>/root`, their
  // environment and their memory are closed to it. The user keyring it finds is
  // a different keyring from theirs, too.
  '--property=PrivateUsers=self',
  '--property=NoNewPrivileges=yes',
  // Empty sets rather than a subset: nothing here needs a capability, and a
  // list invites additions that are never taken back out.
  '--property=CapabilityBoundingSet=',
  '--property=AmbientCapabilities=',
  '--property=PrivateDevices=yes',
  // `PrivateDevices=` gives it a /dev of its own, but in a user manager it
  // fills it partly by binding the host's mounts in, and these four are the
  // user's: the user's terminals, which it could write into and read
  // keystrokes from, and the file systems other programs keep shared memory and
  // message queues in.
  '--property=InaccessiblePaths=/dev/pts /dev/shm /dev/hugepages /dev/mqueue',
  // A PID namespace of its own, so it can neither name the user's other
  // processes nor signal them, and of `/proc` only its own processes' entries.
  // Its process is PID 1 there, which the kernel spares any signal it has no
  // handler for, except `SIGKILL` sent from outside — which is how it is
  // stopped.
  '--property=PrivatePIDs=yes',
  '--property=ProcSubset=pid',
  // An IPC namespace of its own: System V shared memory is checked against its
  // owner, so the user's segments would otherwise be readable from here.
  '--property=PrivateIPC=yes',
  '--property=ProtectKernelTunables=yes',
  '--property=ProtectKernelModules=yes',
  // The kernel log, which describes the host and which an unprivileged user can
  // read unless the host restricts it. `PrivateDevices=` already leaves out
  // /dev/kmsg, `ProcSubset=` /proc/kmsg, and the system call filter syslog(2);
  // this closes all three by itself, so none of those is kept for its sake.
  '--property=ProtectKernelLogs=yes',
  '--property=ProtectControlGroups=yes',
  '--property=RestrictSUIDSGID=yes',
  '--property=RestrictRealtime=yes',
  '--property=RestrictNamespaces=yes',
  '--property=LockPersonality=yes',
  '--property=SystemCallArchitectures=native',
  '--property=SystemCallFilter=@system-service',
  // A core dump is a copy of the process's memory on disk, written by the
  // kernel, outside everything else here — the credentials a broker holds, or
  // the whole of a guest's memory.
  '--property=LimitCORE=0',
]

const credentialHolderArgs = (confine: CredentialHolder): Array<string> => [
  ...hardening,
  ...storeOnly,
  // Each skipped if the host lacks it, as glibc on the host would find it
  // missing too.
  `--property=BindReadOnlyPaths=${resolverFiles.map(path => quoted(path, '-')).join(' ')}`,
  '--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
  // The most a score can be raised, which any process may do to itself. When
  // the host runs out of memory the kernel kills the process scoring highest,
  // so it is this one before a guest and before nearly anything else of the
  // user's: a process whose memory grows with what a guest asks of it is the
  // likeliest cause, and the cheapest to lose, holding nothing its next start
  // does not bring back.
  '--property=OOMScoreAdjust=1000',
  // `MemoryMax=` bounds only what it holds in RAM. Past it, a host with swap
  // pages the rest out and the bound holds nothing back, so a bound takes swap
  // away with it.
  ...(confine.memoryMax === undefined
    ? []
    : [`--property=MemoryMax=${confine.memoryMax}`, '--property=MemorySwapMax=0']),
  ...confine.writable.map(path => `--property=BindPaths=${quoted(path)}`),
  ...(confine.readable ?? []).map(path => `--property=BindReadOnlyPaths=${quoted(path)}`),
]

const hypervisorArgs = (confine: Hypervisor): Array<string> => [
  ...hardening,
  ...storeOnly,
  ...confine.writable.map(path => `--property=BindPaths=${quoted(path)}`),
  ...confine.hidden.map(path => `--property=InaccessiblePaths=${quoted(path, '-')}`),
  ...confine.devices.map(path => `--property=BindPaths=${quoted(path, '-')}`),
  // Allowed as well as bound: `PrivateDevices=` also closes the device policy
  // to its own few nodes, and a manager that can enforce that — root's can —
  // refuses a bound device it was not told to allow.
  ...confine.devices.map(path => `--property=DeviceAllow=${path} rw`),
  // A network namespace of its own, which leaves behind the user's abstract
  // Unix sockets — a display server's among them — and every loopback port,
  // including the ones this tool publishes. A guest has no network card, so
  // nothing here needs one.
  '--property=PrivateNetwork=yes',
  // `AF_UNIX` alone, because a network namespace does not contain vsock:
  // without this it could connect to other guests, and to anything on the host
  // that listens on vsock. Its own vsock device it drives through
  // `/dev/vhost-vsock`, which is a device, not a socket.
  '--property=RestrictAddressFamilies=AF_UNIX',
  // Under KVM the guest's code runs in guest mode, so nothing in the host
  // process needs memory that is both writable and executable.
  '--property=MemoryDenyWriteExecute=yes',
]

const forwarderArgs = (confine: Forwarder): Array<string> => [
  ...hardening,
  ...storeOnly,
  ...confine.readable.map(path => `--property=BindReadOnlyPaths=${quoted(path)}`),
  ...(confine.hostNetwork
    ? ['--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_VSOCK']
    : ['--property=PrivateNetwork=yes', '--property=RestrictAddressFamilies=AF_UNIX AF_VSOCK']),
  // ssh, the shell it runs its proxy command through and the proxy are all
  // compiled ahead of time.
  '--property=MemoryDenyWriteExecute=yes',
]

const confinementArgs = (confine: Confinement): Array<string> => {
  switch (confine.kind) {
    case 'credentials':
      return credentialHolderArgs(confine)
    case 'forwarder':
      return forwarderArgs(confine)
    case 'hypervisor':
      return hypervisorArgs(confine)
  }
}

/**
 * `KillSignal=SIGKILL` rather than the default `SIGTERM`-then-wait: a member
 * that ignores `SIGTERM` otherwise costs the full `TimeoutStopSec` on every
 * stop. Teardown here is a backstop behind an orderly guest shutdown, so there
 * is nothing to be graceful about.
 *
 * `inherited` is the names in the user manager's environment.
 */
export const startArgs = (unit: Unit, inherited: readonly string[] = []): Array<string> => [
  '--user',
  '--quiet',
  `--unit=${unit.name}`,
  `--slice=${unit.slice}.slice`,
  // Drop the unit once it exits, including on failure, so a re-`up` is not
  // blocked by the corpse of a failed predecessor.
  '--collect',
  `--working-directory=${unit.workingDirectory}`,
  '--property=KillSignal=SIGKILL',
  '--property=TimeoutStopSec=5',
  ...(unit.boundTo ?? []).flatMap(other => [
    `--property=BindsTo=${other}`,
    // `BindsTo=` alone constrains stopping, not ordering: without `After=` the
    // two start concurrently and this one races the thing it depends on.
    `--property=After=${other}`,
  ]),
  ...(unit.restart === undefined
    ? []
    : [
        '--property=Restart=always',
        `--property=RestartSec=${unit.restart.delaySec}`,
        `--property=StartLimitBurst=${unit.restart.burst}`,
        `--property=StartLimitIntervalSec=${unit.restart.intervalSec}`,
      ]),
  ...(unit.credentials ?? []).map(
    credential => `--property=LoadCredential=${credential.name}:${credential.path}`,
  ),
  ...(unit.confine === undefined ? [] : confinementArgs(unit.confine)),
  ...(unit.description === undefined ? [] : [`--description=${unit.description}`]),
  ...(unit.logFile === undefined
    ? []
    : [
        `--property=StandardOutput=append:${unit.logFile}`,
        `--property=StandardError=append:${unit.logFile}`,
      ]),
  ...unsetArgs(unit, inherited),
  ...Object.entries(unit.env ?? {}).map(([k, v]) => `--setenv=${k}=${v}`),
  '--',
  ...unit.argv,
]

/**
 * Unset each name of the user manager's environment but those the unit sets
 * itself: systemd unsets last, after `--setenv` has set them.
 */
const unsetArgs = (unit: Unit, inherited: readonly string[]): Array<string> => {
  const unset = inherited.filter(name => !Object.hasOwn(unit.env ?? {}, name))
  return unset.length === 0 ? [] : [`--property=UnsetEnvironment=${unset.join(' ')}`]
}

/**
 * The names in the user manager's environment, or `undefined` if it cannot
 * be read.
 */
const managerEnvironment = Effect.fnUntraced(
  function* (systemctl: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(
      ChildProcess.make(systemctl, ['--user', 'show-environment'], {
        extendEnv: true,
        stderr: 'ignore',
        stdin: 'ignore',
        stdout: 'pipe',
      }),
    )
    const text = yield* handle.stdout.pipe(Stream.decodeText, Stream.mkString)
    if ((yield* handle.exitCode) !== 0) return undefined
    // One variable a line: a value with a newline in it is printed escaped.
    return Str.split(text, '\n')
      .filter(line => line.includes('='))
      .map(line => line.slice(0, line.indexOf('=')))
  },
  Effect.scoped,
  Effect.orElseSucceed(() => undefined),
)

/**
 * Start `unit`, with none of the user manager's environment.
 *
 * That environment is whatever the user's session put there — a token
 * exported at login, a proxy and the certificates to trust behind it, an
 * agent's socket — and every unit the manager starts would otherwise inherit
 * all of it. It is read at each start, so a unit igloo starts unsets what the
 * manager holds then. A unit systemd starts again on its own, to restart it,
 * unsets the same names, so a variable the manager has gained since reaches
 * it.
 */
export const start = Effect.fnUntraced(function* (
  programs: { readonly systemctl: string; readonly systemdRun: string },
  unit: Unit,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const inherited = yield* managerEnvironment(programs.systemctl)
  if (inherited === undefined) {
    return yield* new SystemdError({
      message: "cannot read the user manager's environment, which the unit would inherit",
      unit: unit.name,
    })
  }
  const code = yield* spawner
    .exitCode(
      ChildProcess.make(programs.systemdRun, startArgs(unit, inherited), {
        extendEnv: true,
        stderr: 'inherit',
        stdin: 'ignore',
        stdout: 'ignore',
      }),
    )
    .pipe(Effect.orElseSucceed(() => 127))
  if (code !== 0) {
    return yield* new SystemdError({
      message: `systemd-run exited ${code}`,
      unit: unit.name,
    })
  }
})

/**
 * Read properties of a unit or slice, as a map from property name to raw value.
 *
 * `systemctl show` answers for a unit that was never loaded too, filling every
 * property with a default, so the result says nothing about whether the unit
 * exists — read `ActiveState` for that. Unset numeric properties come back as
 * `[not set]` rather than empty, which is why values stay strings here and the
 * caller decides what is missing.
 *
 * `--timestamp=unix` because the default rendering is a localised date that
 * would have to be parsed back; this gives `@<seconds>`.
 */
export const show = Effect.fnUntraced(function* (
  systemctl: string,
  unit: string,
  properties: readonly string[],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const out = yield* spawner
    .string(
      ChildProcess.make(
        systemctl,
        ['--user', 'show', unit, '--timestamp=unix', ...properties.map(p => `--property=${p}`)],
        { extendEnv: true },
      ),
    )
    .pipe(Effect.orElseSucceed(() => ''))

  const values = new Map<string, string>()
  for (const line of Str.split(out, '\n')) {
    const split = line.indexOf('=')
    if (split > 0) values.set(line.slice(0, split), line.slice(split + 1))
  }
  return values
})

/**
 * Names of the loaded slices one level under `<prefix>`, `.slice` suffix
 * included.
 *
 * The glob needs the separator — `<prefix>-*` — so the parent `<prefix>.slice`
 * that systemd creates implicitly is not among them. A slice with no members
 * left is usually unloaded rather than listed, but `--all` means a lingering one
 * does appear, so a caller cannot read presence here as "running".
 */
export const listSlices = Effect.fnUntraced(function* (systemctl: string, prefix: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const out = yield* spawner
    .string(
      ChildProcess.make(
        systemctl,
        ['--user', 'list-units', '--all', '--plain', '--no-legend', `${prefix}-*.slice`],
        { extendEnv: true },
      ),
    )
    .pipe(Effect.orElseSucceed(() => ''))

  return Str.split(out, '\n')
    .map(line => Str.trim(line).split(/\s+/)[0] ?? '')
    .filter(unit => unit.endsWith('.slice'))
})

/**
 * Each unit's activation state, in the order given.
 *
 * `systemctl is-active` takes several units and prints a line per unit, so
 * polling a set of them costs one spawn rather than one each. Its exit code is
 * zero only when every unit is active, which says less than the output does —
 * including for a unit that never existed.
 *
 * A call that fails outright yields an empty list rather than a list of
 * unknowns, so a caller reading this as liveness cannot turn a broken
 * `systemctl` into a report that something died.
 */
export const activeStates = Effect.fnUntraced(function* (
  systemctl: string,
  units: readonly string[],
) {
  if (units.length === 0) return [] as Array<string>
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const out = yield* spawner
    .string(ChildProcess.make(systemctl, ['--user', 'is-active', ...units], { extendEnv: true }))
    .pipe(Effect.orElseSucceed(() => ''))
  return Str.split(out, '\n')
    .map(line => Str.trim(line))
    .filter(line => line !== '')
})

/** The unit's activation state, or `''` if it cannot be determined. */
export const activeState = Effect.fnUntraced(function* (systemctl: string, unit: string) {
  return (yield* activeStates(systemctl, [unit]))[0] ?? ''
})

/**
 * Whether any loaded unit matching `pattern` is active.
 *
 * A pattern rather than a name, for a caller that knows the shape of a VM's
 * units but neither how many there are nor what each is called — which is the
 * position anything enumerating VMs is in, since the set follows from the
 * runner rather than from the caller.
 */
export const anyActive = Effect.fnUntraced(function* (systemctl: string, pattern: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const out = yield* spawner
    .string(
      ChildProcess.make(
        systemctl,
        ['--user', 'list-units', '--plain', '--no-legend', '--state=active', pattern],
        { extendEnv: true },
      ),
    )
    .pipe(Effect.orElseSucceed(() => ''))
  return Str.split(out, '\n').some(line => Str.trim(line) !== '')
})

export const isActive = Effect.fnUntraced(function* (systemctl: string, unit: string) {
  return (yield* activeState(systemctl, unit)) === 'active'
})

/**
 * Whether the unit has stopped for good.
 *
 * Deliberately not `!isActive`: a unit is briefly `activating` before it runs
 * and `deactivating` while it stops, and treating either as "gone" turns a
 * normal startup into a spurious "it exited" the caller then reports.
 */
export const hasExited = Effect.fnUntraced(function* (systemctl: string, unit: string) {
  const state = yield* activeState(systemctl, unit)
  return state === 'inactive' || state === 'failed'
})

/**
 * Stop every unit in the slice. This is the whole teardown: systemd kills the
 * cgroup, which reaches processes that changed their process group or were
 * double-forked away from their launcher.
 */
export const stopSlice = (systemctl: string, slice: string) => stop(systemctl, `${slice}.slice`)

/** Stop one unit, and with it every process in its cgroup. Never fails. */
export const stop = Effect.fnUntraced(function* (systemctl: string, unit: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  yield* spawner
    .exitCode(
      ChildProcess.make(systemctl, ['--user', 'stop', unit], {
        extendEnv: true,
        stderr: 'ignore',
        stdin: 'ignore',
        stdout: 'ignore',
      }),
    )
    .pipe(Effect.ignore)
})

/**
 * Resolve once the unit has stopped, or `false` if it is still up once `within`
 * has passed. Bounded by wall clock rather than by a count of checks, each of
 * which is a `systemctl` that takes as long as it takes.
 */
export const awaitInactive = (
  systemctl: string,
  unit: string,
  within: Duration.Input,
): Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.timeoutOrElse(
    Effect.gen(function* () {
      while (!(yield* hasExited(systemctl, unit))) yield* Effect.sleep('250 millis')
      return true
    }),
    { duration: within, orElse: () => Effect.succeed(false) },
  )
