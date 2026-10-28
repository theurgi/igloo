import { BunServices } from '@effect/platform-bun'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Result } from 'effect'

import * as Virtiofs from './Virtiofs.ts'

const share: Virtiofs.Served = {
  socket: 'guest-virtiofs-ro-store.sock',
  source: '/nix/store',
  store: true,
  tag: 'ro-store',
}

describe('Virtiofs.argv', () => {
  const owner = { gid: 100, uid: 1000 }
  const argv = Virtiofs.argv({ owner, share, threads: 8, virtiofsd: '/store/bin/virtiofsd' })

  it('binds the socket by the name the runner declared, relative', () => {
    // QEMU addresses the socket from its own working directory, so an absolute
    // path here would be a socket it never finds.
    assert.include(argv, `--socket-path=${share.socket}`)
    assert.strictEqual(argv[0], '/store/bin/virtiofsd')
  })

  it('serves the declared source', () => {
    assert.include(argv, `--shared-dir=${share.source}`)
  })

  it('asks for its own sandbox on every share, rather than relying on the default', () => {
    const home = Virtiofs.argv({
      owner,
      share: {
        socket: 'guest-virtiofs-home.sock',
        source: '/host/proj/.igloo/home',
        store: false,
        tag: 'home',
      },
      threads: 8,
      virtiofsd: '/store/bin/virtiofsd',
    })
    for (const daemon of [argv, home]) {
      assert.include(daemon, '--sandbox=namespace')
      assert.include(daemon, '--seccomp=kill')
    }
  })

  it('passes the thread count as a resolved number', () => {
    // Not a shell expansion: the daemon serving the store runs where `/nix/store`
    // is one closure, and `$(nproc)` there depends on coreutils being in it.
    const at = argv.indexOf('--thread-pool-size')
    assert.notStrictEqual(at, -1)
    assert.strictEqual(argv[at + 1], '8')
  })

  it('shows the guest the store as root’s, where the daemon reads it as nobody’s', () => {
    assert.include(argv, '--translate-uid=host:65534:0:1')
    assert.include(argv, '--translate-gid=host:65534:0:1')
    // virtiofsd refuses a translation alongside POSIX ACLs.
    assert.notInclude(argv, '--posix-acl')
  })

  it('shows the guest what the store view made for itself as root’s too', () => {
    // The store directory, and a top-level symlink recreated rather than bound,
    // are the invoking user's: the one id in the view that is not the host
    // store's own.
    assert.include(argv, '--translate-uid=host:1000:0:1')
    assert.include(argv, '--translate-gid=host:100:0:1')
  })

  it('refuses the guest’s writes to the store itself, not only in the guest’s mount', () => {
    assert.include(argv, '--readonly')
  })

  it('translates nothing on a share the invoking user owns', () => {
    const home = Virtiofs.argv({
      owner,
      share: {
        socket: 'guest-virtiofs-home.sock',
        source: '/host/proj/.igloo/home',
        store: false,
        tag: 'home',
      },
      threads: 8,
      virtiofsd: '/store/bin/virtiofsd',
    })
    assert.isFalse(home.some(arg => arg.startsWith('--translate-')))
    assert.notInclude(home, '--readonly')
    assert.include(home, '--posix-acl')
  })

  it('suppresses submount announcements', () => {
    // Without it the guest auto-mounts a virtiofs per closure path, and tearing
    // those down at poweroff hangs the shutdown job.
    assert.include(argv, '--no-announce-submounts')
  })
})

describe('Virtiofs.match', () => {
  const expected = [
    { source: '/p/home', tag: 'home' },
    { source: '/p/workspace', tag: 'workspace' },
  ]
  const declared: Virtiofs.Share[] = [
    { socket: 'g-virtiofs-home.sock', source: '/p/home', tag: 'home' },
    { socket: 'g-virtiofs-ro-store.sock', source: '/nix/store', tag: 'ro-store' },
    { socket: 'g-virtiofs-workspace.sock', source: '/p/workspace', tag: 'workspace' },
  ]
  const refusal = (shares: readonly Virtiofs.Share[]): string => {
    const result = Virtiofs.match(shares, expected)
    return Result.isFailure(result) ? result.failure : ''
  }

  it('serves the shares asked for, in the order declared, marking the store’s', () => {
    const result = Virtiofs.match(declared, expected)
    assert.isTrue(Result.isSuccess(result))
    assert.deepStrictEqual(
      Result.isSuccess(result) ? result.success.map(({ store, tag }) => ({ store, tag })) : [],
      [
        { store: false, tag: 'home' },
        { store: true, tag: 'ro-store' },
        { store: false, tag: 'workspace' },
      ],
    )
  })

  it('refuses a share nothing asked for', () => {
    assert.include(
      refusal([...declared, { socket: 'escape.sock', source: '/home', tag: 'escape' }]),
      'did not ask for: escape, of /home',
    )
  })

  it('refuses a share asked for, from another source', () => {
    assert.include(
      refusal(
        declared.map(entry => (entry.tag === 'home' ? { ...entry, source: '/home' } : entry)),
      ),
      'declares home as /home, where igloo asked for /p/home',
    )
  })

  it('refuses the store by any other spelling of its path', () => {
    // Served as one of the project's, it would be the whole host store rather
    // than one closure.
    for (const source of ['/nix/store/', '/nix//store', '/nix/store/.']) {
      assert.include(
        refusal(declared.map(entry => (entry.tag === 'ro-store' ? { ...entry, source } : entry))),
        `declares ro-store as ${source}`,
      )
    }
  })

  it('refuses a socket that is not a bare file name', () => {
    for (const socket of ['../escape.sock', '/run/user/1000/escape.sock', 'a/b.sock', '.', '..']) {
      assert.include(
        refusal(declared.map(entry => (entry.tag === 'home' ? { ...entry, socket } : entry))),
        `names home's socket ${socket}, which is not a file name`,
      )
    }
  })

  it('refuses a runner missing a share asked for, the store’s included', () => {
    assert.include(
      refusal(declared.filter(entry => entry.tag === 'home')),
      'declares no share for ro-store, workspace',
    )
  })
})

describe('Virtiofs.shares', () => {
  const runnerWith = Effect.fnUntraced(function* (entries: Record<string, Record<string, string>>) {
    const fs = yield* FileSystem.FileSystem
    const out = yield* fs.makeTempDirectoryScoped()
    for (const [tag, fields] of Object.entries(entries)) {
      const dir = `${out}/share/microvm/virtiofs/${tag}`
      yield* fs.makeDirectory(dir, { recursive: true })
      for (const [name, value] of Object.entries(fields)) {
        yield* fs.writeFileString(`${dir}/${name}`, value)
      }
    }
    return out
  })

  it.effect('reads each share, trimming the trailing newline', () =>
    Effect.gen(function* () {
      const out = yield* runnerWith({
        'ro-store': { socket: 'g-virtiofs-ro-store.sock\n', source: '/nix/store\n' },
      })
      assert.deepStrictEqual(yield* Virtiofs.shares(out), [
        { socket: 'g-virtiofs-ro-store.sock', source: '/nix/store', tag: 'ro-store' },
      ])
      // A trailing newline in the socket name would produce a daemon binding a
      // path QEMU never looks for, and nothing before the readiness timeout
      // would say so.
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect('orders them so the daemons start the same way every time', () =>
    Effect.gen(function* () {
      const out = yield* runnerWith({
        home: { socket: 'g-virtiofs-home.sock', source: '/p/home' },
        'ro-store': { socket: 'g-virtiofs-ro-store.sock', source: '/nix/store' },
        workspace: { socket: 'g-virtiofs-workspace.sock', source: '/p/workspace' },
      })
      assert.deepStrictEqual(
        (yield* Virtiofs.shares(out)).map(s => s.tag),
        ['home', 'ro-store', 'workspace'],
      )
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect('skips an entry with no socket rather than serving an empty path', () =>
    Effect.gen(function* () {
      const out = yield* runnerWith({
        dax: { source: '/p/dax' },
        workspace: { socket: 'g-virtiofs-workspace.sock', source: '/p/workspace' },
      })
      assert.deepStrictEqual(
        (yield* Virtiofs.shares(out)).map(s => s.tag),
        ['workspace'],
      )
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect('finds nothing in a runner that declares nothing', () =>
    Effect.gen(function* () {
      assert.isEmpty(yield* Virtiofs.shares(yield* runnerWith({})))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )
})
