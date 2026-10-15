import { BunServices } from '@effect/platform-bun'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, FileSystem, Result, Schema } from 'effect'

import * as BootLog from './BootLog.ts'

/** The boot directories under a log root, newest last. */
const bootDirs = Effect.fnUntraced(function* (logsRoot: string) {
  const fs = yield* FileSystem.FileSystem
  const entries = yield* fs.readDirectory(logsRoot)
  return entries.filter(entry => /^\d{4}-/.test(entry)).toSorted()
})

/** A boot's `boot.json`, read back through the schema it was written with. */
const readSummary = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* Schema.decodeEffect(BootLog.SummaryJson)(yield* fs.readFileString(file))
})

describe('BootLog.open', () => {
  it.effect('creates a boot directory and points latest at it', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const logsRoot = yield* fs.makeTempDirectoryScoped()

      const boot = yield* BootLog.open(logsRoot)

      assert.deepStrictEqual(yield* bootDirs(logsRoot), [boot.id])
      // Through the link rather than the id, which is the path an error
      // message can name and a person can type.
      const latest = `${logsRoot}/${BootLog.LATEST}`
      assert.strictEqual(yield* fs.realPath(latest), yield* fs.realPath(boot.dir))
      // Relative, so the link survives the project directory being moved.
      assert.strictEqual(yield* fs.readLink(latest), boot.id)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect('gives two boots of the same project separate directories', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const logsRoot = yield* fs.makeTempDirectoryScoped()

      const first = yield* BootLog.open(logsRoot)
      const second = yield* BootLog.open(logsRoot)

      assert.notStrictEqual(first.id, second.id)
      assert.lengthOf(yield* bootDirs(logsRoot), 2)
      // The newest, not merely the most recently opened by this process: the
      // link is what a reader follows after a bad boot.
      assert.strictEqual(yield* fs.readLink(`${logsRoot}/${BootLog.LATEST}`), second.id)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  // it.live: the id carries the wall-clock time and the prune orders by it, so
  // TestClock's epoch would make every boot here older than the fixtures.
  it.live('keeps the log directory bounded, oldest first', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const logsRoot = yield* fs.makeTempDirectoryScoped()
      // Older than anything this test opens, and named the way a boot id is —
      // the prune has nothing else to go on.
      const ancient = Array.from(
        { length: 25 },
        (_, index) => `2020-01-01T00-00-${index.toString().padStart(2, '0')}-000Z-aaaa`,
      )
      for (const name of ancient) yield* fs.makeDirectory(`${logsRoot}/${name}`)
      // Not a boot directory, and must survive: the prune identifies boots by
      // the shape of their name rather than by excluding known exceptions.
      yield* fs.writeFileString(`${logsRoot}/notes.txt`, 'keep me')

      const boot = yield* BootLog.open(logsRoot)

      const remaining = yield* bootDirs(logsRoot)
      assert.lengthOf(remaining, 20)
      assert.strictEqual(remaining.at(-1), boot.id)
      // The oldest went and the newest of the old stayed, which is what makes
      // this a prune by age rather than by whatever the directory listed first.
      assert.notInclude(remaining, ancient[0])
      assert.include(remaining, ancient.at(-1))
      assert.isTrue(yield* fs.exists(`${logsRoot}/notes.txt`))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )
})

describe('BootLog discard', () => {
  it.effect('removes the record and points latest back at the boot before it', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const logsRoot = yield* fs.makeTempDirectoryScoped()
      const booted = yield* BootLog.open(logsRoot)
      const attached = yield* BootLog.open(logsRoot)

      yield* attached.finish(Exit.succeed(undefined))
      yield* attached.discard

      assert.deepStrictEqual(yield* bootDirs(logsRoot), [booted.id])
      // Back at the boot a reader following `latest` after a bad launch wants,
      // rather than dangling at the directory that was removed.
      assert.strictEqual(yield* fs.readLink(`${logsRoot}/${BootLog.LATEST}`), booted.id)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect('leaves latest to a launch that opened after it', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const logsRoot = yield* fs.makeTempDirectoryScoped()
      const first = yield* BootLog.open(logsRoot)
      const second = yield* BootLog.open(logsRoot)

      // Two launches of one project at once: the earlier one concluding must
      // not take the link from the one still writing.
      yield* first.discard

      assert.deepStrictEqual(yield* bootDirs(logsRoot), [second.id])
      assert.strictEqual(yield* fs.readLink(`${logsRoot}/${BootLog.LATEST}`), second.id)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect('removes latest when no boot is left for it to name', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const logsRoot = yield* fs.makeTempDirectoryScoped()
      const only = yield* BootLog.open(logsRoot)

      yield* only.discard

      assert.deepStrictEqual(yield* bootDirs(logsRoot), [])
      assert.isFalse(yield* fs.exists(`${logsRoot}/${BootLog.LATEST}`))
      // `exists` follows the link, so a dangling one reads as absent too.
      const link = yield* fs.readLink(`${logsRoot}/${BootLog.LATEST}`).pipe(Effect.result)
      assert.isTrue(Result.isFailure(link))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )
})

describe('BootLog phases and the summary', () => {
  it.effect('times each step and reports the launch as a success', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const logsRoot = yield* fs.makeTempDirectoryScoped()
      const boot = yield* BootLog.open(logsRoot)

      const built = yield* boot.phase('build', Effect.succeed('/nix/store/runner'))
      yield* boot.phase('guest', Effect.void)
      yield* boot.finish(Exit.succeed(undefined))

      assert.strictEqual(built, '/nix/store/runner', 'a phase altered what it wrapped')
      const summary = yield* readSummary(boot.file('boot.json'))
      assert.strictEqual(summary.outcome, 'success')
      assert.strictEqual(summary.bootId, boot.id)
      assert.deepStrictEqual(
        summary.phases.map(phase => phase.name),
        ['build', 'guest'],
      )
      assert.isTrue(summary.phases.every(phase => phase.ok))
      assert.isUndefined(summary.failure)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect('records a failed step, and re-raises it unchanged', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const logsRoot = yield* fs.makeTempDirectoryScoped()
      const boot = yield* BootLog.open(logsRoot)

      const refused = new BootLog.BootLogError({ message: 'nix build refused' })
      const result = yield* boot.phase('build', Effect.fail(refused)).pipe(Effect.result)
      yield* boot.finish(Exit.fail(refused))

      assert.isTrue(result._tag === 'Failure')
      const summary = yield* readSummary(boot.file('boot.json'))
      assert.strictEqual(summary.outcome, 'failure')
      assert.deepStrictEqual(summary.phases[0]?.name, 'build')
      assert.isFalse(summary.phases[0]?.ok)
      // The failure is named in the summary, so the record says what went
      // wrong without a reader having to open the unit logs first.
      assert.include(summary.failure ?? '', 'nix build refused')
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect('tells an interrupted launch from a failed one', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const logsRoot = yield* fs.makeTempDirectoryScoped()
      const boot = yield* BootLog.open(logsRoot)

      yield* boot.finish(Exit.interrupt())

      const summary = yield* readSummary(boot.file('boot.json'))
      // A launch someone gave up on is not a launch that failed, and the
      // difference is the whole question when a boot is slow rather than broken.
      assert.strictEqual(summary.outcome, 'interrupted')
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect('keeps the first account of how a launch ended', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const logsRoot = yield* fs.makeTempDirectoryScoped()
      const boot = yield* BootLog.open(logsRoot)

      yield* boot.finish(Exit.fail(new BootLog.BootLogError({ message: 'no answer on vsock' })))
      yield* boot.finish(Exit.succeed(undefined))

      const summary = yield* readSummary(boot.file('boot.json'))
      assert.strictEqual(summary.outcome, 'failure')
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect('leaves a trail of what happened, as it happened', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const logsRoot = yield* fs.makeTempDirectoryScoped()
      const boot = yield* BootLog.open(logsRoot)

      yield* boot.record({ event: 'note', message: 'building .#testVm' })
      yield* boot.phase('build', Effect.void)
      yield* boot.record({ event: 'runner', path: '/nix/store/runner' })

      // Read before the launch concludes, which is the case the trail exists
      // for: a boot that hangs has no summary and this is all there is.
      const lines = (yield* fs.readFileString(boot.file('boot.jsonl')))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
      assert.deepStrictEqual(
        lines.map((line: { event: string }) => line.event),
        ['note', 'phase', 'runner'],
      )
      assert.strictEqual(lines[0].message, 'building .#testVm')
      assert.strictEqual(lines[2].path, '/nix/store/runner')
      // Timestamped, so the gap between two lines is readable even when the
      // phase that spans them never returned.
      assert.match(lines[0].t, /^\d{4}-\d{2}-\d{2}T/)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )
})
