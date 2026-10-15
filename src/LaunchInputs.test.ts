import { BunServices } from '@effect/platform-bun'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem } from 'effect'
import { readdirSync } from 'node:fs'
import * as path from 'node:path'

import * as LaunchInputs from './LaunchInputs.ts'

describe('LaunchInputs.ofFiles', () => {
  it.effect('hashes each file under its own path', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${dir}/a.nix`, 'one')
      yield* fs.writeFileString(`${dir}/b.nix`, 'two')

      const inputs = yield* LaunchInputs.ofFiles([`${dir}/a.nix`, `${dir}/b.nix`])

      assert.deepStrictEqual(Object.keys(inputs).toSorted(), [`${dir}/a.nix`, `${dir}/b.nix`])
      assert.strictEqual(inputs[`${dir}/a.nix`], LaunchInputs.digest('one'))
      assert.notStrictEqual(inputs[`${dir}/a.nix`], inputs[`${dir}/b.nix`])
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect('records a missing file as something other than an empty one', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${dir}/empty.nix`, '')

      const inputs = yield* LaunchInputs.ofFiles([`${dir}/empty.nix`, `${dir}/gone.nix`])

      // A layer that was deleted and a layer that was emptied are different
      // events. Hashing both as '' would make the deletion invisible, which is
      // the half that changes what reaches the guest.
      assert.notStrictEqual(inputs[`${dir}/gone.nix`], inputs[`${dir}/empty.nix`])
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect('never fails on a file it cannot read', () =>
    Effect.gen(function* () {
      const inputs = yield* LaunchInputs.ofFiles(['/nonexistent/igloo.nix'])

      assert.strictEqual(Object.keys(inputs).length, 1)
    }).pipe(Effect.provide(BunServices.layer)),
  )
})

describe('LaunchInputs.ofNamedFiles', () => {
  it.effect('reads an unchanged file at a new path as unchanged', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      // An igloo upgrade: the tree moves to a new store path, and the lock in it
      // may be byte-for-byte what it was.
      for (const tree of ['old-source', 'new-source']) {
        yield* fs.makeDirectory(`${dir}/${tree}`)
        yield* fs.writeFileString(`${dir}/${tree}/flake.lock`, 'same lock')
      }
      yield* fs.writeFileString(`${dir}/old-source/flake.nix`, 'old')
      yield* fs.writeFileString(`${dir}/new-source/flake.nix`, 'new')

      const of = (tree: string) =>
        LaunchInputs.ofNamedFiles({
          "igloo's flake.lock": `${dir}/${tree}/flake.lock`,
          "igloo's flake.nix": `${dir}/${tree}/flake.nix`,
        })

      assert.deepStrictEqual(
        LaunchInputs.changed(yield* of('old-source'), yield* of('new-source')),
        ["igloo's flake.nix"],
      )
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )
})

describe('LaunchInputs.ofIgloo', () => {
  it.effect('covers every file under nix/, at any depth, by its path in the tree', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(`${dir}/nix/sub`, { recursive: true })
      for (const file of ['flake.lock', 'flake.nix', 'nix/runner.nix', 'nix/sub/guest.nix']) {
        yield* fs.writeFileString(`${dir}/${file}`, file)
      }

      const inputs = yield* LaunchInputs.ofIgloo(dir)

      // `nix/sub` itself is not an input: a directory has no content to hash,
      // and recording it as unreadable would be a lie about it.
      assert.deepStrictEqual(Object.keys(inputs).toSorted(), [
        "igloo's flake.lock",
        "igloo's flake.nix",
        "igloo's nix/runner.nix",
        "igloo's nix/sub/guest.nix",
      ])
      assert.strictEqual(
        inputs["igloo's nix/sub/guest.nix"],
        LaunchInputs.digest('nix/sub/guest.nix'),
      )
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect('reads an edit under nix/ as that file changed, wherever the tree is', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      // An upgrade that changed only the runner: `flake.nix` is as it was, so
      // hashing it alone would report nothing.
      for (const tree of ['old-source', 'new-source']) {
        yield* fs.makeDirectory(`${dir}/${tree}/nix`, { recursive: true })
        yield* fs.writeFileString(`${dir}/${tree}/flake.lock`, 'same lock')
        yield* fs.writeFileString(`${dir}/${tree}/flake.nix`, 'same flake')
        yield* fs.writeFileString(`${dir}/${tree}/nix/guest.nix`, 'same guest')
      }
      yield* fs.writeFileString(`${dir}/old-source/nix/runner.nix`, 'old')
      yield* fs.writeFileString(`${dir}/new-source/nix/runner.nix`, 'new')

      assert.deepStrictEqual(
        LaunchInputs.changed(
          yield* LaunchInputs.ofIgloo(`${dir}/old-source`),
          yield* LaunchInputs.ofIgloo(`${dir}/new-source`),
        ),
        ["igloo's nix/runner.nix"],
      )
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect("covers every Nix file in igloo's own tree", () =>
    Effect.gen(function* () {
      const root = path.resolve(new URL('..', import.meta.url).pathname)
      // Everything a runner can reach of igloo is in its tree, so a Nix file
      // anywhere in it that the record leaves out is one whose edit goes
      // unreported. `node_modules` is not igloo's, and a symlink such as
      // `result` points out of the tree.
      const nixFiles = (dir: string): Array<string> =>
        readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
          const relative = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            return entry.name === 'node_modules' || entry.name.startsWith('.')
              ? []
              : nixFiles(relative)
          }
          return entry.isFile() && entry.name.endsWith('.nix') ? [relative] : []
        })
      const found = nixFiles('')

      const inputs = yield* LaunchInputs.ofIgloo(root)

      assert.include(found, 'flake.nix')
      assert.isTrue(found.some(file => file.startsWith('nix/')))
      assert.deepStrictEqual(
        found.filter(file => !(`igloo's ${file}` in inputs)),
        [],
        'a Nix file outside nix/ is not in the launch record; move it under nix/',
      )
    }).pipe(Effect.provide(BunServices.layer)),
  )
})

describe('LaunchInputs.changed', () => {
  it('reports an edit, an addition and a removal alike, sorted', () => {
    const before = { '/b.nix': 'x', '/c.nix': 'x', '/z.nix': 'x' }
    const after = { '/a.nix': 'x', '/b.nix': 'edited', '/c.nix': 'x' }

    // `/z.nix` is gone and `/a.nix` is new: a content layer added or removed is
    // a different VM, so both count the same way an edit does.
    assert.deepStrictEqual(LaunchInputs.changed(before, after), ['/a.nix', '/b.nix', '/z.nix'])
  })

  it('reports nothing for identical records', () => {
    const record = { '/a.nix': 'x', 'the broker grants': 'y' }

    assert.deepStrictEqual(LaunchInputs.changed(record, { ...record }), [])
  })
})

describe('LaunchInputs.read', () => {
  it.effect('round-trips what was written', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const record = { '/a.nix': 'x', 'the broker grants': 'y' }

      yield* LaunchInputs.write(`${dir}/launched-from.json`, record)

      assert.deepStrictEqual(yield* LaunchInputs.read(`${dir}/launched-from.json`), record)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect('answers undefined for a record that is absent or unreadable', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${dir}/garbage.json`, 'not json')

      // Not an empty record: absent and unchanged are different answers, and a
      // caller that confused them would report drift on every launch of a
      // project whose last one predates this file.
      assert.strictEqual(yield* LaunchInputs.read(`${dir}/missing.json`), undefined)
      assert.strictEqual(yield* LaunchInputs.read(`${dir}/garbage.json`), undefined)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )
})
