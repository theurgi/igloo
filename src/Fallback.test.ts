import { BunServices } from '@effect/platform-bun'
import { afterAll, assert, beforeAll, describe, it, vi } from '@effect/vitest'
import { Effect, FileSystem, Result } from 'effect'

import * as Binaries from './Binaries.ts'
import * as BootLog from './BootLog.ts'
import * as Fallback from './Fallback.ts'

// A session narrates itself on stderr for whoever started it. Here that is the
// test run, where it is noise between the results.
beforeAll(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterAll(() => {
  vi.restoreAllMocks()
})

const session: Fallback.Session = {
  homeSource: '/host/proj/.igloo/home',
  id: 'proj-2a',
  label: 'proj',
  logDir: '/host/proj/.igloo/logs',
  runnerRootLink: '/host/proj/.igloo/runners/current',
  workspaceSource: '/host/proj/workspace',
}

const host: Fallback.Host = {
  env: {
    ANTHROPIC_API_KEY: 'sk-not-for-the-sandbox',
    PATH: '/run/current-system/sw/bin:/nix/store/aaa-bun/bin',
    SSL_CERT_FILE: '/etc/ssl/certs/ca-bundle.crt',
    TERM: 'xterm-kitty',
    TERMINFO_DIRS: '/run/current-system/sw/share/terminfo',
  },
  user: 'tester',
}

const shell = '/nix/store/bbb-bash/bin/bash'
const guest = '/nix/store/ccc-system-path'
const args = Fallback.argv(Fallback.layoutFor(session, host, undefined, shell))
const withGuest = Fallback.argv(Fallback.layoutFor(session, host, guest, shell))

/** Walk the flat argv for a `flag a b` triple, e.g. `--bind src dst`. */
const hasTriple = (argv: readonly string[], flag: string, a: string, b: string): boolean => {
  for (let i = 0; i < argv.length - 2; i++) {
    if (argv[i] === flag && argv[i + 1] === a && argv[i + 2] === b) return true
  }
  return false
}

const setenv = (argv: readonly string[], name: string): string | undefined => {
  for (let i = 0; i < argv.length - 2; i++) {
    if (argv[i] === '--setenv' && argv[i + 1] === name) return argv[i + 2]
  }
  return undefined
}

describe('Fallback.argv', () => {
  it('mounts the project where the VM mounts it', () => {
    assert.isTrue(hasTriple(args, '--bind', '/host/proj/workspace', '/workspace'))
    assert.isTrue(hasTriple(args, '--bind', '/host/proj/.igloo/home', '/root'))
    assert.strictEqual(setenv(args, 'HOME'), '/root')
    assert.strictEqual(setenv(args, 'USER'), 'tester')
    assert.strictEqual(setenv(args, 'TERM'), 'xterm-kitty')
    assert.strictEqual(args[args.indexOf('--chdir') + 1], '/workspace')
  })

  it('binds the whole store read-only rather than one runner’s closure', () => {
    assert.isTrue(hasTriple(args, '--ro-bind', '/nix', '/nix'))
    assert.isFalse(args.includes('--tmpfs') && args[args.indexOf('--tmpfs') + 1] === '/nix/store')
  })

  it('clears the environment and carries in only the named variables', () => {
    // `--clearenv` has to precede every `--setenv`, or it would undo them.
    assert.strictEqual(args.indexOf('--clearenv'), 0)
    assert.strictEqual(setenv(args, 'SSL_CERT_FILE'), '/etc/ssl/certs/ca-bundle.crt')
    // A credential exported in the shell that typed the command is not one of
    // them, by name or by value.
    assert.isUndefined(setenv(args, 'ANTHROPIC_API_KEY'))
    assert.isFalse(args.some(arg => arg.includes('sk-not-for-the-sandbox')))
  })

  it('puts the guest’s profile first on PATH, then the host’s, then the home’s', () => {
    assert.deepStrictEqual((setenv(withGuest, 'PATH') ?? '').split(':'), [
      '/nix/store/ccc-system-path/bin',
      '/run/current-system/sw/bin',
      '/nix/store/aaa-bun/bin',
      '/root/.bun/bin',
      '/root/.local/bin',
    ])
  })

  it('opens on the host’s PATH alone when no runner has built', () => {
    assert.deepStrictEqual((setenv(args, 'PATH') ?? '').split(':'), [
      '/run/current-system/sw/bin',
      '/nix/store/aaa-bun/bin',
      '/root/.bun/bin',
      '/root/.local/bin',
    ])
  })

  it('finds the host’s TERM in the guest’s terminfo first, then the host’s', () => {
    assert.strictEqual(
      setenv(withGuest, 'TERMINFO_DIRS'),
      '/nix/store/ccc-system-path/share/terminfo:/run/current-system/sw/share/terminfo',
    )
    assert.strictEqual(setenv(args, 'TERMINFO_DIRS'), '/run/current-system/sw/share/terminfo')
    const bare = Fallback.argv(
      Fallback.layoutFor(session, { env: {}, user: 'tester' }, undefined, shell),
    )
    assert.isUndefined(setenv(bare, 'TERMINFO_DIRS'))
  })

  it('keeps the network, the PID namespace and the session, and unshares the rest', () => {
    // Each of these three breaks something the sandbox is for: egress, job
    // control, and a terminal resize reaching what is drawing.
    assert.isFalse(args.includes('--unshare-net'))
    assert.isFalse(args.includes('--unshare-pid'))
    assert.isFalse(args.includes('--new-session'))
    for (const flag of [
      '--unshare-user',
      '--unshare-ipc',
      '--unshare-uts',
      '--unshare-cgroup',
      '--die-with-parent',
    ]) {
      assert.isTrue(args.includes(flag), flag)
    }
  })

  it('puts the session in a scope of its own, outside any VM’s slice', () => {
    const scope = Fallback.scopeArgs('igloo-proj-2a-fallback-x.scope')
    assert.deepStrictEqual(scope.slice(0, 2), ['--user', '--scope'])
    assert.isTrue(scope.includes('--unit=igloo-proj-2a-fallback-x.scope'))
    // `down` stops the VM's slice, and must not take this session with it.
    assert.isFalse(scope.some(arg => arg.startsWith('--slice')))
    assert.strictEqual(scope.at(-1), '--')
  })

  it('starts the shell without the startup files in the home it just bound', () => {
    const separator = args.lastIndexOf('--')
    assert.deepStrictEqual(args.slice(separator + 1), [shell, '--noprofile', '--norc', '-i'])
    assert.strictEqual(setenv(args, 'SHELL'), shell)
  })
})

const writeScript = Effect.fnUntraced(function* (file: string, body: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.writeFileString(file, `#!/usr/bin/env bash\n${body}\n`)
  yield* fs.chmod(file, 0o755)
  return file
})

/**
 * Stand-ins for the three programs a session runs, each logging its argv to a
 * file of its own name. `systemd-run` either refuses every scope, as a host
 * with no reachable user manager does, or runs whatever follows `--` in its
 * own process, as a real scope does.
 */
const fakes = Effect.fnUntraced(function* (
  dir: string,
  options: { readonly code: number; readonly scopes: boolean },
) {
  const log = (name: string) => `printf '%s\\n' "$*" >> '${dir}/${name}.log'`
  return {
    ...Binaries.fromEnv({}),
    bwrap: yield* writeScript(`${dir}/bwrap`, `${log('bwrap')}\nexit ${options.code}`),
    systemctl: yield* writeScript(`${dir}/systemctl`, log('systemctl')),
    systemdRun: yield* writeScript(
      `${dir}/systemd-run`,
      options.scopes
        ? `${log('systemd-run')}\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"`
        : `${log('systemd-run')}\nexit 1`,
    ),
  } satisfies Binaries.Binaries
})

const readLog = Effect.fnUntraced(function* (dir: string, name: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(`${dir}/${name}.log`).pipe(Effect.orElseSucceed(() => ''))
})

const sessionIn = (tmp: string): Fallback.Session => ({
  homeSource: `${tmp}/home`,
  id: 'proj-2a',
  label: 'proj',
  logDir: `${tmp}/logs`,
  runnerRootLink: `${tmp}/runners/current`,
  workspaceSource: `${tmp}/workspace`,
})

describe('Fallback.run', () => {
  it.effect('returns the shell’s exit code and leaves a record of the session', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      const bins = yield* fakes(tmp, { code: 17, scopes: true })

      const code = yield* Fallback.run(bins, sessionIn(tmp), {
        env: process.env,
        user: 'tester',
      })

      assert.strictEqual(code, 17)
      // The bind sources are created rather than assumed: bwrap refuses a
      // `--bind` of a missing directory, and reports it as a namespace failure.
      assert.isTrue(yield* fs.exists(`${tmp}/home`))
      assert.isTrue(yield* fs.exists(`${tmp}/workspace`))

      const latest = `${tmp}/logs/${BootLog.LATEST}`
      const trail = yield* fs.readFileString(`${latest}/boot.jsonl`)
      // The whole invocation, which is the only account of a sandbox that fails
      // inside bwrap's own argument handling.
      assert.isTrue(trail.includes('"event":"sandbox"'))
      assert.isTrue(trail.includes(bins.bwrap))
      const summary = yield* fs.readFileString(`${latest}/boot.json`)
      assert.isTrue(summary.includes('"name": "sandbox"'))
      assert.isTrue(summary.includes('"outcome": "success"'))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect('runs the shell in a scope, and stops the scope once the shell exits', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      const bins = yield* fakes(tmp, { code: 0, scopes: true })

      yield* Fallback.run(bins, sessionIn(tmp), { env: process.env, user: 'tester' })

      const scope = /--unit=(igloo-proj-2a-fallback-\S+\.scope)/.exec(
        yield* readLog(tmp, 'systemd-run'),
      )?.[1]
      assert.isDefined(scope)
      // The sandbox ran inside it, and the stop came after, by the same name:
      // that stop is what reaches a job the shell left in the background.
      assert.isTrue((yield* readLog(tmp, 'bwrap')).includes('--clearenv'))
      assert.strictEqual((yield* readLog(tmp, 'systemctl')).trim(), `--user stop ${scope}`)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect('opens without a scope when systemd will not create one', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      const bins = yield* fakes(tmp, { code: 3, scopes: false })

      const code = yield* Fallback.run(bins, sessionIn(tmp), {
        env: process.env,
        user: 'tester',
      })

      // The shell's own exit code, not `systemd-run`'s refusal.
      assert.strictEqual(code, 3)
      assert.isTrue((yield* readLog(tmp, 'bwrap')).includes('--clearenv'))
      assert.strictEqual(yield* readLog(tmp, 'systemctl'), '')
      const trail = yield* fs.readFileString(`${tmp}/logs/${BootLog.LATEST}/boot.jsonl`)
      assert.isTrue(trail.includes('"scope":null'))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect('fails with a message rather than a namespace error when bwrap is missing', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      const bins = yield* fakes(tmp, { code: 0, scopes: true })

      const result = yield* Effect.result(
        Fallback.run({ ...bins, bwrap: `${tmp}/absent-bwrap` }, sessionIn(tmp), {
          env: process.env,
          user: 'tester',
        }),
      )

      assert.isTrue(Result.isFailure(result))
      // Caught before the scope, whose `systemd-run` would have reported it as
      // an exit code instead.
      assert.strictEqual(yield* readLog(tmp, 'systemd-run'), '')
      // The failure is still recorded: a session that never opened is exactly
      // the one whose account is wanted afterwards.
      const summary = yield* fs.readFileString(`${tmp}/logs/${BootLog.LATEST}/boot.json`)
      assert.isTrue(summary.includes('"outcome": "failure"'))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect('takes the guest’s profile from the last runner that built, as a store path', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      const bins = yield* fakes(tmp, { code: 0, scopes: true })
      // The shape a built runner has: the gc-root links to the runner, and the
      // runner links to the guest's system, whose profile is `sw`.
      yield* fs.makeDirectory(`${tmp}/store/system/sw/bin`, { recursive: true })
      yield* fs.makeDirectory(`${tmp}/store/runner/share/microvm`, { recursive: true })
      yield* fs.symlink(`${tmp}/store/system`, `${tmp}/store/runner/share/microvm/system`)
      yield* fs.makeDirectory(`${tmp}/runners`)
      yield* fs.symlink(`${tmp}/store/runner`, `${tmp}/runners/current`)

      yield* Fallback.run(bins, sessionIn(tmp), { env: process.env, user: 'tester' })

      // Resolved through both links: the gc-root is under `.igloo/`, which the
      // sandbox does not mount.
      const profile = yield* fs.realPath(`${tmp}/store/system/sw`)
      const recorded = yield* readLog(tmp, 'bwrap')
      assert.isTrue(recorded.includes(`--setenv PATH ${profile}/bin:`), recorded)
      assert.isTrue(recorded.includes(`--setenv TERMINFO_DIRS ${profile}/share/terminfo`))
      assert.isFalse(recorded.includes('runners/current'))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )
})
