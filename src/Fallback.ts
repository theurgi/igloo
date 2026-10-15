import type { Binaries } from './Binaries.ts'

import { Effect, FileSystem, Schema } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import * as BootLog from './BootLog.ts'
import * as Systemd from './Systemd.ts'

export class FallbackError extends Schema.TaggedError<FallbackError>()('FallbackError', {
  message: Schema.String,
}) {}

/**
 * Where the project's two directories are mounted, which is where the VM's
 * shares put them.
 *
 * The layout is the continuity: an agent finds its configuration under the same
 * `/root`, and the working directory its history is keyed to is the same path
 * it was in the guest.
 */
const WORKSPACE = '/workspace'
const HOME = '/root'

/**
 * Host variables carried in, and the whole of what is carried.
 *
 * The environment is cleared first, so a credential exported in the shell that
 * typed the command does not follow an agent into the sandbox. What is left
 * decides how output renders, where TLS roots are found, and what time it is.
 */
const CARRIED = [
  'COLORTERM',
  'LANG',
  'LC_ALL',
  'NIX_SSL_CERT_FILE',
  'SSL_CERT_FILE',
  'TERMINFO',
  'TZ',
]

/**
 * What the sandbox takes from the host, passed in rather than read here.
 *
 * The process environment has one reader in this tool, and a sandbox assembled
 * from ambient state is one nothing can assert against.
 */
export interface Host {
  readonly env: Record<string, string | undefined>
  readonly user: string
}

/** The project this session is for, and nothing else about it. */
export interface Session {
  /** Backs `/root`. The same directory the VM's home share serves. */
  readonly homeSource: string
  /** The project's id, which names the session's scope. */
  readonly id: string
  /** For messages. */
  readonly label: string
  /** The project's log directory. A session records itself the way a boot does. */
  readonly logDir: string
  /** The gc-root of the last runner that built. It need not exist. */
  readonly runnerRootLink: string
  /** Bound at `/workspace`. */
  readonly workspaceSource: string
}

export interface Layout {
  /** Host variables to carry in, already narrowed to the ones that are set. */
  readonly carried: Readonly<Record<string, string>>
  readonly homeSource: string
  readonly path: string
  /** Absolute path to the shell, resolved on the host so `/nix` covers it. */
  readonly shell: string
  readonly term: string
  /** `TERMINFO_DIRS`, or empty for none. */
  readonly terminfoDirs: string
  readonly user: string
  readonly workspaceSource: string
}

const carriedFrom = (env: Record<string, string | undefined>): Record<string, string> => {
  const carried: Record<string, string> = {}
  for (const name of CARRIED) {
    const value = env[name]
    if (value !== undefined && value !== '') carried[name] = value
  }
  return carried
}

const joined = (entries: ReadonlyArray<string | undefined>): string =>
  entries.filter(entry => entry !== undefined && entry !== '').join(':')

/**
 * The sandbox's `PATH`: the guest's system profile when there is one, then the
 * host's own, then the home's two bin directories.
 *
 * The guest's packages come first because they are what the sandbox stands in
 * for — the agents a project runs are declared for the guest and are not
 * installed on the host at all. The host's tools follow, for whatever the guest
 * lacks, and what an agent installed for itself in the home is still reachable.
 */
export const searchPath = (host: Host, guest: string | undefined): string =>
  joined([
    guest === undefined ? undefined : `${guest}/bin`,
    host.env['PATH'],
    `${HOME}/.bun/bin`,
    `${HOME}/.local/bin`,
  ])

/**
 * What to mount, what to carry in, and what to run — pure, so the sandbox a
 * session gets is asserted rather than assembled twice.
 *
 * `guest` is the guest's system profile, a store path. Its terminfo comes
 * first for the same reason its binaries do: the guest carries entries for the
 * terminals the host's `TERM` names, and the cleared environment would
 * otherwise leave ncurses nothing but its compiled-in database.
 */
export const layoutFor = (
  session: Session,
  host: Host,
  guest: string | undefined,
  shell: string,
): Layout => ({
  carried: carriedFrom(host.env),
  homeSource: session.homeSource,
  path: searchPath(host, guest),
  shell,
  term: host.env['TERM'] ?? 'xterm-256color',
  terminfoDirs: joined([
    guest === undefined ? undefined : `${guest}/share/terminfo`,
    host.env['TERMINFO_DIRS'],
  ]),
  user: host.user,
  workspaceSource: session.workspaceSource,
})

/**
 * The bubblewrap arguments, everything after the binary itself.
 *
 * This is weaker isolation than a VM and the bind list is where that is
 * visible: the host's kernel, the host's network namespace, and the whole store
 * rather than one runner's closure. The sandbox has to open when no runner has
 * built, and the host's tools on `PATH` are outside any runner's closure.
 */
export const argv = (layout: Layout): Array<string> => [
  // First, so that everything the sandbox has is named below.
  '--clearenv',
  // Every binary on a Nix host is under here.
  '--ro-bind',
  '/nix',
  '/nix',
  // The resolver, the CA bundle and the user database. Without it the sandbox
  // resolves no names and `whoami` has nothing to answer from.
  '--ro-bind',
  '/etc',
  '/etc',
  // The system profile. `-try` because a machine with Nix but not NixOS has no
  // such path, and the rest of this works there.
  '--ro-bind-try',
  '/run/current-system',
  '/run/current-system',
  // The two interpreters a `#!` line names by path rather than by store path.
  '--ro-bind',
  '/bin/sh',
  '/bin/sh',
  '--ro-bind-try',
  '/usr/bin/env',
  '/usr/bin/env',
  '--proc',
  '/proc',
  '--dev',
  '/dev',
  '--tmpfs',
  '/tmp',
  '--bind',
  layout.workspaceSource,
  WORKSPACE,
  '--bind',
  layout.homeSource,
  HOME,
  '--setenv',
  'HOME',
  HOME,
  '--setenv',
  'USER',
  layout.user,
  '--setenv',
  'PATH',
  layout.path,
  '--setenv',
  'TERM',
  layout.term,
  '--setenv',
  'SHELL',
  layout.shell,
  ...(layout.terminfoDirs === '' ? [] : ['--setenv', 'TERMINFO_DIRS', layout.terminfoDirs]),
  ...Object.entries(layout.carried).flatMap(([name, value]) => ['--setenv', name, value]),
  '--chdir',
  WORKSPACE,
  // Everything except the network and the PID namespace.
  //
  // Egress is what an agent is here for. The PID namespace would leave the
  // shell's controlling terminal owned by a session in the parent namespace,
  // where bash reads a foreground process group that does not exist locally and
  // job control fails on the first backgrounded command. `--new-session` is
  // absent for the neighbouring reason: it detaches the shell from the terminal
  // entirely, and a resize then reaches nothing drawing inside.
  '--unshare-user',
  '--unshare-ipc',
  '--unshare-uts',
  '--unshare-cgroup',
  '--die-with-parent',
  '--',
  // Without the startup files in `/root`. That directory is written by whatever
  // ran in the VM, and this shell runs on the host as the developer — so
  // sourcing them would execute guest-authored script outside the boundary this
  // sandbox is standing in for. `. ~/.bash_profile` is one line for whoever
  // wants them anyway.
  layout.shell,
  '--noprofile',
  '--norc',
  '-i',
]

/**
 * `systemd-run` arguments that put the sandbox in a transient scope of its
 * own — everything before the command.
 *
 * A scope runs the command in `systemd-run`'s own process rather than under
 * the manager, so the shell keeps this terminal, this session and job control.
 * What it adds is a cgroup, and stopping the scope empties it — including
 * whatever the shell left running in the background when it exited, which
 * nothing else here would reach. Not in the VM's slice: `down` must not end a
 * session opened because the VM would not start.
 */
export const scopeArgs = (unit: string): Array<string> => [
  '--user',
  '--scope',
  '--quiet',
  // Drop the unit once it is empty, however it got that way.
  '--collect',
  `--unit=${unit}`,
  // A process that ignores SIGTERM is killed after this, rather than holding
  // the host's prompt for the default ninety seconds.
  '--property=TimeoutStopSec=5',
  '--',
]

/**
 * Whether a transient scope can be created here, found out by creating one.
 *
 * Asked by doing rather than by checking for a user bus, because once the real
 * `systemd-run` has failed, its exit code cannot be told apart from the shell's.
 */
const scopes = Effect.fnUntraced(function* (systemdRun: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const code = yield* spawner
    .exitCode(
      ChildProcess.make(systemdRun, ['--user', '--scope', '--quiet', '--', 'true'], {
        extendEnv: true,
        stderr: 'ignore',
        stdin: 'ignore',
        stdout: 'ignore',
      }),
    )
    .pipe(Effect.orElseSucceed(() => -1))
  return code === 0
})

/**
 * The first executable `name` on `pathEnv`, resolved through symlinks so the
 * result is the store path the `/nix` bind already covers rather than a profile
 * link that may not be.
 */
const onPath = Effect.fnUntraced(function* (pathEnv: string, name: string) {
  const fs = yield* FileSystem.FileSystem
  for (const dir of pathEnv.split(':')) {
    if (dir === '') continue
    const candidate = `${dir}/${name}`
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return yield* fs.realPath(candidate).pipe(Effect.orElseSucceed(() => candidate))
    }
  }
  return undefined
})

/**
 * The guest's system profile, read off the last runner that built, or
 * `undefined` if none has.
 *
 * Nothing is evaluated or built to find it, so a project whose configuration
 * is what broke still gets the packages its VM last had. Resolved to the store
 * path because the gc-root itself lives under `.igloo/`, which the sandbox does
 * not mount.
 */
const guestProfile = Effect.fnUntraced(function* (runnerRootLink: string) {
  const fs = yield* FileSystem.FileSystem
  const profile = `${runnerRootLink}/share/microvm/system/sw`
  if (!(yield* fs.exists(`${profile}/bin`).pipe(Effect.orElseSucceed(() => false)))) {
    return undefined
  }
  return yield* fs.realPath(profile).pipe(Effect.orElseSucceed(() => undefined))
})

const note = (message: string): Effect.Effect<void> =>
  Effect.sync(() => process.stderr.write(`igloo: ${message}\n`))

const enter = Effect.fnUntraced(function* (
  bins: Binaries,
  session: Session,
  host: Host,
  boot: BootLog.Boot,
) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const { args, bwrap, guest, scope } = yield* boot.phase(
    'sandbox',
    Effect.gen(function* () {
      // bwrap refuses a `--bind` whose source is missing, and reports it as a
      // failure to set up the namespace rather than as an absent directory.
      for (const dir of [session.homeSource, session.workspaceSource]) {
        yield* fs
          .makeDirectory(dir, { recursive: true })
          .pipe(Effect.mapError(() => new FallbackError({ message: `cannot create ${dir}` })))
      }
      // Resolved here rather than left to the spawn, which under a scope is
      // `systemd-run`'s, and would report a missing `bwrap` as an exit code.
      const bwrapPath = bins.bwrap.includes('/')
        ? (yield* fs.exists(bins.bwrap).pipe(Effect.orElseSucceed(() => false)))
          ? bins.bwrap
          : undefined
        : yield* onPath(host.env['PATH'] ?? '', bins.bwrap)
      if (bwrapPath === undefined) {
        return yield* new FallbackError({
          message: `cannot start ${bins.bwrap}; try \`igloo doctor\``,
        })
      }
      const scopeUnit = (yield* scopes(bins.systemdRun))
        ? `igloo-${session.id}-fallback-${boot.id}.scope`
        : undefined
      const guestPackages = yield* guestProfile(session.runnerRootLink)
      const shell = yield* onPath(searchPath(host, guestPackages), 'bash')
      if (shell === undefined) {
        return yield* new FallbackError({
          message: 'no bash on PATH, so there is no shell for the sandbox to start',
        })
      }
      const built = argv(layoutFor(session, host, guestPackages, shell))
      // The whole invocation, because a sandbox that will not open fails inside
      // bwrap's argument handling and the argv is the only account of why.
      yield* boot.record({
        argv: [bwrapPath, ...built],
        event: 'sandbox',
        scope: scopeUnit ?? null,
      })
      return { args: built, bwrap: bwrapPath, guest: guestPackages, scope: scopeUnit }
    }),
  )

  yield* note(
    `fallback sandbox for ${session.label} — the host's kernel, the host's network, and the whole store read-only. Weaker isolation than the VM, deliberately.`,
  )
  yield* note(
    guest === undefined
      ? "no runner has built for this project, so the guest's packages are not here — only the host's."
      : "the guest's packages come first on PATH, as of the last runner that built.",
  )
  yield* note(
    "/root is the VM's home and its startup files are not sourced here; `. ~/.bash_profile` if you want them.",
  )
  if (scope === undefined) {
    yield* note(
      'systemd could not give this session a scope, so anything still running when the shell exits is left running.',
    )
  }

  // `detached: false` is load-bearing. The spawner otherwise puts the shell in
  // a new session with no controlling terminal, where bash cannot set the
  // foreground process group — job control dies and a resize reaches nothing.
  // Sharing this process's session is also what makes a relay unnecessary: the
  // shell is in the terminal's foreground group, so SIGWINCH arrives on its own.
  const [program, programArgs] =
    scope === undefined ? [bwrap, args] : [bins.systemdRun, [...scopeArgs(scope), bwrap, ...args]]
  const code = yield* Effect.gen(function* () {
    const shell = yield* spawner
      .spawn(
        ChildProcess.make(program, programArgs, {
          detached: false,
          extendEnv: true,
          stderr: 'inherit',
          stdin: 'inherit',
          stdout: 'inherit',
        }),
      )
      .pipe(
        Effect.mapError(
          () => new FallbackError({ message: `cannot start ${program}; try \`igloo doctor\`` }),
        ),
      )
    return yield* shell.exitCode.pipe(Effect.orElseSucceed(() => 255))
  }).pipe(
    // After the shell, whatever it left running. An empty scope has already
    // gone, and stopping it then is a no-op.
    Effect.ensuring(scope === undefined ? Effect.void : Systemd.stop(bins.systemctl, scope)),
  )
  // The session's other end. The summary cannot carry it — opening the sandbox
  // is what succeeded or failed there, and the shell's last command is a
  // different question.
  yield* boot.record({ code, event: 'exit' })
  return code
})

/**
 * Open the sandbox, hand over the terminal, and return the shell's exit code.
 *
 * It depends on as little as it can: a project marker, `bwrap`, and the host's
 * own tools. No build, no generated flake, no configuration and no VM — each of
 * those is something that can be the reason the VM will not start, and an escape
 * hatch cannot be reached through the thing it is an escape from. The last
 * runner that built supplies the guest's packages when there is one, and a
 * systemd scope ends whatever the shell leaves running; the sandbox opens
 * without either.
 */
export const run = Effect.fn('Fallback.run')(function* (
  bins: Binaries,
  session: Session,
  host: Host,
) {
  const boot = yield* BootLog.open(session.logDir).pipe(
    Effect.mapError(error => new FallbackError({ message: error.message })),
  )
  // The record covers the whole session rather than the setup alone, so its
  // duration is how long the sandbox was open and an abandoned one is still
  // `interrupted` in the summary.
  return yield* enter(bins, session, host, boot).pipe(Effect.onExit(exit => boot.finish(exit)))
}, Effect.scoped)
