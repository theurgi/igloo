import type { Binaries } from './Binaries.ts'
import type { Grant, TunnelScope } from './broker.ts'

import { Clock, Duration, Effect, FileSystem, Result, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { dirname } from 'node:path'

import * as BootLog from './BootLog.ts'
import {
  connectPorts,
  runsTunnel,
  tlsCertificateCredential,
  tlsKeyCredential,
  tlsNames,
} from './broker.ts'
import * as BuildPlan from './BuildPlan.ts'
import * as Evaluation from './Evaluation.ts'
import * as LaunchInputs from './LaunchInputs.ts'
import * as NixLog from './NixLog.ts'
import * as Project from './Project.ts'
import * as Qmp from './Qmp.ts'
import * as Secrets from './Secrets.ts'
import * as StoreView from './StoreView.ts'
import * as Systemd from './Systemd.ts'
import * as Virtiofs from './Virtiofs.ts'

// The field is `message` rather than a more descriptive name so that it lands
// in `Error.message`, which is the line the CLI prints for a failure.
export class VmError extends Schema.TaggedError<VmError>()('VmError', {
  /**
   * The directory of the launch that failed, set only when the message does not
   * already name a file inside it.
   */
  bootRecord: Schema.optionalKey(Schema.String),
  message: Schema.String,
}) {}

/**
 * The least that identifies an existing VM: enough to find its units and the
 * files they were started against. Tearing one down needs no more than this,
 * which is what lets `down` reach a VM this process did not start.
 */
export interface VmTarget {
  /**
   * `<label>-<cid in hex>`, naming the slice and both units. The CID is in it so
   * that a running VM's CID can be read back off its own slice name; the label
   * alone would not be unique, and two projects sharing a slice means one
   * project's `up` finding the other's VM and reporting success.
   */
  readonly id: string
  /**
   * The units' working directory, because QEMU and the virtio-fs daemons
   * address each other through vhost-user sockets named relative to it, and
   * QEMU binds its control socket here too. What lives here is what a running
   * VM needs and nothing durable: the sockets, the credentials, and the list of
   * paths the store's daemon serves. Everything durable is in the project.
   */
  readonly runtimeDir: string
}

/**
 * One published port: a host port that reaches a guest port.
 *
 * Two numbers rather than one because they are scarce in different ways. A
 * guest port belongs to the project and is whatever its dev server uses; a host
 * port is shared with every other VM and every other program on the machine, so
 * two projects whose servers both listen on 5173 need somewhere to put the
 * second one.
 */
export interface Publication {
  readonly guest: number
  readonly host: number
}

export interface VmSpec extends VmTarget {
  /**
   * gc-root symlink pinning the closure this VM runs from: the build's
   * `--out-link`, in the project.
   */
  readonly runnerRootLink: string
  /**
   * Whether this VM gets a broker, and with it the tether that is the only way
   * to reach one.
   *
   * Stated rather than defaulted: a VM that silently acquired a
   * credential-holding process because of someone else's setting is the
   * wrong direction for this to fail in.
   */
  readonly broker: boolean
  /** Guest CID. At least 3, and unique among VMs running concurrently. */
  readonly cid: number
  /**
   * Credentials the broker holds, which never enter the guest. Same shape as
   * the delivered ones and fetched by the same code — what differs is only who
   * reads the file: systemd's `LoadCredential=` rather than QEMU's `fw_cfg`.
   */
  readonly brokered: readonly Secrets.Delivery[]
  /**
   * The most memory the broker may use, in MiB, or `undefined` for no bound.
   * Policy, from the user layer alone.
   */
  readonly brokerMem: number | undefined
  /**
   * What the broker may do with the credentials it holds: one grant per brokered
   * credential, naming the profile and what that profile may reach.
   *
   * Separate from `brokered` because the two have different exposure. A grant is
   * names — of a profile, a credential and some repositories — and it travels on
   * the broker's command line, where anything that can read `/proc` sees it. A
   * value never goes near that path.
   */
  readonly grants: readonly Grant[]
  /**
   * The certificate and key the broker answers its TLS names with, as host
   * paths, for a VM whose grants give it any. Each reaches the broker by
   * `LoadCredential=`, as a brokered credential does.
   */
  readonly brokerTls: { readonly certificate: string; readonly key: string } | undefined
  /**
   * Where the guest may tunnel to: the hosts listed, already bounded by the user
   * layer's ceiling, or any public name.
   *
   * Names, not credentials. With the names the broker answers, this decides
   * whether the tunnel listener runs at all, whether the tether opens its
   * second forward, and what `HTTPS_PROXY` in the guest points at: an empty
   * list and no such name means none of the three.
   */
  readonly tunnel: TunnelScope
  /**
   * Credentials to place in the guest's runtime storage. Declarations, not
   * values: the values are fetched on the launch path and only there, so a
   * second `attach` to a running VM never re-prompts for a passphrase.
   */
  readonly credentials: readonly Secrets.Delivery[]
  /**
   * What evaluating the runner may read and fetch. The evaluation runs the
   * content layers, which is Nix someone other than igloo wrote, so it is
   * confined to these and the flake's own inputs.
   */
  readonly evaluation: Evaluation.Allowance
  /** Flake reference of the runner derivation, e.g. `path:/srv/igloo#testVm`. */
  readonly flakeRef: string
  /**
   * The host directories the guest can write — its workspace and its home. No
   * credential's source may lie in one.
   */
  readonly guestWritable: readonly string[]
  /** Private key matching the runner's baked-in authorized key. */
  readonly identityFile: string
  /** For messages. `id` is what addresses anything. */
  readonly label: string
  /**
   * A hash per input this VM is being launched from, already computed: the
   * generated flake, igloo's own flake and lock, each content layer, and the
   * launch-time policy that reaches no file. Recorded after a build, and
   * compared against that record by a launch that finds the VM already up —
   * which is the only way such a launch can report that the guest is running
   * older configuration than what is on disk.
   *
   * Hashed by the caller rather than here, because the caller is what knows the
   * set. One input missing is one whose edit is never reported.
   */
  readonly launchInputs: Readonly<Record<string, string>>
  /** Where `launchInputs` is recorded, after a build. */
  readonly launchInputsFile: string
  /**
   * Durable directory holding one directory per boot: the units' logs, the
   * trail and the summary. Every launch makes a new one and repoints `latest`.
   */
  readonly logDir: string
  /**
   * Guest ports to publish on the host's loopback, and the host port each one
   * gets. Empty for a VM that publishes nothing, which is the default: a port
   * is reachable because a project asked for it and for no other reason.
   */
  readonly ports: readonly Publication[]
  /**
   * The project this VM belongs to, recorded on the QEMU unit so a running VM
   * says where it came from. Everything `down` needs is reachable from it, which
   * is what lets `down --all` stop a VM it knows only by slice name.
   */
  readonly projectRoot: string
  /**
   * The project's directories the guest mounts, by tag: the shares the runner
   * has to declare beside the store's. The launch refuses a runner that
   * declares any other.
   */
  readonly shares: readonly Virtiofs.Expected[]
  /**
   * Environment for the VM's units. A transient unit does not inherit the
   * caller's environment, so anything a unit needs has to be carried here.
   */
  readonly unitEnv: Record<string, string>
  /** The invoking user's ids, which every unit runs as. */
  readonly owner: { readonly gid: number; readonly uid: number }
  /**
   * Threads each virtio-fs daemon may use, normally the host's CPU count. A
   * value rather than something read here, so the launch sequence stays
   * testable — and because the daemon serving the store cannot resolve it for
   * itself inside its own namespace.
   */
  readonly virtiofsdThreads: number
}

/** Every unit and slice this tool creates sits under this name. */
const prefix = 'igloo'

// `-` is a hierarchy separator in a *slice* name but not in a service name, so
// only the slice's component is escaped.
const qemuUnit = (id: string): string => `${prefix}-${id}-qemu.service`
const brokerUnit = (id: string): string => `${prefix}-${id}-broker.service`
const tetherUnit = (id: string): string => `${prefix}-${id}-tether.service`
const portsUnit = (id: string): string => `${prefix}-${id}-ports.service`
const virtiofsdUnit = (id: string, tag: string): string =>
  `${prefix}-${id}-virtiofsd-${tag}.service`
/** Every daemon of one VM, for a caller that does not know the share tags. */
const virtiofsdUnits = (id: string): string => `${prefix}-${id}-virtiofsd-*.service`
const slice = (id: string): string => `${prefix}-${Systemd.escapeSliceComponent(id)}`

/**
 * The QEMU unit's description, which is where a running VM carries its project
 * root — the only string systemd will hold on a transient unit for us.
 *
 * Always tagged and always set: `systemd-run` fills an absent description with
 * `[systemd-run] <command line>`, so there is no value that means "nothing was
 * recorded" unless we define one. Everything after the first `:` is the path, so
 * a path containing `:` still round-trips.
 */
const describe = (projectRoot: string): string => `igloo:${projectRoot}`

/**
 * QEMU's QMP socket, as `mkRunner` names it in `microvm.socket`: bound in
 * QEMU's working directory, which is the runtime directory.
 */
const controlSocket = 'control.socket'

const projectFromDescription = (description: string | undefined): string | undefined => {
  if (description === undefined || !description.startsWith('igloo:')) return undefined
  const root = description.slice('igloo:'.length)
  return root === '' ? undefined : root
}

const note = (message: string): Effect.Effect<void> =>
  Effect.sync(() => process.stderr.write(`igloo: ${message}\n`))

/**
 * The same, and into the boot's trail — so the record reads as the account of a
 * launch rather than as timings with no narrative.
 *
 * `credentials` are the names the message lists, recorded as a field of their
 * own so that `igloo report` finds them by what they are rather than in a
 * sentence.
 */
const noted = (
  boot: BootLog.Boot,
  message: string,
  credentials?: readonly string[],
): Effect.Effect<void> =>
  note(message).pipe(
    Effect.andThen(
      boot.record({
        ...(credentials === undefined ? {} : { credentials }),
        event: 'note',
        message,
      }),
    ),
  )

/**
 * `proxy` is `systemd-ssh-proxy`, and `guest` the VM to reach and the key to
 * reach it with. `options` are ssh's own flags; `command` is what to run in the
 * guest.
 *
 * They are separate parameters because ssh takes the **first non-option
 * argument** as the destination. A remote command placed before the
 * destination silently becomes the destination, and the real destination
 * becomes the command — which fails as an unreachable host rather than as a
 * usage error.
 */
export const sshArgs = (
  proxy: string,
  guest: { readonly cid: number; readonly identityFile: string },
  options: readonly string[],
  command: readonly string[] = [],
): Array<string> => [
  // `-F /dev/null` so the connection does not depend on the host's ssh_config,
  // which also drops the `Host vsock/*` stanza's defaults — hence the explicit
  // `User`.
  '-F',
  '/dev/null',
  '-o',
  `ProxyCommand=${proxy} %h %p`,
  '-o',
  'ProxyUseFdpass=yes',
  '-o',
  'User=root',
  // The transport is a vsock to a VM this process just launched, so there is no
  // third party a host key could distinguish.
  '-o',
  'StrictHostKeyChecking=no',
  '-o',
  'UserKnownHostsFile=/dev/null',
  '-o',
  'LogLevel=ERROR',
  '-i',
  guest.identityFile,
  ...options,
  `vsock/${guest.cid}`,
  ...command,
]

/**
 * What a forwarding ssh session declines to offer, shared by both of them.
 *
 * Guest root owns the guest's sshd, so these are clients connecting to a server
 * the other side controls. The options are mostly about what the session
 * refuses rather than about reaching it — no multiplexing, no agent, no X11, no
 * local command, and no identity but the one named. One list rather than two
 * because a hardening option added to one forward and not the other is the
 * difference nobody notices.
 *
 * `ExitOnForwardFailure=yes` is the load-bearing one: without it a port that
 * cannot be bound leaves ssh connected and forwarding nothing, so the VM comes
 * up with the forward silently missing and nothing reports it.
 *
 * The keepalives bound how long a silent peer goes unnoticed. A session whose
 * far end has stopped servicing its forward otherwise holds an established
 * socket indefinitely, and the restart that would fix it never triggers.
 */
const forwardOptions: ReadonlyArray<string> = [
  '-o',
  'ExitOnForwardFailure=yes',
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none',
  '-o',
  'ForwardAgent=no',
  '-o',
  'ForwardX11=no',
  '-o',
  'PermitLocalCommand=no',
  '-o',
  'IdentitiesOnly=yes',
  '-o',
  'BatchMode=yes',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=3',
]

/**
 * ssh's own flags for the tether: a remote forward from the guest's loopback to
 * the broker's socket on the host.
 */
export const tetherOptions = (spec: VmSpec): Array<string> => [
  '-N',
  '-R',
  `127.0.0.1:${brokerGuestPort}:${brokerSocket(spec)}`,
  // A second forward for the tunnel, on its own port, and only when the VM has
  // somewhere to tunnel to or a name the broker answers. `ExitOnForwardFailure=yes`
  // covers both: if either port is taken in the guest, the unit fails rather
  // than coming up with one of the two silently missing.
  ...(runsTunnel(spec.grants, spec.tunnel)
    ? ['-R', `127.0.0.1:${proxyGuestPort}:${proxySocket(spec)}`]
    : []),
  ...forwardOptions,
]

/**
 * ssh's own flags for the published ports: a local forward per port, from the
 * host's loopback to the same address inside the guest.
 *
 * Both ends are `127.0.0.1` and they are different machines' loopbacks. The
 * host end is the bind, so nothing off this machine reaches a published port.
 * The guest end is resolved by the guest's sshd, so a server listening on the
 * guest's own loopback is reachable — a dev server does **not** have to bind
 * `0.0.0.0` the way it would behind a container's network namespace.
 */
export const portsOptions = (spec: VmSpec): Array<string> => [
  '-N',
  ...spec.ports.flatMap(port => [
    '-L',
    `127.0.0.1:${String(port.host)}:127.0.0.1:${String(port.guest)}`,
  ]),
  ...forwardOptions,
]

/** The programs a forward's unit runs, each by a path that exists inside it. */
export interface ForwardPrograms {
  /** `igloo-landlock`, which the published ports run under. */
  readonly landlock: string
  /** `systemd-ssh-proxy`, ssh's `ProxyCommand`. */
  readonly proxy: string
  /**
   * What ssh runs its `ProxyCommand` through, as `$SHELL`. The one a unit
   * inherits from the user manager is a path outside the store.
   */
  readonly shell: string
  readonly ssh: string
}

/**
 * The name a forward's unit is handed the project's key under.
 *
 * A credential rather than a path into the project, so that nothing of the
 * project or the home directory is in the unit's root: systemd reads the file
 * before the sandbox exists and gives the unit a copy in a directory of its
 * own. ssh finds it through `${CREDENTIALS_DIRECTORY}`, which systemd expands in
 * the command line as it starts the unit.
 */
const identityCredential = 'identity'

/** ssh as a forward's unit runs it, by its programs' own paths and the key it is handed. */
const forwardSsh = (
  programs: ForwardPrograms,
  spec: VmSpec,
  options: readonly string[],
): [string, ...string[]] => [
  programs.ssh,
  ...sshArgs(
    programs.proxy,
    { cid: spec.cid, identityFile: `\${CREDENTIALS_DIRECTORY}/${identityCredential}` },
    options,
  ),
]

/** The tether's command line. */
export const tetherArgv = (programs: ForwardPrograms, spec: VmSpec): [string, ...string[]] =>
  forwardSsh(programs, spec, tetherOptions(spec))

/**
 * The published ports' command line.
 *
 * Under `igloo-landlock`, because its unit keeps the host's network, and with it
 * every service the user has listening on loopback and every abstract socket.
 * It may bind the ports it publishes and no others, and make no TCP connection
 * at all: its one connection, to the guest, is the vsock its proxy hands back.
 * A listen on a socket it never bound still gets a port the kernel picks, which
 * Landlock does not see.
 */
export const portsArgv = (programs: ForwardPrograms, spec: VmSpec): [string, ...string[]] => [
  programs.landlock,
  ...spec.ports.flatMap(port => ['--bind-tcp', String(port.host)]),
  '--',
  ...forwardSsh(programs, spec, portsOptions(spec)),
]

/**
 * A program by the path behind every symlink, found on `PATH` if it is a bare
 * name. A forward's unit sees the store and little else, and the names a host
 * gives its programs — `/run/current-system/sw/...`, `/bin/sh` — are links into
 * the store from outside it.
 */
const located = Effect.fnUntraced(function* (program: string, PATH: string) {
  const fs = yield* FileSystem.FileSystem
  const found = program.includes('/') ? program : Bun.which(program, { PATH })
  if (found === null) return yield* new VmError({ message: `${program} is not on PATH` })
  return yield* fs
    .realPath(found)
    .pipe(Effect.mapError(() => new VmError({ message: `${program} does not exist` })))
})

/**
 * The programs a forward's unit runs, found where the launch's own `PATH` would
 * find them. The shell is `/bin/sh`, which is what ssh itself runs when
 * `$SHELL` is unset.
 */
const forwardPrograms = (bins: Binaries, spec: VmSpec) => {
  const PATH = spec.unitEnv['PATH'] ?? ''
  return Effect.all({
    landlock: located(bins.landlock, PATH),
    proxy: located(bins.sshProxy, PATH),
    shell: located('/bin/sh', PATH),
    ssh: located(bins.ssh, PATH),
  })
}

/**
 * The unit a forward runs as, confined as a `Systemd.Forwarder` to the store,
 * `readable`, the user database — ssh will not start without its own entry —
 * and any of its programs that `Binaries` names outside the store, which then
 * has to need nothing else from outside it.
 *
 * Bound to QEMU's unit, so a forward cannot outlive the guest it reaches into,
 * and its restart cannot re-attach it to a VM that is gone.
 */
const forwardUnit = (
  programs: ForwardPrograms,
  spec: VmSpec,
  forward: {
    readonly argv: readonly [string, ...string[]]
    readonly hostNetwork: boolean
    readonly logFile: string
    readonly name: string
    readonly readable: readonly string[]
  },
): Systemd.Unit => ({
  argv: forward.argv,
  boundTo: [qemuUnit(spec.id)],
  confine: {
    kind: 'forwarder',
    hostNetwork: forward.hostNetwork,
    readable: [
      '/etc/passwd',
      ...forward.readable,
      ...Object.values(programs).filter(path => !path.startsWith(`${StoreView.storeDir}/`)),
    ],
  },
  credentials: [{ name: identityCredential, path: spec.identityFile }],
  env: { ...spec.unitEnv, SHELL: programs.shell },
  logFile: forward.logFile,
  name: forward.name,
  // A dropped connection should come back; a forward that cannot bind, its
  // port taken in the guest or on the host, should not be retried forever.
  restart: { burst: 5, delaySec: 2, intervalSec: 60 },
  slice: slice(spec.id),
  // Its own root: the runtime directory, where the other units work, is not in
  // it.
  workingDirectory: '/',
})

/**
 * The runner's derivation, from the one evaluation of the layers a launch makes.
 *
 * Everything after this works from the `.drv` it returns: the check of what the
 * build would run, and the build itself. Evaluating again for the build would
 * let the workspace change in between, and build something nobody checked.
 *
 * `--no-write-lock-file` is not optional. The generated flake takes igloo as a
 * `path:` input, which from a checkout is a directory that changes; a lock file
 * would freeze it to a copy of the tree, so the next launch would build a
 * version of the tool that is no longer the one running.
 *
 * The evaluation is confined to `spec.evaluation`, because it runs the content
 * layers' Nix as the caller before any VM exists. nix's stderr is inherited, so
 * an error in a layer is already the message above the one this returns, and
 * `log` is what also sends it to the boot record.
 */
const instantiate = Effect.fnUntraced(
  function* (bins: Binaries, spec: VmSpec, log: readonly string[]) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(
      yield* Evaluation.command(bins, spec.evaluation, [
        'path-info',
        '--derivation',
        spec.flakeRef,
        '--no-write-lock-file',
        ...log,
      ]),
    )
    const printed = yield* handle.stdout.pipe(Stream.decodeText, Stream.mkString)
    const code = yield* handle.exitCode
    if (code !== 0) {
      return yield* new VmError({ message: `evaluating the layers failed: nix exited ${code}` })
    }
    const drvPath = printed.trim()
    if (!/^\/nix\/store\/[^/\s]+\.drv$/.test(drvPath)) {
      return yield* new VmError({ message: 'nix path-info --derivation printed no derivation' })
    }
    return drvPath
  },
  Effect.scoped,
  Effect.catchTag('PlatformError', () =>
    Effect.fail(new VmError({ message: 'cannot run nix to evaluate the layers' })),
  ),
)

/**
 * Build the derivation `instantiate` returned and the check passed, leaving
 * `--out-link` on the project's gc-root.
 *
 * The root has to outlive both the build and this process: while the VM runs, a
 * concurrent `nix-collect-garbage` would otherwise be free to delete the store
 * paths it is running from, and a root that only lasted as long as the CLI would
 * leave a warm second boot — which skips the build — pinned by nothing at all.
 * `--out-link` on the same path re-pins in place, so it cannot accumulate.
 *
 * `fallback` is off whatever the host sets. The check let a fixed output through
 * because it would be fetched rather than built; with fallback on, a fetch that
 * failed would run its builder after all, with the network.
 *
 * nix's output is inherited rather than captured — it is the only progress
 * indication a first build gives, and on failure it is already the error
 * message. `log` is what also sends that message to the boot record.
 */
const build = Effect.fnUntraced(function* (
  bins: Binaries,
  spec: VmSpec,
  drvPath: string,
  log: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const code = yield* spawner
    .exitCode(
      ChildProcess.make(
        bins.nix,
        [
          'build',
          `${drvPath}^*`,
          '--option',
          'fallback',
          'false',
          '--out-link',
          spec.runnerRootLink,
          ...log,
        ],
        {
          extendEnv: true,
          stderr: 'inherit',
          stdin: 'ignore',
          stdout: 'ignore',
        },
      ),
    )
    .pipe(Effect.orElseSucceed(() => 127))
  if (code !== 0) {
    return yield* new VmError({ message: `nix build exited ${code}` })
  }
  return yield* fs
    .realPath(spec.runnerRootLink)
    .pipe(Effect.mapError(() => new VmError({ message: `no runner at ${spec.runnerRootLink}` })))
})

/** Where one share's daemon appends its output. */
const daemonLog = (boot: BootLog.Boot, tag: string): string => boot.file(`virtiofsd-${tag}.log`)

/**
 * Where delivered credentials are written for QEMU to read.
 *
 * Under the runtime directory because that is a tmpfs: no copy reaches the
 * project, which is on disk and is the kind of directory that ends up in a
 * backup. Removed when the VM stops.
 */
const credentialsDir = (target: VmTarget): string => `${target.runtimeDir}/credentials`

/**
 * The guest-side port the tether binds, and the address anything in the guest
 * uses to reach the broker.
 *
 * Fixed rather than derived from the VM: it ends up in the guest's environment
 * as a proxy setting, and a port that moved between boots would have to be
 * rewritten there on every one.
 */
export const brokerGuestPort = 3128

/**
 * The guest-side port for the tunnel, and what `HTTPS_PROXY` names.
 *
 * Separate from the broker's because what is reachable there is different: the
 * broker constructs every upstream request it makes, while the tunnel carries
 * bytes it cannot inspect and polices only the destination. Two ports make that
 * difference visible from inside the guest.
 */
export const proxyGuestPort = 3129

/**
 * The broker's own runtime directory, and everything in it.
 *
 * A sibling of the VM's rather than a child, so that it is not in QEMU's view,
 * which is the VM's directory, writable.
 *
 * It holds the listening socket and nothing else. The guest reaches that socket
 * only through a forward the host opened, so there is no host listener for
 * another VM to find, and it is gone when this VM stops.
 */
const brokerDir = (target: VmTarget): string => `${target.runtimeDir}-broker`

const brokerSocket = (target: VmTarget): string => `${brokerDir(target)}/http.sock`

/**
 * The tunnel's socket, beside the broker's and not the same one, for the reason
 * the two have separate guest ports (`proxyGuestPort`).
 */
const proxySocket = (target: VmTarget): string => `${brokerDir(target)}/proxy.sock`

/**
 * The TLS listener's socket. Nothing forwards to it: the tunnel hands it the
 * connections to the names it answers, and nothing else reaches it.
 */
const tlsSocket = (target: VmTarget): string => `${brokerDir(target)}/tls.sock`

/**
 * Where a brokered credential's value is written for systemd to read.
 *
 * Under the VM's runtime directory, which is exactly what the broker cannot
 * see: `LoadCredential=` is read by the user manager before the unit's sandbox
 * exists, so the broker receives the value without the file ever being
 * reachable from inside it.
 *
 * QEMU's unit sees the rest of that directory and has this one hidden. A path
 * that does not exist when a unit starts cannot be hidden from it, so this is
 * created, and written, before QEMU starts.
 */
const brokerCredentialsDir = (target: VmTarget): string => `${target.runtimeDir}/broker-credentials`

/**
 * Remove a directory and everything in it, or fail naming it.
 *
 * For the runtime directory and the broker's. QEMU and the broker write into
 * them as the user, so either can take the user's write permission away from a
 * directory there, and a directory at mode 0500 stops a removal part of the
 * way, leaving what may be a link placed where a launch is about to write. A
 * removal that fails is tried again once the user has every permission on each
 * directory left, and a directory that survives that is not reused.
 */
const removeAll = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem
  const removal = fs.remove(dir, { force: true, recursive: true })
  if (Result.isSuccess(yield* Effect.result(removal))) return
  yield* restoreOwnerAccess(dir)
  yield* removal.pipe(
    Effect.mapError(
      () =>
        new VmError({
          message: `cannot remove ${dir}, which a VM's units wrote into, and a launch will not start from what is left in it`,
        }),
    ),
  )
})

/**
 * Give the owner every permission on `dir` and each directory under it, and
 * follow no link to do it: `chmod` changes what a link points at, which may be
 * any file of the user's.
 */
const restoreOwnerAccess = Effect.fnUntraced(function* (
  dir: string,
): Effect.fn.Return<void, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem
  if (Result.isSuccess(yield* Effect.result(fs.readLink(dir)))) return
  const info = yield* Effect.result(fs.stat(dir))
  if (Result.isFailure(info) || info.success.type !== 'Directory') return
  yield* fs.chmod(dir, 0o700).pipe(Effect.ignore)
  const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))
  for (const entry of entries) yield* restoreOwnerAccess(`${dir}/${entry}`)
})

/**
 * Check `ready` every `every` until it holds. Fail with what `failed` answers as
 * soon as it answers anything, and with `timedOut` once `within` has passed.
 *
 * Bounded by wall clock rather than by a count of checks: a check that is slow
 * rather than refused would otherwise stretch the budget by however long each
 * one takes. `failed` is asked every round because the usual failure is a unit
 * that exited, and a wait that does not look for one sits out its whole budget
 * and then blames whatever it waited on for being slow, which sends the reader
 * to the wrong log.
 */
const waitUntil = <R>(options: {
  readonly every: Duration.Input
  readonly failed: Effect.Effect<VmError | undefined, never, R>
  readonly ready: Effect.Effect<boolean, never, R>
  readonly timedOut: VmError
  readonly within: Duration.Input
}): Effect.Effect<void, VmError, R> =>
  Effect.timeoutOrElse(
    Effect.gen(function* () {
      for (;;) {
        if (yield* options.ready) return
        const failure = yield* options.failed
        if (failure !== undefined) return yield* failure
        yield* Effect.sleep(options.every)
      }
    }),
    { duration: options.within, orElse: () => Effect.fail(options.timedOut) },
  )

/** `failure` if `unit` has exited, for `waitUntil`'s `failed`. */
const ifExited = (
  bins: Binaries,
  unit: string,
  failure: VmError,
): Effect.Effect<VmError | undefined, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Systemd.hasExited(bins.systemctl, unit).pipe(Effect.map(exited => (exited ? failure : undefined)))

/**
 * Wait for every share's vhost-user socket to bind. QEMU connects to them
 * synchronously at startup and never retries, so starting it first loses the
 * race on most boots.
 */
const awaitSockets = Effect.fnUntraced(function* (
  bins: Binaries,
  spec: VmSpec,
  boot: BootLog.Boot,
  shares: readonly Virtiofs.Share[],
) {
  const fs = yield* FileSystem.FileSystem
  const units = shares.map(share => virtiofsdUnit(spec.id, share.tag))
  return yield* waitUntil({
    every: '100 millis',
    // A daemon that will never bind is the common failure, and it names which
    // share it was — without that the reader has one symptom and three logs.
    failed: Systemd.activeStates(bins.systemctl, units).pipe(
      Effect.map(states => {
        const dead = states.findIndex(state => state === 'inactive' || state === 'failed')
        const tag = shares[dead]?.tag
        return tag === undefined
          ? undefined
          : new VmError({
              message: `virtiofsd for the ${tag} share exited during startup; see ${daemonLog(boot, tag)}, and \`igloo doctor\``,
            })
      }),
    ),
    // An unreadable runtime directory counts as "not yet": the wait is bounded
    // anyway, and the daemons' states are what report a real failure.
    ready: Effect.forEach(shares, share =>
      fs.exists(`${spec.runtimeDir}/${share.socket}`).pipe(Effect.orElseSucceed(() => false)),
    ).pipe(Effect.map(bound => bound.every(Boolean))),
    timedOut: new VmError({
      message: `virtiofsd bound no vhost-user socket within 15s; see ${boot.dir}/virtiofsd-*.log, and \`igloo doctor\``,
    }),
    within: '15 seconds',
  })
})

/**
 * Wait until the management channel answers.
 *
 * A vsock connect cannot succeed before the guest is listening, so connecting
 * *is* the readiness signal — there is no accept-and-hold stage to produce a
 * false positive the way a forwarded TCP port does. Running the whole ssh
 * rather than probing the socket also proves the thing the caller actually
 * needs: that the channel authenticates and carries a command.
 */
const awaitReady = Effect.fnUntraced(function* (bins: Binaries, spec: VmSpec, boot: BootLog.Boot) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* waitUntil({
    every: '1 second',
    // A guest that will never answer is the common failure, and QEMU reports it
    // by exiting — no `/dev/vhost-vsock`, a CID already in use, a kernel panic.
    failed: ifExited(
      bins,
      qemuUnit(spec.id),
      new VmError({
        message: `QEMU exited during boot; see ${boot.file('serial.log')}, and \`igloo doctor\``,
      }),
    ),
    ready: spawner
      .exitCode(
        ChildProcess.make(
          bins.ssh,
          sshArgs(bins.sshProxy, spec, ['-o', 'BatchMode=yes'], ['true']),
          {
            extendEnv: true,
            stderr: 'ignore',
            stdin: 'ignore',
            stdout: 'ignore',
          },
        ),
      )
      .pipe(
        Effect.map(code => code === 0),
        Effect.orElseSucceed(() => false),
      ),
    timedOut: new VmError({
      message: 'guest did not answer on vsock within 90s; try `igloo doctor`',
    }),
    within: '90 seconds',
  })
})

/**
 * The broker's command line.
 *
 * The grants go here rather than into a file because `/proc/<pid>/cmdline` is
 * world-readable and this is the part that can stand being read: a profile name,
 * a credential's name, and the repositories it may fetch. The values arrive by
 * `LoadCredential=`, which is the reason no unit property can carry one.
 *
 * Under `igloo-landlock`, because the unit leaves it the host's network, and
 * with it every service the user has listening on loopback and every abstract
 * socket, a display server’s among them. It may connect over TCP to the ports
 * `connectPorts` names and to no others.
 *
 * Pure, so the argument the broker is actually started with is asserted rather
 * than assembled twice.
 */
export const brokerArgv = (bins: Binaries, spec: VmSpec): [string, ...string[]] => [
  bins.landlock,
  ...connectPorts(spec.grants).flatMap(port => ['--connect-tcp', String(port)]),
  '--',
  bins.broker,
  brokerSocket(spec),
  '--grants',
  JSON.stringify(spec.grants),
  // Only when there are destinations or names the broker answers: otherwise no
  // socket, no second forward, and no `HTTPS_PROXY` in the guest. The three are
  // set together, so a client is never pointed at a port nothing is listening
  // on — which would fail as a refused connection and read as a broken broker
  // rather than as an empty allowlist.
  ...(runsTunnel(spec.grants, spec.tunnel)
    ? ['--proxy', proxySocket(spec), '--tunnel', JSON.stringify(spec.tunnel)]
    : []),
  // Decided by the grants rather than by whether a certificate was passed, so
  // that a VM given none fails to start a broker, naming what is missing.
  ...(tlsNames(spec.grants).length > 0 ? ['--tls', tlsSocket(spec)] : []),
]

/**
 * Start the broker if it is not already up, and return once it is listening.
 * A no-op for a VM with no broker. Answers whether it started one.
 *
 * Readiness is the socket, not the unit: the tether forwards to that path, and
 * a forward opened before the socket exists gives the guest a port whose every
 * connection is refused.
 */
const ensureBroker = Effect.fnUntraced(function* (
  bins: Binaries,
  spec: VmSpec,
  boot: BootLog.Boot,
) {
  if (!spec.broker) return false
  const fs = yield* FileSystem.FileSystem

  // Every socket, because the tether forwards to two of them and the tunnel
  // hands the third its connections, and one reached before it exists refuses
  // every connection. The broker binds them in an order of its own, but waiting
  // on them all is what makes that ordering not matter.
  const wanted = [
    brokerSocket(spec),
    ...(runsTunnel(spec.grants, spec.tunnel) ? [proxySocket(spec)] : []),
    ...(tlsNames(spec.grants).length > 0 ? [tlsSocket(spec)] : []),
  ]

  // `activating` is a broker its unit is already starting again.
  const state = yield* Systemd.activeState(bins.systemctl, brokerUnit(spec.id))
  const started = state !== 'active' && state !== 'activating'
  if (started) {
    // A broker that was killed leaves its sockets behind, and they would read
    // as this one listening before it does.
    yield* Effect.forEach(wanted, socket => fs.remove(socket).pipe(Effect.ignore), {
      discard: true,
    })
    const PATH = spec.unitEnv['PATH'] ?? ''
    const programs = yield* Effect.all({
      broker: located(bins.broker, PATH),
      landlock: located(bins.landlock, PATH),
    })
    yield* Systemd.start(bins, {
      argv: brokerArgv({ ...bins, ...programs }, spec),
      // Bound to QEMU's unit, so a process holding this project's credentials
      // cannot outlive the guest it was authorized for.
      boundTo: [qemuUnit(spec.id)],
      confine: {
        kind: 'credentials',
        memoryMax: spec.brokerMem === undefined ? undefined : `${String(spec.brokerMem)}M`,
        // Outside the store, a program has nothing beside it in the unit, so
        // it has to need nothing else from outside the store.
        readable: Object.values(programs).filter(
          path => !path.startsWith(`${StoreView.storeDir}/`),
        ),
        writable: [brokerDir(spec)],
      },
      credentials: [
        ...spec.brokered.map(credential => ({
          name: credential.name,
          path: credential.hostPath,
        })),
        ...(spec.brokerTls === undefined
          ? []
          : [
              { name: tlsCertificateCredential, path: spec.brokerTls.certificate },
              { name: tlsKeyCredential, path: spec.brokerTls.key },
            ]),
      ],
      env: spec.unitEnv,
      logFile: boot.file('broker.log'),
      name: brokerUnit(spec.id),
      // Started again when it exits, which once running it does only when it
      // is killed. Killed by the kernel when memory runs out, it loses the
      // requests in flight and serves the next ones. The limit guards against
      // a broker that cannot run retrying forever — a credential source that
      // has gone away fails the start rather than yielding a broker without
      // it — and against a guest that runs it out of memory again as fast as
      // it comes back.
      restart: { burst: 5, delaySec: 2, intervalSec: 60 },
      slice: slice(spec.id),
      workingDirectory: brokerDir(spec),
    })
  }

  yield* waitUntil({
    every: '200 millis',
    failed: ifExited(
      bins,
      brokerUnit(spec.id),
      new VmError({ message: `the broker exited during startup; see ${boot.file('broker.log')}` }),
    ),
    ready: Effect.forEach(wanted, socket =>
      fs.exists(socket).pipe(Effect.orElseSucceed(() => false)),
    ).pipe(Effect.map(bound => bound.every(Boolean))),
    timedOut: new VmError({
      message: `the broker did not listen within 30s; see ${boot.file('broker.log')}`,
    }),
    within: '30 seconds',
  })
  return started
})

/**
 * Wait until the guest's end of the tether is bound.
 *
 * "The process exists" is not readiness here: systemd calls a simple service
 * active as soon as it forks, which for ssh is well before the forward has been
 * requested, let alone accepted. Connecting to the port from inside the guest is
 * what a guest process would do, so it is what is waited on.
 *
 * The connect is a bash redirection rather than a program, so the guest needs
 * nothing installed for this to work — `/dev/tcp` is a shell builtin and the
 * guest's login shell is bash.
 */
const awaitTether = Effect.fnUntraced(function* (bins: Binaries, spec: VmSpec, boot: BootLog.Boot) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* waitUntil({
    every: '500 millis',
    // A tether that will never bind is the common failure — the guest took the
    // port, or refused the forward. `ExitOnForwardFailure=yes` turns both into an
    // ssh that exits and the start limit makes that terminal, so the unit going
    // away is the signal.
    failed: ifExited(
      bins,
      tetherUnit(spec.id),
      new VmError({
        message: `the tether to ${spec.label} exited; see ${boot.file('tether.log')}`,
      }),
    ),
    ready: spawner
      .exitCode(
        ChildProcess.make(
          bins.ssh,
          sshArgs(
            bins.sshProxy,
            spec,
            ['-o', 'BatchMode=yes'],
            [`exec 3<>/dev/tcp/127.0.0.1/${brokerGuestPort}`],
          ),
          { extendEnv: true, stderr: 'ignore', stdin: 'ignore', stdout: 'ignore' },
        ),
      )
      .pipe(
        Effect.map(code => code === 0),
        Effect.orElseSucceed(() => false),
      ),
    timedOut: new VmError({
      message: `the tether did not bind guest port ${brokerGuestPort} within 30s; see ${boot.file('tether.log')}`,
    }),
    within: '30 seconds',
  })
})

/**
 * Start the tether if it is not already up, and return once the guest can reach
 * the broker's socket through it. A no-op for a VM with no broker. Answers
 * whether it started one.
 *
 * Idempotent for the same reason `up` is: a second `up` against a live VM must
 * not fail on a unit that is already there, and must still establish that the
 * tether is working rather than assuming it from the unit's existence.
 */
const ensureTether = Effect.fnUntraced(function* (
  bins: Binaries,
  spec: VmSpec,
  boot: BootLog.Boot,
) {
  if (!spec.broker) return false

  const started = !(yield* Systemd.isActive(bins.systemctl, tetherUnit(spec.id)))
  if (started) {
    const programs = yield* forwardPrograms(bins, spec)
    yield* Systemd.start(
      bins,
      forwardUnit(programs, spec, {
        argv: tetherArgv(programs, spec),
        hostNetwork: false,
        logFile: boot.file('tether.log'),
        name: tetherUnit(spec.id),
        // The broker's two sockets, which are what it forwards to.
        readable: [brokerDir(spec)],
      }),
    )
  }

  yield* awaitTether(bins, spec, boot)
  return started
})

/**
 * The first host port that cannot be bound, or `undefined` if all of them can.
 *
 * A diagnostic rather than a guarantee, and the gap is deliberate: something
 * can take a port between this and ssh binding it, in which case the forward's
 * own `ExitOnForwardFailure=yes` fails its unit. What this buys is the case
 * that actually happens — a second project publishing the same dev-server port
 * — named by number, before anything has been started to go looking for.
 *
 * The listener is closed immediately. It never accepts, so there is no
 * `TIME_WAIT` to keep the port from being bound again a moment later. The
 * handler needs a `data` callback it will never run: `Bun.listen` rejects one
 * with no callbacks at all, and that rejection would otherwise be caught below
 * and reported as every port being in use.
 *
 * Any failure counts as taken, not only the address being in use. That fails
 * towards refusing to launch rather than towards launching without the ports
 * that were asked for, which is the direction to fail in.
 */
const firstTakenPort = (ports: readonly Publication[]): Effect.Effect<number | undefined> =>
  Effect.sync(() => {
    for (const port of ports) {
      try {
        Bun.listen({ hostname: '127.0.0.1', port: port.host, socket: { data: () => {} } }).stop(
          true,
        )
      } catch {
        return port.host
      }
    }
    return undefined
  })

/**
 * Whether anything accepts on the host's loopback at this port.
 *
 * The handler needs a `data` callback it will never run: `Bun.connect` rejects
 * one with no callbacks at all, and that rejection would read as the port being
 * closed rather than as a mistake here.
 */
const accepts = (port: number): Effect.Effect<boolean> =>
  Effect.tryPromise(() =>
    Bun.connect({ hostname: '127.0.0.1', port, socket: { data: () => {} } }),
  ).pipe(
    Effect.map(socket => {
      socket.end()
      return true
    }),
    Effect.orElseSucceed(() => false),
  )

/**
 * Wait until the forwards accept on the host's loopback.
 *
 * `ssh` binds a local forward only once the connection has authenticated, so a
 * started unit says nothing about a bound port. Announcing the URL at that
 * moment publishes one that refuses connections for as long as the handshake
 * takes, and whoever reads the line and fails to connect goes looking in the
 * guest, which is not where the fault is.
 *
 * Connecting is the signal, and it costs one connect-and-close against whatever
 * the guest has listening — the same thing a browser's first request does.
 *
 * The unit exiting ends the wait rather than the budget doing it:
 * `ExitOnForwardFailure=yes` means a port ssh cannot bind kills the unit, so
 * the log that says why already exists.
 */
const awaitPublished = Effect.fnUntraced(function* (
  bins: Binaries,
  spec: VmSpec,
  boot: BootLog.Boot,
) {
  // In order, each until it accepts, and none connected to again once it has.
  let published = 0
  return yield* waitUntil({
    every: '100 millis',
    failed: Effect.suspend(() =>
      ifExited(
        bins,
        portsUnit(spec.id),
        new VmError({
          message: `the forward for host port ${String(spec.ports[published]?.host)} stopped before it bound; see ${boot.file('ports.log')}`,
        }),
      ),
    ),
    ready: Effect.gen(function* () {
      for (const port of spec.ports.slice(published)) {
        if (!(yield* accepts(port.host))) return false
        published++
      }
      return true
    }),
    timedOut: new VmError({
      message: `the ports were not published within 15s, though their forward is still running; see ${boot.file('ports.log')}`,
    }),
    within: '15 seconds',
  })
})

/**
 * Publish this VM's ports on the host's loopback, if it has any. Answers
 * whether it started the forward.
 *
 * One unit for all of them rather than one each: they share a connection, they
 * share a lifetime, and a port that cannot be bound should fail the launch
 * rather than leave the others up — a VM that published two of the three ports
 * asked for is the kind of half-success nobody notices until a browser says
 * nothing is listening.
 */
const ensurePorts = Effect.fnUntraced(function* (bins: Binaries, spec: VmSpec, boot: BootLog.Boot) {
  if (spec.ports.length === 0) return false
  // Already published by this VM's own unit, which is what would otherwise make
  // the availability check below report our own forwards as a collision.
  if (yield* Systemd.isActive(bins.systemctl, portsUnit(spec.id))) return false

  const taken = yield* firstTakenPort(spec.ports)
  if (taken !== undefined) {
    return yield* new VmError({
      message: `host port ${String(taken)} is already in use, so it cannot be published. Stop whatever holds it, or give that entry a free \`host\` port in the project's igloo-policy.nix:\n\n  ports = [ { guest = ${String(spec.ports.find(port => port.host === taken)?.guest ?? taken)}; host = <free port>; } ];`,
    })
  }

  const programs = yield* forwardPrograms(bins, spec)
  yield* Systemd.start(
    bins,
    forwardUnit(programs, spec, {
      argv: portsArgv(programs, spec),
      // It listens on the host's loopback, which only the host's network has.
      hostNetwork: true,
      logFile: boot.file('ports.log'),
      name: portsUnit(spec.id),
      readable: [],
    }),
  )

  yield* awaitPublished(bins, spec, boot)

  yield* noted(
    boot,
    `published ${spec.ports
      .map(port => `http://127.0.0.1:${String(port.host)} → guest ${String(port.guest)}`)
      .join(', ')}`,
  )
  return true
})

/**
 * Report whether a VM that is already running was launched from configuration
 * that has since changed.
 *
 * `up` against a running VM builds nothing and starts nothing — that is what
 * makes it idempotent, and it is the right behaviour — but it means an edited
 * layer, a new package, a narrowed grant or a changed network mode takes effect
 * only at the next `down`, with nothing said in the meantime. This is the
 * saying. It is a report and not a refusal: the VM is up, which is what was
 * asked for.
 *
 * No record means no report. A VM launched before this file existed has nothing
 * to compare against, and "your configuration changed" is not an honest way to
 * say "I do not know". Answers whether it reported anything.
 */
const reportDrift = Effect.fnUntraced(function* (spec: VmSpec, boot: BootLog.Boot) {
  const launchedFrom = yield* LaunchInputs.read(spec.launchInputsFile)
  if (launchedFrom === undefined) return false
  const drifted = LaunchInputs.changed(launchedFrom, spec.launchInputs)
  if (drifted.length === 0) return false
  yield* noted(
    boot,
    `it was launched before these changed:\n\n${drifted
      .map(name => `  ${name}`)
      .join('\n')}\n\n\`igloo down\` then \`igloo up\` to apply them.`,
  )
  return true
})

/**
 * What a launch did. `idle` is an `up` that found the VM running, had nothing
 * to report and nothing to start — every `attach` after the first — and is the
 * one outcome whose boot record holds nothing worth reading.
 */
type Launched = 'booted' | 'idle' | 'reused'

/**
 * The launch itself, one named step at a time.
 *
 * Split from `up` so that `up` owns the boot record on every path out of here —
 * a failure and an interrupt included, which is where the record earns its
 * place.
 */
const launch = Effect.fnUntraced(function* (bins: Binaries, spec: VmSpec, boot: BootLog.Boot) {
  const fs = yield* FileSystem.FileSystem

  if (yield* Systemd.isActive(bins.systemctl, qemuUnit(spec.id))) {
    yield* noted(boot, `${spec.label} is already running`)
    const reported = yield* reportDrift(spec, boot)
    yield* boot.phase('guest', awaitReady(bins, spec, boot))
    // Both are no-ops without a broker, and a timed step that did nothing is
    // the kind of entry that makes a record harder to read than no entry.
    const broker = spec.broker && (yield* boot.phase('broker', ensureBroker(bins, spec, boot)))
    const tether = spec.broker && (yield* boot.phase('tether', ensureTether(bins, spec, boot)))
    const ports =
      spec.ports.length > 0 && (yield* boot.phase('ports', ensurePorts(bins, spec, boot)))
    const launched: Launched = reported || broker || tether || ports ? 'reused' : 'idle'
    return launched
  }

  // Clear a half-started predecessor: virtiofsd up but QEMU gone, or a unit
  // left behind by a crash. Stopping the slice is enough — it is the same
  // teardown `down` performs.
  yield* Systemd.stopSlice(bins.systemctl, slice(spec.id))

  // Removed rather than tidied: its path is stable across runs, and what a
  // previous run left there was last written by a QEMU, which can write here.
  // Any entry may be a symlink placed to turn a write this launch makes — or
  // one virtiofsd makes beside its socket — into a write to a file of the
  // user's. Nothing else in it is worth keeping either: a leftover vhost-user
  // socket satisfies the readiness poll at once and QEMU then connects to
  // nothing, a leftover QMP socket is in the way of the new one, and leftover
  // credential values would let a VM start with a value nothing had
  // re-authorized. The slice is stopped, so nothing is using it.
  yield* removeAll(spec.runtimeDir)
  // A previous run's broker directory. The socket in it is a file the next
  // broker cannot bind over, and the symptom is a broker that fails to start on
  // a VM whose tether came up fine — which reads as the tether's fault.
  yield* removeAll(brokerDir(spec))
  // The gc-root's parent is in the project and may not exist yet; the runtime
  // directory is on a tmpfs and was just removed. The log directory needs no
  // entry: the boot record made its own directory inside it before this ran.
  for (const dir of [spec.runtimeDir, dirname(spec.runnerRootLink)]) {
    yield* fs
      .makeDirectory(dir, { recursive: true })
      .pipe(Effect.mapError(() => new VmError({ message: `cannot create ${dir}` })))
  }

  if (spec.broker) {
    for (const dir of [brokerDir(spec), brokerCredentialsDir(spec)]) {
      yield* fs
        .makeDirectory(dir, { recursive: true })
        .pipe(Effect.mapError(() => new VmError({ message: `cannot create ${dir}` })))
      yield* fs.chmod(dir, 0o700).pipe(Effect.ignore)
    }
  }

  // Both kinds of credential are fetched before the build, because this is the
  // one step that may need the person who typed the command — a passphrase
  // prompt or a hardware touch — and they are likeliest to still be there at the
  // start of it. A cold build takes minutes.
  if (spec.brokered.length > 0) {
    const names = spec.brokered.map(credential => credential.name)
    yield* noted(
      boot,
      `fetching ${spec.brokered.length} brokered credential(s), which stay on the host: ${names.join(', ')}`,
      names,
    )
    yield* boot.phase(
      'brokered-credentials',
      Secrets.write(spec.brokered, spec.guestWritable).pipe(
        Effect.mapError(error => new VmError({ message: error.message })),
      ),
    )
  }

  if (spec.credentials.length > 0) {
    const names = spec.credentials.map(credential => credential.name)
    yield* noted(
      boot,
      `delivering ${spec.credentials.length} credential(s) into the guest: ${names.join(', ')}`,
      names,
    )
    yield* fs
      .makeDirectory(credentialsDir(spec), { recursive: true })
      .pipe(
        Effect.mapError(() => new VmError({ message: `cannot create ${credentialsDir(spec)}` })),
      )
    yield* fs.chmod(credentialsDir(spec), 0o700).pipe(Effect.ignore)
    yield* boot.phase(
      'delivered-credentials',
      Secrets.write(spec.credentials, spec.guestWritable).pipe(
        Effect.mapError(error => new VmError({ message: error.message })),
      ),
    )
  }

  yield* noted(boot, `building ${spec.flakeRef}`)
  const nixLog = yield* NixLog.make(bins.nix, boot.file('nix.log'))
  const drvPath = yield* boot.phase(
    'evaluate',
    nixLog(log => instantiate(bins, spec, log)),
  )
  const refusals = yield* boot.phase(
    'plan',
    BuildPlan.check(bins.nix, drvPath).pipe(
      Effect.mapError(error => new VmError({ message: error.message })),
    ),
  )
  if (refusals.length > 0) {
    return yield* new VmError({ message: BuildPlan.describe(refusals) })
  }
  const outPath = yield* boot.phase(
    'build',
    nixLog(log => build(bins, spec, drvPath, log)),
  )
  // Which runner this VM was booted from. The gc-root answers that for the
  // current one only, so an older boot has no other record of it.
  yield* boot.record({ event: 'runner', path: outPath })
  // What it was built from, for the next `up` to compare against. After the
  // build rather than at the end of the launch: this is the only path that
  // rebuilds, so a record written here always describes the VM about to run,
  // and a launch that fails below leaves one describing a VM that never
  // started — which nothing reads, because the check is on the other branch.
  yield* LaunchInputs.write(spec.launchInputsFile, spec.launchInputs)

  // The shares are policy, so the runner's have to be the ones this launch
  // asked for, and a runner that names others is refused before anything
  // serves them. What the host takes from it is each socket's name, which is
  // derived from the guest's hostname.
  const matched = Virtiofs.match(yield* Virtiofs.shares(outPath), spec.shares)
  if (Result.isFailure(matched)) {
    return yield* new VmError({ message: `${outPath} ${matched.failure}` })
  }
  const shares = matched.success

  const closurePaths = yield* boot.phase('closure', StoreView.closure(bins.nix, outPath))
  if (closurePaths.length === 0) {
    return yield* new VmError({ message: `empty closure for ${outPath}` })
  }
  // The daemon serving the store runs in a namespace where `/nix/store` holds
  // this closure and nothing else, so its own binary has to be a member. It is
  // whenever this and the runner's pinned `virtiofsd` are the same derivation.
  // A store path from anywhere else would fail to exec in there, and the only
  // symptom would be a socket that never appears.
  if (
    bins.virtiofsd.startsWith(`${StoreView.storeDir}/`) &&
    !StoreView.covers(closurePaths, bins.virtiofsd)
  ) {
    return yield* new VmError({
      message: `IGLOO_VIRTIOFSD (${bins.virtiofsd}) is not in this runner's closure; point it at the virtiofsd of the igloo flake being built`,
    })
  }
  // Rewritten on every launch, since the closure is this runner's.
  const storePaths = `${spec.runtimeDir}/store-paths`
  yield* fs
    .writeFileString(storePaths, StoreView.pathsFile(closurePaths))
    .pipe(Effect.mapError(() => new VmError({ message: `cannot write ${storePaths}` })))

  yield* noted(boot, `booting ${spec.label} (cid ${spec.cid})`)

  yield* boot.phase(
    'virtiofsd',
    Effect.gen(function* () {
      for (const share of shares) {
        const daemon = Virtiofs.argv({
          share,
          owner: spec.owner,
          threads: spec.virtiofsdThreads,
          virtiofsd: bins.virtiofsd,
        })
        // Only the store's daemon gets the restricted view, and only because its
        // `--shared-dir` is the host store: the namespace is what makes that one
        // closure rather than everything the host has ever built. The others serve
        // the project's own directories, where there is nothing to withhold from a
        // guest that already mounts them read-write.
        yield* Systemd.start(bins, {
          argv: share.store
            ? StoreView.argv({ argv: daemon, helper: bins.storeView, paths: storePaths })
            : daemon,
          env: spec.unitEnv,
          logFile: daemonLog(boot, share.tag),
          name: virtiofsdUnit(spec.id, share.tag),
          slice: slice(spec.id),
          workingDirectory: spec.runtimeDir,
        })
      }
      yield* awaitSockets(bins, spec, boot, shares)
    }),
  )

  // One phase for starting QEMU and waiting on the guest, because the number
  // worth having is how long the guest took to answer, and the start itself is
  // a `systemd-run` that returns immediately.
  yield* boot.phase(
    'guest',
    Effect.gen(function* () {
      yield* Systemd.start(bins, {
        argv: [`${outPath}/bin/microvm-run`],
        // Content chose the kernel and the initrd it loads into the guest, and
        // much of the rest of its command line, so it sees the store, this VM's
        // runtime directory and its two devices, and nothing else of the host.
        confine: {
          kind: 'hypervisor',
          devices: ['/dev/kvm', '/dev/vhost-vsock'],
          // The values a guest must never see, which are in the runtime
          // directory only so that systemd can hand them to the broker.
          hidden: [brokerCredentialsDir(spec)],
          // The QMP socket it creates, the vhost-user sockets it connects to,
          // and the delivered credentials it passes in through `fw_cfg`.
          writable: [spec.runtimeDir],
        },
        // Carries the project root for `list` to read back. The QEMU unit rather
        // than virtiofsd's because this one exists for exactly as long as the guest.
        description: describe(spec.projectRoot),
        env: spec.unitEnv,
        // The guest's console. Nothing reads it on a healthy boot; it is the only
        // account of a boot that fails before the management channel exists.
        logFile: boot.file('serial.log'),
        name: qemuUnit(spec.id),
        slice: slice(spec.id),
        workingDirectory: spec.runtimeDir,
      })
      yield* awaitReady(bins, spec, boot)
    }),
  )
  if (spec.broker) {
    yield* boot.phase('broker', ensureBroker(bins, spec, boot))
    yield* boot.phase('tether', ensureTether(bins, spec, boot))
  }
  if (spec.ports.length > 0) yield* boot.phase('ports', ensurePorts(bins, spec, boot))
  const launched: Launched = 'booted'
  return launched
})

/**
 * Start the VM if it is not already running, and return once its management
 * channel answers. Idempotent: a second `up` against a live VM builds nothing
 * and starts nothing.
 *
 * The VM outlives this process. It runs in a transient systemd slice owned by
 * the user manager, not in this process's tree, so nothing about the caller's
 * lifetime — exiting, being killed, losing its terminal — reaches the guest.
 *
 * Every launch writes its own directory under the project's log directory: the
 * units' output, a trail of what happened as it happened, and a summary of how
 * it ended. `latest` points at the newest. An `up` that succeeds against a
 * running VM with nothing to report or start removes its own again, and puts
 * `latest` back; one that fails, hangs or is interrupted keeps it.
 */
export const up = Effect.fn('Vm.up')(function* (bins: Binaries, spec: VmSpec) {
  const boot = yield* BootLog.open(spec.logDir).pipe(
    Effect.mapError(error => new VmError({ message: error.message })),
  )
  const launched = yield* launch(bins, spec, boot).pipe(
    Effect.onExit(exit => boot.finish(exit)),
    // The record holds what one line cannot: the steps that ran, the units'
    // logs and the whole failure. A message that already points into it has
    // said where it is.
    Effect.mapError(error =>
      error.message.includes(boot.dir)
        ? error
        : new VmError({ bootRecord: boot.dir, message: error.message }),
    ),
  )
  // Kept, it would move `latest` off the boot a reader is after and count
  // against the records the prune keeps, for one `guest` step and nothing else.
  if (launched === 'idle') yield* boot.discard
})

/**
 * Whether this project's guest is up, from the unit alone.
 *
 * Takes an id rather than a target: a caller that only wants to know whether
 * there is a VM has no use for a runtime directory or a gc-root, and the one
 * caller there is exists for the case where there is no VM.
 */
export const isRunning = (
  bins: Binaries,
  id: string,
): Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Systemd.isActive(bins.systemctl, qemuUnit(id))

/**
 * Hand the terminal to an interactive session and return its exit code. `-t`
 * forces a pty, without which nothing in the guest draws.
 *
 * Exiting the shell ends the session and nothing more: the guest holds no
 * lifetime logic, so the VM keeps running.
 */
export const attach = Effect.fn('Vm.attach')(function* (bins: Binaries, spec: VmSpec) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const ssh = yield* spawner
    .spawn(
      ChildProcess.make(bins.ssh, sshArgs(bins.sshProxy, spec, ['-t']), {
        extendEnv: true,
        stderr: 'inherit',
        stdin: 'inherit',
        stdout: 'inherit',
      }),
    )
    .pipe(Effect.mapError(() => new VmError({ message: 'cannot start ssh' })))

  // This process, not ssh, owns the terminal's foreground process group, so the
  // kernel delivers a resize SIGWINCH here. Relaying it makes ssh re-read the
  // shared tty and send a `window-change`; without the relay, guest TUIs stay
  // pinned at the size they started with.
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      const relay = () => {
        try {
          process.kill(ssh.pid, 'SIGWINCH')
        } catch {
          // ssh already exited; nothing left to resize.
        }
      }
      process.on('SIGWINCH', relay)
      return relay
    }),
    () => ssh.exitCode.pipe(Effect.orElseSucceed(() => 255)),
    relay => Effect.sync(() => process.removeListener('SIGWINCH', relay)),
  )
}, Effect.scoped)

/**
 * Power the guest off and stop the slice.
 *
 * The power event comes first and the slice stop is the backstop, because the
 * slice stop is a `SIGKILL` of the cgroup: correct for reclaiming the host's
 * resources, but it gives the guest no chance to flush writes it has cached
 * against the virtio-fs shares.
 *
 * The event is sent from here, over QMP, and only to the process that is QEMU's
 * unit's main process; `Qmp` says why the socket's name is not enough. Nothing
 * of the runner's is run. Outside QEMU's own unit, what the host executes for a
 * VM is igloo's code, not code built from the VM's configuration.
 *
 * Takes a `VmTarget` rather than a full spec: stopping a VM needs neither its
 * flake nor its key, so `list`'s output is enough to tear down a VM this process
 * never started.
 */
export const down = Effect.fn('Vm.down')(function* (bins: Binaries, target: VmTarget) {
  if (yield* Systemd.isActive(bins.systemctl, qemuUnit(target.id))) {
    yield* note(`powering off ${target.id}`)
    const qemu = numberOr(
      (yield* Systemd.show(bins.systemctl, qemuUnit(target.id), ['MainPID'])).get('MainPID'),
    )
    // Bounded, because the far end is a QEMU the guest may have escaped into,
    // and a reply that never comes would otherwise make the cgroup kill below
    // unreachable — the one step that always works.
    const delivered = yield* Effect.timeoutOrElse(
      Qmp.powerdown({ dir: target.runtimeDir, name: controlSocket, pid: qemu ?? 0 }),
      {
        duration: '10 seconds',
        orElse: () => Effect.fail(new Qmp.QmpError({ message: 'QEMU did not reply within 10s' })),
      },
    ).pipe(
      Effect.as(true),
      Effect.catchTag('QmpError', error =>
        note(`${target.id}: ${error.message}; killing its cgroup`).pipe(Effect.as(false)),
      ),
    )

    // Waited on through the unit rather than the socket, whose name is QEMU's
    // to point anywhere. Reported, because the wait costs 30s, and silence for
    // that long is indistinguishable from a wedged command.
    if (
      delivered &&
      !(yield* Systemd.awaitInactive(bins.systemctl, qemuUnit(target.id), '30 seconds'))
    ) {
      yield* note(`${target.id} ignored the power event after 30s; killing its cgroup`)
    }
  }

  yield* Systemd.stopSlice(bins.systemctl, slice(target.id))

  // The values, once the VM that was given them is gone, and everything else
  // its run left with them. They are on a tmpfs and are removed by a reboot
  // anyway; this is so that "the VM is down" and "the credentials are no
  // longer on this machine" are the same moment, and a `down` that cannot make
  // it so says so, once it has removed what it can.
  const runtime = yield* Effect.result(removeAll(target.runtimeDir))
  yield* removeAll(brokerDir(target))
  if (Result.isFailure(runtime)) return yield* runtime.failure
})

/** What `list` can say about a VM's broker, for a VM that has one. */
export interface BrokerStatus {
  /**
   * Processes of the VM the kernel has killed for want of memory. The broker
   * is the one it picks first, so while the guest is running these are the
   * broker's.
   */
  readonly oomKills: number
  /** How many times its unit has started it again, while it is running. */
  readonly restarts: number
  /**
   * `restarting` in the moment between its unit's restarts. `stopped` once
   * its unit has given up, which leaves the guest with no brokered credential
   * and no tunnel until `up` starts it again.
   */
  readonly state: 'restarting' | 'running' | 'stopped'
}

/** What `list` can say about one VM without connecting to it. */
export interface VmStatus {
  /** `undefined` for a VM with no broker. */
  readonly broker: BrokerStatus | undefined
  /** Read back from the slice name, not recomputed. */
  readonly cid: number | undefined
  readonly id: string
  /** For display; the whole `id` when it carries no recognisable CID. */
  readonly label: string
  /**
   * The slice's `MemoryCurrent` — QEMU, virtiofsd and the broker together,
   * since all are in the cgroup. `undefined` when the cgroup reports no figure.
   */
  readonly memoryBytes: number | undefined
  /** The project root recorded on the QEMU unit at launch. */
  readonly projectRoot: string | undefined
  /** Unit name of the slice, `.slice` included. */
  readonly slice: string
  readonly state: 'broken' | 'running' | 'starting'
  /** Milliseconds since QEMU's unit became active. */
  readonly uptimeMillis: number | undefined
}

/** `[not set]`, and anything else systemd offers that is not a number. */
const numberOr = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/**
 * How a VM's broker is doing, or `undefined` if it has none.
 *
 * Read from the tether as much as from the broker: the two are started
 * together and only for a VM with a broker, and the tether lasts as long as
 * the guest does, while a broker whose unit gave up leaves no unit behind.
 */
const brokerStatus = Effect.fnUntraced(function* (
  bins: Binaries,
  id: string,
  sliceCgroup: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem
  const [tether, broker] = yield* Systemd.activeStates(bins.systemctl, [
    tetherUnit(id),
    brokerUnit(id),
  ])
  if (tether !== 'active' && tether !== 'activating') return undefined
  const restarts =
    numberOr(
      (yield* Systemd.show(bins.systemctl, brokerUnit(id), ['NRestarts'])).get('NRestarts'),
    ) ?? 0
  // The slice's, because a broker's own cgroup goes with each start of it,
  // and its counts with it. The slice's counts its members' events too.
  const events =
    sliceCgroup === undefined || sliceCgroup === ''
      ? ''
      : yield* fs
          .readFileString(`/sys/fs/cgroup${sliceCgroup}/memory.events`)
          .pipe(Effect.orElseSucceed(() => ''))
  const status: BrokerStatus = {
    oomKills: numberOr(/^oom_kill (\d+)$/m.exec(events)?.[1]) ?? 0,
    restarts,
    state: broker === 'active' ? 'running' : broker === 'activating' ? 'restarting' : 'stopped',
  }
  return status
})

/** `--timestamp=unix` renders an unset timestamp as `@0` and a set one as `@<s>`. */
const sinceUnixSeconds = (raw: string | undefined, now: number): number | undefined => {
  if (raw === undefined || !raw.startsWith('@')) return undefined
  const seconds = numberOr(raw.slice(1))
  return seconds === undefined || seconds === 0 ? undefined : now - seconds * 1000
}

/**
 * Every VM with units in the user manager, whether this process started it or
 * not. The slices are the enumeration: a VM's identity is its slice name, and a
 * VM that has fully stopped has none.
 */
export const list = Effect.fn('Vm.list')(function* (bins: Binaries) {
  const slices = yield* Systemd.listSlices(bins.systemctl, prefix)
  const now = yield* Clock.currentTimeMillis
  const found: Array<VmStatus> = []

  for (const sliceUnit of slices) {
    const id = Systemd.unescapeSliceComponent(
      sliceUnit.slice(`${prefix}-`.length, -'.slice'.length),
    )
    const properties = yield* Systemd.show(bins.systemctl, qemuUnit(id), [
      'ActiveEnterTimestamp',
      'ActiveState',
      'Description',
    ])
    const qemuState = properties.get('ActiveState') ?? ''

    // An empty slice systemd has not unloaded yet. It is not a VM in any sense
    // the caller cares about, and listing it would report a VM that is gone. A
    // still-running daemon keeps it listed, because that is a half-started VM
    // holding host resources and `down` is how it is reclaimed.
    if (
      qemuState !== 'active' &&
      qemuState !== 'activating' &&
      !(yield* Systemd.anyActive(bins.systemctl, virtiofsdUnits(id)))
    )
      continue

    const parsed = Project.parseId(id)
    const sliceProperties = yield* Systemd.show(bins.systemctl, sliceUnit, [
      'ControlGroup',
      'MemoryCurrent',
    ])
    found.push({
      broker: yield* brokerStatus(bins, id, sliceProperties.get('ControlGroup')),
      cid: parsed?.cid,
      id,
      label: parsed?.label ?? id,
      memoryBytes: numberOr(sliceProperties.get('MemoryCurrent')),
      projectRoot: projectFromDescription(properties.get('Description')),
      slice: sliceUnit,
      state:
        qemuState === 'active' ? 'running' : qemuState === 'activating' ? 'starting' : 'broken',
      uptimeMillis: sinceUnixSeconds(properties.get('ActiveEnterTimestamp'), now),
    })
  }

  return found
})
