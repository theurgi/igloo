import type { Binaries } from './Binaries.ts'

import { Effect, FileSystem, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import * as path from 'node:path'

import * as StoreView from './StoreView.ts'
import * as Systemd from './Systemd.ts'

/**
 * What checking one prerequisite found.
 *
 * `remedy` is required on a failure rather than optional. A check that reports
 * something is wrong without saying what to do about it leaves the reader where
 * the opaque timeout did, which is the whole problem this exists to solve.
 */
export type Outcome =
  | { readonly _tag: 'Failed'; readonly detail: string; readonly remedy: string }
  | { readonly _tag: 'Ok'; readonly detail: string }

export interface Check {
  readonly name: string
  readonly outcome: Outcome
}

/** Host facts a check needs, passed in rather than read from the environment. */
export interface Host {
  /** The igloo flake a runner is built from — a store path, once installed. */
  readonly iglooFlake: string
  /** `IGLOO_USER_LAYER`, or `undefined` when there is no user layer. */
  readonly userLayer: string | undefined
  /** `XDG_RUNTIME_DIR`, or `undefined` when it is unset. */
  readonly runtimeDir: string | undefined
  readonly user: string
}

const ok = (detail: string): Outcome => ({ _tag: 'Ok', detail })

const failed = (detail: string, remedy: string): Outcome => ({
  _tag: 'Failed',
  detail,
  remedy,
})

const silent = {
  extendEnv: true,
  stderr: 'ignore',
  stdin: 'ignore',
  stdout: 'ignore',
} as const

/** A program that has to exist and start. Nothing is asserted about its output. */
const starts = Effect.fnUntraced(function* (
  command: string,
  args: readonly string[],
  remedy: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const code = yield* spawner
    .exitCode(ChildProcess.make(command, [...args], silent))
    .pipe(Effect.orElseSucceed(() => 127))
  // The command, not just "ok": it may be an override, and which binary
  // answered is the thing a reader cannot otherwise see.
  return code === 0 ? ok(`\`${command}\` starts`) : failed(`\`${command}\` exited ${code}`, remedy)
})

/**
 * A helper's exit code and its reason: the last line it wrote to stderr, which
 * is where this project's helpers say why they refused. `None` when it could
 * not be started at all.
 */
const answer = (command: string, args: readonly string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          extendEnv: true,
          stderr: 'pipe',
          stdin: 'ignore',
          stdout: 'ignore',
        }),
      )
      const said = yield* handle.stderr.pipe(Stream.decodeText, Stream.mkString)
      const code = yield* handle.exitCode
      return { code, reason: said.trim().split('\n').at(-1) ?? '' }
    }),
  ).pipe(Effect.option)

/** "exited 1: the reason", or without the reason when there was none. */
const exited = (code: number, reason: string): string =>
  `exited ${code}${reason === '' ? '' : `: ${reason}`}`

/**
 * The top-level directories of `/` that hold an autofs mount at or under them,
 * parsed from `/proc/self/mountinfo`. The fstype sits after the ` - `
 * separator and the mount point is field index 4, so `/mnt/backup` → `mnt`.
 */
const autofsTopLevelDirs = (mountinfo: string): ReadonlySet<string> =>
  new Set(
    mountinfo
      .split('\n')
      .filter(line => line.includes(' - autofs '))
      .map(line => line.split(' ')[4])
      .filter((mp): mp is string => mp?.startsWith('/') ?? false)
      .map(mp => mp.split('/')[1] ?? '')
      .filter(top => top !== ''),
  )

/**
 * `--dev-bind` arguments exposing the host root, one per top-level entry of
 * `/`, skipping any that holds an autofs mount.
 *
 * A single `--dev-bind / /` would be shorter, but bwrap binds the root
 * recursively and then remounts every submount to apply flags. An autofs
 * automount cannot be remounted: bwrap either fails with `ENODEV` or trips the
 * automounter and blocks in uninterruptible sleep. Binding each top-level
 * directory separately never touches the autofs.
 */
export const rootBindArgs = (rootEntries: readonly string[], mountinfo: string): Array<string> => {
  const excluded = autofsTopLevelDirs(mountinfo)
  return rootEntries
    .filter(entry => !excluded.has(entry))
    .flatMap(entry => ['--dev-bind', `/${entry}`, `/${entry}`])
}

const hostRootBinds = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const mountinfo = yield* fs
    .readFileString('/proc/self/mountinfo')
    .pipe(Effect.orElseSucceed(() => ''))
  const entries = yield* fs.readDirectory('/').pipe(Effect.orElseSucceed(() => [] as Array<string>))
  return rootBindArgs(entries, mountinfo)
})

/**
 * `igloo-store-view` run the way a launch runs it: a namespace whose store
 * holds virtiofsd's closure and nothing else, with virtiofsd started from
 * inside it. Each way that can fail — no user namespaces, a helper that is not
 * there, a virtiofsd outside the store — otherwise surfaces as a launch whose
 * store socket never appears.
 */
const storeView = Effect.fnUntraced(function* (bins: Binaries) {
  const fs = yield* FileSystem.FileSystem
  const remedy =
    'Point IGLOO_STORE_VIEW at the igloo flake’s igloo-store-view and IGLOO_VIRTIOFSD at its virtiofsd — the devshell does both — and enable unprivileged user namespaces.'

  const daemon = StoreView.storePathOf(bins.virtiofsd)
  if (daemon === undefined) {
    return failed(
      `IGLOO_VIRTIOFSD (${bins.virtiofsd}) is not in the store, so there is no closure to serve it from`,
      remedy,
    )
  }
  const paths = yield* StoreView.closure(bins.nix, daemon)
  if (paths.length === 0) return failed(`cannot read the closure of ${daemon}`, remedy)

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const list = yield* fs.makeTempDirectoryScoped().pipe(
        Effect.map(dir => path.join(dir, 'store-paths')),
        Effect.tap(file => fs.writeFileString(file, StoreView.pathsFile(paths))),
        Effect.option,
      )
      if (list._tag === 'None') {
        return failed('cannot write a list of store paths to a temporary directory', remedy)
      }
      const [command, ...args] = StoreView.argv({
        argv: [bins.virtiofsd, '--version'],
        helper: bins.storeView,
        paths: list.value,
      })
      // stderr is kept because the exit code cannot say which of the two
      // programs failed: the helper, or virtiofsd unable to load from the view.
      const ran = yield* answer(command, args)
      if (ran._tag === 'None') return failed(`cannot run \`${command}\``, remedy)
      return ran.value.code === 0
        ? ok(`\`${command}\` serves virtiofsd its closure of ${paths.length} paths`)
        : failed(`\`${command}\` ${exited(ran.value.code, ran.value.reason)}`, remedy)
    }),
  )
})

/**
 * `igloo-landlock` restricting itself as it restricts the broker and the
 * published ports. Each way that can fail — no Landlock in the kernel, one too
 * old to scope abstract sockets, a helper that is not there — otherwise surfaces
 * as a broker or a forward that exits as it starts, and with it every launch of
 * a VM that has one.
 */
const landlock = Effect.fnUntraced(function* (bins: Binaries) {
  const remedy =
    'Run Linux 6.12 or newer with landlock among the modules /sys/kernel/security/lsm lists, and point IGLOO_LANDLOCK at the igloo flake’s igloo-landlock; the devshell does that for you.'
  const ran = yield* answer(bins.landlock, ['--check'])
  if (ran._tag === 'None') return failed(`cannot run \`${bins.landlock}\``, remedy)
  return ran.value.code === 0
    ? ok(
        `\`${bins.landlock}\` can keep the broker and the published ports from loopback and abstract sockets`,
      )
    : failed(`\`${bins.landlock}\` ${exited(ran.value.code, ran.value.reason)}`, remedy)
})

const device = Effect.fnUntraced(function* (node: string, remedy: string) {
  const fs = yield* FileSystem.FileSystem
  const usable = yield* fs.access(node, { readable: true, writable: true }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )
  return usable
    ? ok(`${node} is readable and writable`)
    : failed(`cannot open ${node} for read and write`, remedy)
})

/**
 * The release number leading a systemd version, as `systemd-run --version`
 * gives it (`systemd 261 (261.3)`) or the user manager's `Version` does
 * (`261.3`, or a distribution's `259.5-0ubuntu3.4`). `undefined` when there is
 * none.
 */
export const systemdRelease = (said: string): number | undefined => {
  const found = /^(?:systemd )?(\d+)/.exec(said.trim())
  return found?.[1] === undefined ? undefined : Number(found[1])
}

const tooOld = (release: number): string =>
  `systemd ${release}, older than the ${Systemd.minimumVersion} that igloo's units need for PrivatePIDs= and PrivateUsers=self`

const upgrade = `Upgrade systemd to ${Systemd.minimumVersion} or later; on NixOS, that is 25.05 or later.`

/** What `systemd-run`'s own release, `undefined` when it gave none, says of it. */
export const systemdRunOutcome = (command: string, release: number | undefined): Outcome =>
  release === undefined
    ? failed(
        `\`${command}\` gives no systemd version`,
        'Install systemd, or point IGLOO_SYSTEMD_RUN at systemd-run.',
      )
    : release < Systemd.minimumVersion
      ? failed(`\`${command}\` is ${tooOld(release)}`, upgrade)
      : ok(`\`${command}\` is systemd ${release}`)

/**
 * What the user manager's release says of it, `undefined` when it did not
 * answer. One older than `systemd-run` is a manager still running the systemd
 * it started with, which a restart onto the installed one is all it takes to
 * fix.
 */
export const userManagerOutcome = (
  release: number | undefined,
  systemdRun: number | undefined,
): Outcome => {
  if (release === undefined) {
    return failed(
      'the user manager does not answer',
      'Ensure a systemd user session exists (`systemctl --user status`); DBUS_SESSION_BUS_ADDRESS may be unset.',
    )
  }
  if (release >= Systemd.minimumVersion) return ok(`systemd ${release}`)
  // Not a logout: with lingering on, the manager outlives the session.
  const restart =
    'Run `systemctl --user daemon-reexec`, which restarts the user manager onto the installed systemd and leaves its units running.'
  return failed(
    `it runs ${tooOld(release)}`,
    systemdRun !== undefined && systemdRun >= Systemd.minimumVersion
      ? restart
      : `${upgrade} Then: ${restart}`,
  )
}

/** The first line a program prints, or `''` when it prints none or cannot run. */
const firstLine = Effect.fnUntraced(function* (command: string, args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const lines = yield* spawner
    .lines(
      ChildProcess.make(command, [...args], {
        extendEnv: true,
        stderr: 'ignore',
        stdin: 'ignore',
      }),
    )
    .pipe(Effect.orElseSucceed(() => [] as Array<string>))
  return lines[0]?.trim() ?? ''
})

/**
 * Run every prerequisite check and return what each one found.
 *
 * Never fails: a check that cannot run is a failed check, not an error. The
 * caller wants the whole picture, and a preflight that aborts at the first
 * problem would report one cause of a boot failure when there were two.
 */
export const run = Effect.fn('Preflight.run')(function* (bins: Binaries, host: Host) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const checks: Array<Check> = []
  const add = (name: string, outcome: Outcome): void => void checks.push({ name, outcome })

  // Checked first because it is a property of the install rather than of the
  // host, and because the way it breaks is silent: a compiled binary has no
  // source location to derive this from, so the packaged CLI is a wrapper that
  // sets `IGLOO_FLAKE`. Running the binary inside that wrapper directly leaves
  // the path pointing inside bun's virtual filesystem, and the first thing to
  // notice is nix, several steps later, failing on a flake that is not there.
  add(
    'igloo flake',
    (yield* fs
      .exists(path.join(host.iglooFlake, 'flake.nix'))
      .pipe(Effect.orElseSucceed(() => false)))
      ? ok(host.iglooFlake)
      : failed(
          `no flake.nix under ${host.iglooFlake}`,
          'Run the `igloo` on PATH rather than the binary inside its wrapper, or point IGLOO_FLAKE at an igloo checkout.',
        ),
  )

  // Also a property of the install: home-manager writes the layer's store path
  // into the wrapper it installs, so this is where to find out which
  // configuration this `igloo` launches with.
  add(
    'user layer',
    host.userLayer === undefined
      ? ok('none, so a VM gets the core and its project’s layer only')
      : (yield* fs.exists(host.userLayer).pipe(Effect.orElseSucceed(() => false)))
        ? ok(host.userLayer)
        : failed(
            `IGLOO_USER_LAYER names ${host.userLayer}, which does not exist`,
            'Run the `igloo` home-manager installs, which sets it, or unset it for no user layer.',
          ),
  )

  add('nix', yield* starts(bins.nix, ['--version'], 'Install Nix, or point IGLOO_NIX at it.'))

  // Building a VM evaluates configuration the project supplies, and a
  // derivation it adds builds on this machine. The sandbox is what keeps that
  // build off the developer's filesystem and network. `relaxed` fails too: it
  // lets a derivation ask to be built without one.
  const sandbox = yield* spawner
    .lines(ChildProcess.make(bins.nix, ['config', 'show', 'sandbox'], { extendEnv: true }))
    .pipe(Effect.orElseSucceed(() => [] as Array<string>))
  const sandboxSetting = sandbox[0]?.trim()
  add(
    'nix build sandbox',
    sandboxSetting === 'true'
      ? ok('sandbox = true')
      : failed(
          sandboxSetting === undefined || sandboxSetting === ''
            ? 'cannot read nix’s `sandbox` setting'
            : `sandbox = ${sandboxSetting}, so a build can reach the host it runs on`,
          'Set `sandbox = true` in nix.conf (on NixOS, `nix.settings.sandbox = true`) and restart the daemon.',
        ),
  )
  // `-V` rather than `--version`: ssh does not have the long form and exits 255
  // on an unrecognised option, which would read as a broken ssh.
  add('ssh', yield* starts(bins.ssh, ['-V'], 'Install OpenSSH, or point IGLOO_SSH at it.'))

  // The default is a NixOS path, so this is the check most likely to fail on a
  // host that is otherwise fine — and its symptom is the 90s vsock timeout,
  // because ssh cannot reach a guest whose ProxyCommand does not exist.
  add(
    'ssh vsock proxy',
    (yield* fs.access(bins.sshProxy, { ok: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ))
      ? ok(bins.sshProxy)
      : failed(
          `${bins.sshProxy} does not exist`,
          'Point IGLOO_SSH_PROXY at systemd-ssh-proxy (under systemd’s libexec or lib directory).',
        ),
  )

  // `systemd-run` parses every property itself before it sends a unit to the
  // manager, so an older one refuses a newer property as an unknown assignment
  // and the launch stops at its first unit.
  const systemdRun = systemdRelease(yield* firstLine(bins.systemdRun, ['--version']))
  add('systemd-run', systemdRunOutcome(bins.systemdRun, systemdRun))
  // The user manager, not just the binary: every VM runs in a transient user
  // unit, without a user bus `systemd-run --user` fails at launch, and the
  // manager applies the properties. It can be older than the binary, on a host
  // that upgraded systemd without restarting it.
  const manager = yield* firstLine(bins.systemctl, [
    '--user',
    'show',
    '--property=Version',
    '--value',
  ])
  add('systemd user manager', userManagerOutcome(systemdRelease(manager), systemdRun))

  // Without lingering the user manager stops at logout and takes every running
  // VM with it — which contradicts the one property the lifetime split exists
  // to provide, and does so silently, hours after launch.
  const linger = yield* spawner
    .lines(
      ChildProcess.make(bins.loginctl, ['show-user', host.user, '--property=Linger', '--value'], {
        extendEnv: true,
      }),
    )
    .pipe(Effect.orElseSucceed(() => [] as Array<string>))
  add(
    'user manager lingers',
    linger[0]?.trim() === 'yes'
      ? ok('user units survive logout')
      : failed(
          'lingering is off, so logging out stops every running VM',
          `Add "${host.user}" to \`programs.igloo.users\` in the NixOS configuration, or run \`loginctl enable-linger ${host.user}\`.`,
        ),
  )

  add(
    '/dev/kvm',
    yield* device('/dev/kvm', 'Add your user to the `kvm` group and start a new session.'),
  )
  // The management channel is AF_VSOCK, so this is not optional even for a VM
  // with no network at all.
  add(
    '/dev/vhost-vsock',
    yield* device(
      '/dev/vhost-vsock',
      'Load the vhost_vsock module (`modprobe vhost_vsock`); systemd’s udev rules make the node world-accessible.',
    ),
  )

  // One process per share, started by igloo rather than by anything the build
  // produced — so it is a host binary like the others, and missing it presents
  // as a VM whose sockets never appear.
  add(
    'virtiofsd',
    yield* starts(
      bins.virtiofsd,
      ['--version'],
      'Point IGLOO_VIRTIOFSD at the virtiofsd of the igloo flake; the devshell does this for you.',
    ),
  )

  add('store view', yield* storeView(bins))

  // Only a VM with a broker needs it, but that is every VM with a network or a
  // brokered credential.
  add('landlock', yield* landlock(bins))

  // Only `igloo fallback` runs bubblewrap, which is the one command meant to
  // work when a VM will not start — so this is checked with the rest rather
  // than discovered when it is needed. A setuid bubblewrap fails here: modern
  // builds refuse to exec that way, and no build flag brings it back.
  add(
    'bubblewrap',
    yield* starts(
      bins.bwrap,
      [...(yield* hostRootBinds()), '--', 'true'],
      'Install a non-setuid bubblewrap and point IGLOO_BWRAP at it; unprivileged user namespaces must be enabled. Only `igloo fallback` needs it.',
    ),
  )

  add(
    'XDG_RUNTIME_DIR',
    host.runtimeDir === undefined
      ? failed(
          'unset, so there is nowhere to put a VM’s vhost-user sockets',
          'Start a proper login session, or set XDG_RUNTIME_DIR to a private tmpfs.',
        )
      : (yield* fs.access(host.runtimeDir, { writable: true }).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ))
        ? ok(host.runtimeDir)
        : failed(`${host.runtimeDir} is not writable`, 'Check its ownership and mode.'),
  )

  return checks
})

/** How many checks came back failed. */
export const failures = (checks: readonly Check[]): number =>
  checks.filter(check => check.outcome._tag === 'Failed').length

/**
 * The report, as a block of text. Pure, so the alignment and the summary line
 * are asserted rather than eyeballed.
 */
export const report = (checks: readonly Check[]): string => {
  const width = Math.max(0, ...checks.map(check => check.name.length))
  const lines: Array<string> = []
  for (const { name, outcome } of checks) {
    const status = outcome._tag === 'Ok' ? 'ok  ' : 'FAIL'
    lines.push(`  ${status}  ${name.padEnd(width)}  ${outcome.detail}`)
    if (outcome._tag === 'Failed') lines.push(`        → ${outcome.remedy}`)
  }
  const bad = failures(checks)
  lines.push('')
  lines.push(
    bad === 0 ? `All ${checks.length} checks passed.` : `${bad} of ${checks.length} checks failed.`,
  )
  return lines.join('\n')
}
