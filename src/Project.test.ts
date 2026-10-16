import { BunServices } from '@effect/platform-bun'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Scope } from 'effect'
import * as path from 'node:path'

import * as Cid from './Cid.ts'
import * as Project from './Project.ts'

const provided = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(BunServices.layer))

describe('Project.forRoot', () => {
  it('puts everything durable under .igloo/', () => {
    const project = Project.forRoot('/home/you/projects/api')
    assert.strictEqual(project.iglooDir, '/home/you/projects/api/.igloo')
    assert.strictEqual(project.homeDir, '/home/you/projects/api/.igloo/home')
    assert.strictEqual(project.sshDir, '/home/you/projects/api/.igloo/ssh')
    assert.strictEqual(project.tlsDir, '/home/you/projects/api/.igloo/tls')
    assert.strictEqual(project.logDir, '/home/you/projects/api/.igloo/logs')
    assert.strictEqual(project.workspaceDir, '/home/you/projects/api/workspace')
  })

  it('names the gc-root so `nh clean` will not reap it', () => {
    // `nh clean` deletes indirect roots matching `.*result.*` or `.*\.direnv.*`
    // and then collects, which has taken the store out from under a live VM.
    const link = Project.forRoot('/home/you/projects/api').runnerRootLink
    assert.isFalse(/result|\.direnv/.test(link))
    assert.strictEqual(link, '/home/you/projects/api/.igloo/runners/current')
  })

  it('derives the CID from the path, not the label', () => {
    // Two projects with the same basename must not collide, or one project's
    // `up` finds the other's VM and reports it already running.
    const a = Project.forRoot('/home/you/work/api')
    const b = Project.forRoot('/home/you/personal/api')
    assert.strictEqual(a.label, b.label)
    assert.notStrictEqual(a.cid, b.cid)
    assert.notStrictEqual(a.id, b.id)
  })

  it('is stable for a path and matches Cid.forIdentity', () => {
    const root = '/home/you/projects/api'
    assert.strictEqual(Project.forRoot(root).cid, Cid.forIdentity(root))
    assert.strictEqual(Project.forRoot(root).id, Project.forRoot(root).id)
  })

  it('carries an overridden CID into the id', () => {
    // Otherwise `--cid` would leave the slice name advertising a CID the VM does
    // not have, and `ls` reads the CID off the slice name.
    const project = Project.forRoot('/home/you/projects/api', 0x2beef)
    assert.strictEqual(project.cid, 0x2beef)
    assert.strictEqual(project.id, 'api-2beef')
  })
})

describe('Project.parseId', () => {
  it('round-trips a label and CID through an id', () => {
    const project = Project.forRoot('/home/you/projects/api')
    assert.deepStrictEqual(Project.parseId(project.id), {
      cid: project.cid,
      label: 'api',
    })
  })

  it('keeps a hyphenated label whole', () => {
    const project = Project.forRoot('/home/you/projects/igloo-next')
    assert.strictEqual(Project.parseId(project.id)?.label, 'igloo-next')
  })

  it('does not mistake a label that ends in hex for a CID', () => {
    // `api-2c` is a plausible project name; 0x2c is far below the range derived
    // CIDs occupy, which is what distinguishes the two.
    assert.isUndefined(Project.parseId('api-2c'))
    assert.isUndefined(Project.parseId('api-beef'))
    assert.isUndefined(Project.parseId('api'))
  })

  it('rejects a suffix that is not hex', () => {
    assert.isUndefined(Project.parseId('api-notahexnumber'))
  })
})

describe('Project.init and find', () => {
  it.effect('creates the skeleton and finds it from a subdirectory', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmp = yield* fs.makeTempDirectoryScoped()
        const root = path.join(tmp, 'api')

        const created = yield* Project.init(root)
        assert.isTrue(yield* fs.exists(path.join(root, '.igloo/project.json')))
        assert.isTrue(yield* fs.exists(created.homeDir))
        assert.isTrue(yield* fs.exists(created.workspaceDir))
        // `*`, because none of it belongs in the project's history — a keypair, a
        // gc-root, logs, and a home directory an agent writes to continuously.
        assert.strictEqual(
          (yield* fs.readFileString(path.join(created.iglooDir, '.gitignore'))).trim(),
          '*',
        )

        // Discovery works from anywhere inside, the way `git` does.
        const deep = path.join(created.workspaceDir, 'repo/src')
        yield* fs.makeDirectory(deep, { recursive: true })
        const found = yield* Project.find(deep)
        assert.strictEqual(found.root, created.root)
        assert.strictEqual(found.id, created.id)
      }),
    ),
  )

  it.effect('is idempotent and backfills a missing .gitignore', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmp = yield* fs.makeTempDirectoryScoped()
        const root = path.join(tmp, 'api')

        const first = yield* Project.init(root)
        const marker = path.join(root, '.igloo/project.json')
        const original = yield* fs.readFileString(marker)
        yield* fs.remove(path.join(first.iglooDir, '.gitignore'))

        yield* Project.init(root)
        // The marker is not rewritten — its createdAt is a fact about the project.
        assert.strictEqual(yield* fs.readFileString(marker), original)
        assert.isTrue(yield* fs.exists(path.join(first.iglooDir, '.gitignore')))
      }),
    ),
  )

  it.effect('fails with the path it searched when there is no project', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmp = yield* fs.makeTempDirectoryScoped()
        const result = yield* Project.find(tmp).pipe(Effect.result)

        assert.strictEqual(result._tag, 'Failure')
        assert.include(result._tag === 'Failure' ? result.failure.message : '', tmp)
      }),
    ),
  )

  it.effect('rejects a marker that is not valid', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmp = yield* fs.makeTempDirectoryScoped()
        yield* fs.makeDirectory(path.join(tmp, '.igloo'), { recursive: true })
        // Stops at the marker rather than walking past it: a corrupt marker is a
        // project to complain about, not a directory to search above.
        yield* fs.writeFileString(path.join(tmp, '.igloo/project.json'), '{"version":99}')

        const result = yield* Project.find(tmp).pipe(Effect.result)
        assert.strictEqual(result._tag, 'Failure')
        assert.include(
          result._tag === 'Failure' ? result.failure.message : '',
          'not a valid marker',
        )
      }),
    ),
  )

  it.effect('resolves the starting path, so a symlinked route gives one identity', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmp = yield* fs.makeTempDirectoryScoped()
        const root = path.join(tmp, 'api')
        const created = yield* Project.init(root)

        const link = path.join(tmp, 'link-to-api')
        yield* fs.symlink(root, link)
        const viaLink = yield* Project.find(link)

        // The identity is the canonical path: reached the other way, the same
        // project must not get a second CID and a second slice.
        assert.strictEqual(viaLink.root, created.root)
        assert.strictEqual(viaLink.cid, created.cid)
      }),
    ),
  )
})
