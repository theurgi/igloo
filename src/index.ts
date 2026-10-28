#!/usr/bin/env bun
import type { VmSpec } from './Vm.ts'

import { BunRuntime, BunServices } from '@effect/platform-bun'
import { Effect, FileSystem, Option } from 'effect'
import { Argument, Command, Flag } from 'effect/unstable/cli'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { availableParallelism, hostname } from 'node:os'
import * as path from 'node:path'

import packageJson from '../package.json' with { type: 'json' }
import * as Binaries from './Binaries.ts'
import * as Broker from './broker.ts'
import * as Config from './Config.ts'
import * as Evaluation from './Evaluation.ts'
import * as Fallback from './Fallback.ts'
import * as Flake from './Flake.ts'
import * as Format from './Format.ts'
import * as LaunchInputs from './LaunchInputs.ts'
import * as Preflight from './Preflight.ts'
import * as Project from './Project.ts'
import * as Report from './Report.ts'
import * as Spec from './Spec.ts'
import * as Tls from './Tls.ts'
import * as Vm from './Vm.ts'

// The process edge. Everything below takes host facts from here rather than
// reading the ambient environment itself, so what a VM's units inherit is a
// value that was chosen, not whatever happened to be set at the point of use.
const env: Record<string, string | undefined> = process.env
const bins = Binaries.fromEnv(env)

/**
 * Where a VM's vhost-user sockets live, and nothing else.
 *
 * `XDG_RUNTIME_DIR` is right for exactly this: per-user, mode 0700, and a tmpfs,
 * so nothing here survives a reboot — which is what we want, because a socket
 * that outlives its VM is worse than a missing one. It satisfies the readiness
 * poll instantly and sends QEMU to connect to nothing. Everything durable —
 * keys, logs, the gc-root, the guest's home — is in the project.
 */
const runtimeDir = (id: string): Effect.Effect<string, Vm.VmError> => {
  const dir = env['XDG_RUNTIME_DIR']
  return dir === undefined
    ? Effect.fail(new Vm.VmError({ message: 'XDG_RUNTIME_DIR is unset' }))
    : Effect.succeed(path.join(dir, 'igloo', id))
}

/**
 * The key the host connects with, generated on first use and then kept: its
 * public half is baked into the runner at build time, so regenerating it changes
 * a build input and forces a rebuild. That is why it belongs in the project and
 * not on a tmpfs.
 */
const ensureKey = Effect.fnUntraced(function* (sshDir: string) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const identity = path.join(sshDir, 'id')

  yield* fs.makeDirectory(sshDir, { recursive: true }).pipe(Effect.ignore)
  if (!(yield* fs.exists(identity).pipe(Effect.orElseSucceed(() => false)))) {
    const code = yield* spawner
      .exitCode(
        ChildProcess.make(
          'ssh-keygen',
          ['-q', '-t', 'ed25519', '-N', '', '-C', 'igloo', '-f', identity],
          { extendEnv: true, stderr: 'inherit', stdin: 'ignore', stdout: 'ignore' },
        ),
      )
      .pipe(Effect.orElseSucceed(() => 127))
    if (code !== 0) {
      return yield* new Vm.VmError({ message: `ssh-keygen exited ${code}` })
    }
  }
  const publicKey = yield* fs
    .readFileString(`${identity}.pub`)
    .pipe(Effect.mapError(() => new Vm.VmError({ message: `cannot read ${identity}.pub` })))
  return { identity, publicKey: publicKey.trim() }
})

const cid = Flag.Int('cid').pipe(
  Flag.withDescription(
    "Guest CID for the vsock management channel; derived from the project's path if unset",
  ),
  Flag.optional,
)

const igloo = Command.make('igloo').pipe(
  Command.withSharedFlags({ cid }),
  Command.withDescription('Run coding agents in isolated microVMs'),
)

/**
 * The igloo checkout whose `flake.nix` a project's runner is built from.
 *
 * Derived from this file's own location rather than configured, so the flake
 * that builds a VM and the code that launches it are always the same checkout —
 * an environment variable here could silently disagree with the running tool.
 *
 * The override is not a convenience. A compiled binary has no source location:
 * `import.meta.dir` is `/$bunfs/root`, inside bun's virtual filesystem, so the
 * fallback yields a path that does not exist. A packaged igloo is therefore a
 * wrapper setting `IGLOO_FLAKE` to its own store path, and `doctor` checks it.
 */
const iglooFlakePath = env['IGLOO_FLAKE'] ?? path.dirname(import.meta.dir)

/**
 * The user layer's directory — the configuration that applies to every VM this
 * user runs, and the only place machine-local policy may be set — or
 * `undefined` for none.
 *
 * Set by the wrapper home-manager installs, to a store path it builds from
 * `programs.igloo`, so an installed igloo carries its configuration rather than
 * looking for it. Unset, as in the devshell, a VM gets the core and its
 * project's layer only. Made absolute, since the generated flake imports from
 * it and the build's allow-list names it.
 */
const userLayerDir =
  env['IGLOO_USER_LAYER'] === undefined || env['IGLOO_USER_LAYER'] === ''
    ? undefined
    : path.resolve(env['IGLOO_USER_LAYER'])

const projectFor = Effect.fnUntraced(function* (input: { readonly cid: Option.Option<number> }) {
  const found = yield* Project.find(process.cwd())
  // Re-derive rather than patch the CID in: the id carries it, so an override has
  // to reach the slice name too or `ls` would read a CID the VM does not have.
  return Option.match(input.cid, {
    onNone: () => found,
    onSome: override => Project.forRoot(found.root, override),
  })
})

/**
 * The least `down` needs, and deliberately less than `specFor` produces.
 *
 * Stopping a VM must not depend on anything a user can break: no key, no
 * generated flake, and above all no configuration. A typo in a policy file would
 * otherwise make a running VM unstoppable by the one command whose job is to
 * reclaim its memory, leaving `systemctl --user stop` as the answer.
 */
const targetFor = Effect.fnUntraced(function* (input: { readonly cid: Option.Option<number> }) {
  const project = yield* projectFor(input)
  return {
    id: project.id,
    runtimeDir: yield* runtimeDir(project.id),
  } satisfies Vm.VmTarget
})

const specFor = Effect.fnUntraced(function* (input: { readonly cid: Option.Option<number> }) {
  const fs = yield* FileSystem.FileSystem
  const project = yield* projectFor(input)
  const key = yield* ensureKey(project.sshDir)

  // virtiofsd exits if a share's source is missing, and the failure reads as a
  // socket that never appeared. `init` creates both, but a project can be moved
  // or half-deleted between launches.
  const guestWritable = [project.workspaceDir, project.homeDir]
  for (const dir of guestWritable) {
    yield* fs
      .makeDirectory(dir, { recursive: true })
      .pipe(Effect.mapError(() => new Vm.VmError({ message: `cannot create ${dir}` })))
  }
  yield* Project.refuseLinkedShares(project)

  // Core, then the user layer, then this project's. Content reaches the guest as
  // NixOS modules the flake imports; policy never reaches it at all — it is
  // emitted as `mkRunner` arguments, at a priority no module can override.
  const config = yield* Config.resolve(bins, {
    project: { root: project.root, workspaceDir: project.workspaceDir },
    userLayerDir,
  })
  const runtime = yield* runtimeDir(project.id)
  // Made, or found, only for a broker that answers a name: its authority is
  // built into the runner, so it has to exist before the plan does.
  const tls =
    Broker.tlsNames(Spec.grantsOf(config.policy)).length > 0
      ? yield* Tls.ensure(project.tlsDir, Broker.tlsNamesCovered)
      : undefined
  const plan = Spec.fromConfig(config, {
    iglooFlakePath,
    cid: project.cid,
    homeDir: project.homeDir,
    label: project.label,
    publicKey: key.publicKey,
    root: project.root,
    runtimeDir: runtime,
    tlsAuthority: tls?.authority,
    userLayerDir,
    workspaceDir: project.workspaceDir,
  })
  const flakeRef = yield* Flake.write(project.runnerDir, plan.runner)

  // Everything that decides what this VM is, hashed, so that a later `up`
  // finding it already running can say the guest is older than the files.
  //
  // The generated flake covers every policy setting that reaches the guest, and
  // it is written above from the configuration just resolved — so the layers'
  // policy files need no entry of their own, and an edit in the user layer that
  // this project does not use reports nothing. What the flake does not cover is
  // what is host-side only: the grants the broker is started with, where the
  // tunnel may go — which is all a network mode decides — the broker's memory
  // bound and the published ports, which `plan.hostSide` renders.
  //
  // igloo's own files and the content layers are keyed by name, and the
  // generated flake is hashed without their paths in it, because anything in
  // the store moves when it changes: an upgrade moves igloo, and a
  // home-manager switch moves the user layer whether or not this project uses
  // what changed. The broker and the helper it and the published ports run
  // under are the host-side programs with entries of their own: a running VM
  // keeps the broker it was started with, and both restricted as they were
  // then. It keeps the arguments its other units were started with too, and
  // those have none, so an upgrade that changes only them reports nothing.
  const launchInputs = {
    [path.join(project.runnerDir, 'flake.nix')]: LaunchInputs.digest(Flake.comparable(plan.runner)),
    ...(yield* LaunchInputs.ofNamedFiles(
      Object.fromEntries(config.content.map(({ file, name }) => [name, file])),
    )),
    ...(yield* LaunchInputs.ofIgloo(iglooFlakePath)),
    ...(plan.broker ? { "the broker's executable": LaunchInputs.digest(bins.broker) } : {}),
    ...(plan.broker || config.policy.ports.length > 0
      ? {
          'the restriction on the broker and the published ports': LaunchInputs.digest(
            bins.landlock,
          ),
        }
      : {}),
    'the broker grants and memory, tunnel destinations and published ports': LaunchInputs.digest(
      plan.hostSide,
    ),
  }

  return {
    broker: plan.broker,
    brokered: plan.brokered,
    brokerMem: config.policy.brokerMem,
    brokerTls: tls === undefined ? undefined : { certificate: tls.certificate, key: tls.key },
    grants: plan.grants,
    tunnel: config.policy.tunnel,
    cid: project.cid,
    credentials: plan.credentials,
    evaluation: yield* Evaluation.forRunner({
      iglooFlakePath,
      runnerDir: project.runnerDir,
      contentModules: plan.runner.contentModules,
      workspaceDir: project.workspaceDir,
    }),
    flakeRef,
    guestWritable,
    id: project.id,
    identityFile: key.identity,
    label: project.label,
    launchInputs,
    launchInputsFile: project.launchInputsFile,
    logDir: project.logDir,
    ports: config.policy.ports,
    projectRoot: project.root,
    runnerRootLink: project.runnerRootLink,
    runtimeDir: runtime,
    unitEnv: { PATH: env['PATH'] ?? '' },
    // Both exist on Linux, which is all this runs on; the types allow for
    // platforms where they do not. -1 is an id nothing will accept.
    owner: { gid: process.getgid?.() ?? -1, uid: process.getuid?.() ?? -1 },
    virtiofsdThreads: availableParallelism(),
  } satisfies VmSpec
})

/** What `doctor` checks against, which `report` runs it with too. */
const preflightHost: Preflight.Host = {
  iglooFlake: iglooFlakePath,
  runtimeDir: env['XDG_RUNTIME_DIR'],
  user: env['USER'] ?? 'root',
  userLayer: userLayerDir,
}

/**
 * Every host prerequisite, checked and reported in one pass.
 *
 * This is not run before `up`. Most of these cost a process spawn, which is the
 * wrong tax on every launch for a set of facts that change about once per
 * machine. The launch failures that a
 * prerequisite explains name this command instead.
 */
const doctor = Command.make(
  'doctor',
  {},
  Effect.fn(function* () {
    const checks = yield* Preflight.run(bins, preflightHost)
    yield* Effect.sync(() => process.stdout.write(`${Preflight.report(checks)}\n`))
    // Non-zero on any failure, so this is usable as a gate in a script rather
    // than only by reading it.
    if (Preflight.failures(checks) > 0) {
      yield* Effect.sync(() => {
        process.exitCode = 1
      })
    }
  }),
).pipe(Command.withDescription('Check the host prerequisites and report what is missing'))

const record = Argument.String('record').pipe(
  Argument.withDescription(
    "A boot id, or a boot record's directory as a failed launch prints it; the latest launch's if unset",
  ),
  Argument.optional,
)

/**
 * What a bug report needs, redacted, on stdout. It reads no layer, so it works
 * for the project whose layer is the bug, and its exit status is its own
 * rather than `doctor`'s: a failing check is something to report, not a reason
 * to print nothing.
 */
const report = Command.make(
  'report',
  { record },
  Effect.fn(function* (config) {
    const checks = yield* Preflight.run(bins, preflightHost)
    const text = yield* Report.run({
      cwd: process.cwd(),
      doctor: Preflight.report(checks),
      host: { home: env['HOME'], hostName: hostname(), user: env['USER'] },
      record: Option.getOrUndefined(config.record),
      // Set by the package from its flake's commit; a `path:` input has none.
      revision:
        env['IGLOO_REVISION'] === undefined || env['IGLOO_REVISION'] === ''
          ? undefined
          : env['IGLOO_REVISION'],
      version: packageJson.version,
    })
    yield* Effect.sync(() => process.stdout.write(text))
  }),
).pipe(
  Command.withDescription(
    'Print what a bug report needs — the version, doctor and a boot record — with what identifies you replaced',
  ),
)

const dir = Argument.String('dir').pipe(
  Argument.withDescription('Project directory to create; defaults to the current one'),
  Argument.optional,
)

const init = Command.make(
  'init',
  { dir },
  Effect.fn(function* (config) {
    const fs = yield* FileSystem.FileSystem
    // Resolved, because the project's root is: comparing one against a raw
    // `cwd` would print a `cd` hint for a directory the caller is already in
    // whenever anything above it is a symlink.
    const cwd = yield* fs.realPath(process.cwd()).pipe(Effect.orElseSucceed(() => process.cwd()))
    const project = yield* Project.init(Option.getOrElse(config.dir, () => process.cwd()))
    const files = Config.projectLayer(project.root)
    // Every other command finds a project by walking up, so one created in a
    // subdirectory is invisible from where it was created — and `up` there says
    // there is no project at all, moments after this said it made one. The
    // relative form is the one worth pasting; a target outside the current
    // directory has no short form, so it stays absolute.
    const relative = path.relative(cwd, project.root)
    const target = relative.startsWith('..') ? project.root : relative
    const hint = relative === '' ? '' : `igloo: cd ${target} to use it\n`
    yield* Effect.sync(() =>
      process.stderr.write(
        `igloo: ${project.label} initialised at ${project.root} (cid ${project.cid})\n` +
          // Neither file is created: an absent layer is the normal case, and a
          // stub would be one more file to read on every launch for nothing. But
          // they are undiscoverable unless something names them.
          `igloo: configure it in ${files.content} (packages, services) and ${files.policy} (network)\n` +
          hint,
      ),
    )
  }),
).pipe(Command.withDescription('Create the project skeleton — marker, .igloo/, workspace/'))

const up = Command.make(
  'up',
  {},
  Effect.fn(function* () {
    const spec = yield* specFor(yield* igloo)
    yield* Vm.up(bins, spec)
    yield* Effect.sync(() =>
      process.stderr.write(`igloo: ${spec.label} is up. 'igloo attach' for a shell.\n`),
    )
  }),
).pipe(Command.withDescription('Build and start the VM, and wait for it to answer'))

const attach = Command.make(
  'attach',
  {},
  Effect.fn(function* () {
    const spec = yield* specFor(yield* igloo)
    yield* Vm.up(bins, spec)
    const code = yield* Vm.attach(bins, spec)
    // Leaving the session leaves the VM running; that is the point of putting
    // its lifetime in systemd's hands rather than this process's.
    yield* Effect.sync(() => {
      process.exitCode = code
    })
  }),
).pipe(Command.withDescription('Open a shell in the VM, starting it if it is not running'))

/**
 * Succeeds with 129, a shell's status for a hangup, when this process receives
 * SIGHUP. Closing the terminal window sends one, and its default action ends
 * the process on the spot — before any finalizer, including the one that ends
 * what a fallback session left running.
 */
const hangup = Effect.callback<number>(resume => {
  const onHangup = () => {
    resume(Effect.succeed(129))
  }
  process.once('SIGHUP', onHangup)
  return Effect.sync(() => {
    process.off('SIGHUP', onHangup)
  })
})

/**
 * The escape hatch, and the one command that does not need the VM path to work:
 * no key, no configuration, no generated flake and no build. Each of those is
 * something that can be why the VM will not start.
 */
const fallback = Command.make(
  'fallback',
  {},
  Effect.fn(function* () {
    const project = yield* projectFor(yield* igloo)
    // Both would be writing the same `/root`, which is worth saying once. Not a
    // refusal: a VM that is up but unreachable is one of the reasons to be here.
    if (yield* Vm.isRunning(bins, project.id)) {
      yield* Effect.sync(() =>
        process.stderr.write(
          `igloo: ${project.label} is running — \`igloo attach\` opens a shell in the VM itself. This sandbox shares its /root.\n`,
        ),
      )
    }
    const code = yield* Effect.raceFirst(
      Fallback.run(
        bins,
        {
          homeSource: project.homeDir,
          id: project.id,
          label: project.label,
          logDir: project.logDir,
          runnerRootLink: project.runnerRootLink,
          workspaceSource: project.workspaceDir,
        },
        { env, user: env['USER'] ?? 'root' },
      ),
      hangup,
    )
    yield* Effect.sync(() => {
      process.exitCode = code
    })
  }),
).pipe(
  Command.withDescription(
    'Open a host-side sandbox with the same layout, for when the VM will not boot',
  ),
)

// `withDefault` is not optional decoration: a `Flag.Boolean` without one is a
// *required* flag, so `igloo down` would refuse to run without `--all`.
const all = Flag.Boolean('all').pipe(
  Flag.withDescription('Stop every running VM rather than this project’s'),
  Flag.withDefault(false),
)

const down = Command.make(
  'down',
  { all },
  Effect.fn(function* (config) {
    if (!config.all) {
      yield* Vm.down(bins, yield* targetFor(yield* igloo))
      return
    }
    // Every field this needs comes from the listing, so it reaches VMs this
    // process never started — including ones whose project directory is gone.
    //
    // Concurrent because each poweroff waits on its own guest for up to 30s, and
    // serially that is 30s *per VM* of silence. The VMs are independent, so the
    // wait is one budget rather than N.
    const vms = yield* Vm.list(bins)
    yield* Effect.forEach(
      vms,
      vm =>
        Effect.gen(function* () {
          yield* Vm.down(bins, { id: vm.id, runtimeDir: yield* runtimeDir(vm.id) })
        }),
      { concurrency: 'unbounded', discard: true },
    )
  }),
).pipe(Command.withDescription('Power the guest off and stop its slice'))

// No `-v` alias: the runtime already claims it for `--version`, and the two
// would be indistinguishable in help output.
const verbose = Flag.Boolean('verbose').pipe(
  Flag.withDescription('Also show the CID, slice and runtime directory'),
  Flag.withDefault(false),
)

/**
 * Memory is a column rather than a `--verbose` detail on purpose: a VM nothing
 * has attached to for days is still holding its whole allocation, and this is
 * the only place that is visible.
 *
 * So is the broker. One that has stopped leaves its guest with no brokered
 * credential and no tunnel, which the guest sees only as connections that
 * fail, so a stopped broker is also said in words, with what starts it again.
 */
const ls = Command.make(
  'ls',
  { verbose },
  Effect.fn(function* (config) {
    const vms = yield* Vm.list(bins)
    if (vms.length === 0) {
      yield* Effect.sync(() => process.stderr.write('igloo: no VMs running\n'))
      return
    }

    const rows: Array<Array<string>> = []
    for (const vm of vms) {
      const row = [
        vm.label,
        vm.state,
        Format.duration(vm.uptimeMillis),
        Format.bytes(vm.memoryBytes),
        Format.broker(vm.broker),
      ]
      if (config.verbose) {
        row.push(
          vm.cid === undefined ? Format.missing : String(vm.cid),
          vm.slice,
          yield* runtimeDir(vm.id),
        )
      }
      row.push(vm.projectRoot ?? Format.missing)
      rows.push(row)
    }

    const headers = ['NAME', 'STATUS', 'UPTIME', 'MEMORY', 'BROKER']
    const columns = config.verbose
      ? [...headers, 'CID', 'SLICE', 'RUNTIME DIR', 'PROJECT']
      : [...headers, 'PROJECT']
    yield* Effect.sync(() => process.stdout.write(`${Format.table(columns, rows)}\n`))
    for (const vm of vms) {
      if (vm.broker?.state !== 'stopped') continue
      yield* Effect.sync(() =>
        process.stderr.write(
          `igloo: ${vm.label}'s broker has stopped, so its guest has no brokered credential and no tunnel; \`igloo up\` in ${vm.projectRoot ?? 'its project'} starts it again\n`,
        ),
      )
    }
  }),
).pipe(Command.withDescription('List the VMs the user manager is running'))

// The runtime's own report is off because what it prints is a timestamped log
// record with stack frames into source files, which an installed binary does
// not have. The exit status is still the runtime's: 1 on a failure, 130 on an
// interrupt.
igloo.pipe(
  Command.withSubcommands([init, up, attach, fallback, down, ls, doctor, report]),
  Command.run({ version: packageJson.version }),
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- the entry point
  Effect.provide(BunServices.layer),
  Effect.tapCause(cause =>
    Effect.sync(() => {
      const text = Format.failure(cause)
      if (text !== undefined) process.stderr.write(text)
    }),
  ),
  BunRuntime.runMain({ disableErrorReporting: true }),
)
