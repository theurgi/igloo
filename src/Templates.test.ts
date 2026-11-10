import { BunServices } from '@effect/platform-bun'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Result, Scope } from 'effect'
import * as path from 'node:path'

import * as Templates from './Templates.ts'

const provided = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(BunServices.layer))

const bytes = (text: string) => new TextEncoder().encode(text)
const text = (raw: Uint8Array) => new TextDecoder().decode(raw)

const values = new Map([
  ['at', '@'],
  ['project_name', 'atlas'],
])

/** A scratch directory holding `templates/` with `files` in it, and the root of a project to be. */
const scratch = Effect.fnUntraced(function* (files: Readonly<Record<string, string>>) {
  const fs = yield* FileSystem.FileSystem
  const tmp = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
  const dir = path.join(tmp, 'templates')
  yield* fs.makeDirectory(dir)
  for (const [relative, content] of Object.entries(files)) {
    yield* fs.makeDirectory(path.join(dir, path.dirname(relative)), { recursive: true })
    yield* fs.writeFileString(path.join(dir, relative), content)
  }
  return { dir, root: path.join(tmp, 'atlas'), tmp }
})

const message = <A>(result: Result.Result<A, { readonly message: string }>) =>
  Result.isFailure(result) ? result.failure.message : ''

describe('Templates.parseSet', () => {
  it('reads each name=value, cutting at the first =', () => {
    assert.deepStrictEqual(
      Templates.parseSet(['oxfmt=node_modules/.bin/oxfmt', 'flags=--a=b', 'empty=']),
      Result.succeed({ empty: '', flags: '--a=b', oxfmt: 'node_modules/.bin/oxfmt' }),
    )
  })

  it('refuses an argument with no = and a name no placeholder can spell', () => {
    for (const arg of ['oxfmt', '=value', 'my-key=1', '1st=1']) {
      assert.include(message(Templates.parseSet([arg])), `--set ${arg}: expected name=value`)
    }
  })

  it('refuses a name igloo fills in itself', () => {
    for (const name of ['project_root', 'project_name', 'at']) {
      assert.include(
        message(Templates.parseSet([`${name}=x`])),
        `@${name}@ is a value igloo fills in itself`,
      )
    }
  })
})

describe('Templates.fillIn', () => {
  it('replaces each placeholder with its value', () => {
    const filled = Templates.fillIn(
      bytes('{ "title": "@project_name@", "n": "@project_name@" }'),
      values,
    )
    assert.strictEqual(text(filled.bytes), '{ "title": "atlas", "n": "atlas" }')
    assert.deepStrictEqual(filled.missing, [])
  })

  it('names each placeholder that has no value, once', () => {
    const filled = Templates.fillIn(bytes('@oxfmt@ @project_name@ @owner@ @oxfmt@'), values)
    assert.deepStrictEqual(filled.missing, ['oxfmt', 'owner'])
  })

  it('gives no value to a name every object has', () => {
    assert.deepStrictEqual(Templates.fillIn(bytes('@constructor@'), values).missing, [
      'constructor',
    ])
  })

  it('writes a literal @ from @at@, and does not read the result again', () => {
    const filled = Templates.fillIn(
      bytes('@at@alice@at@example.com and @at@project_name@at@'),
      values,
    )
    assert.strictEqual(text(filled.bytes), '@alice@example.com and @project_name@')
    assert.deepStrictEqual(filled.missing, [])
  })

  it('leaves alone an @ that is not a name between two', () => {
    const raw = bytes('a@b.c, @scope/pkg@1.2.3, args@{ ... }, @media, @@, @ @, @1@')
    const filled = Templates.fillIn(raw, values)
    // The bytes that were read, not an equal copy: nothing was replaced, so
    // nothing was encoded again.
    assert.strictEqual(filled.bytes, raw)
    assert.deepStrictEqual(filled.missing, [])
  })

  it('keeps a byte order mark and whatever is not ASCII', () => {
    const raw = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('naïve — @project_name@\r\n')])
    const filled = Templates.fillIn(raw, values)
    assert.deepStrictEqual([...filled.bytes], [0xef, 0xbb, 0xbf, ...bytes('naïve — atlas\r\n')])
  })

  it('does not read bytes that are not text, whatever they spell', () => {
    const withNul = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, ...bytes('@oxfmt@')])
    const notUtf8 = new Uint8Array([0xff, 0xfe, ...bytes('@oxfmt@ @project_name@')])
    for (const raw of [withNul, notUtf8]) {
      const filled = Templates.fillIn(raw, values)
      assert.strictEqual(filled.bytes, raw)
      assert.deepStrictEqual(filled.missing, [])
    }
  })
})

describe('Templates.plan', () => {
  it.effect('reads every file and link, in the order of their paths, filled in', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { dir, root } = yield* scratch({
          '.vscode/settings.json': '{ "fmt": "@oxfmt@", "title": "@project_name@" }\n',
          'igloo-policy.nix': '{ }\n',
          'workspace/CLAUDE.md': '# @project_name@, at @project_root@\n',
        })
        yield* fs.symlink('CLAUDE.md', path.join(dir, 'workspace/AGENTS.md'))
        yield* fs.makeDirectory(path.join(dir, 'empty'))

        const entries = yield* Templates.plan({ dir, set: { oxfmt: '/bin/oxfmt' } }, root)
        assert.deepStrictEqual(
          entries.map(entry =>
            entry.kind === 'link'
              ? [entry.path, '->', entry.target]
              : [entry.path, text(entry.bytes)],
          ),
          [
            ['.vscode/settings.json', '{ "fmt": "/bin/oxfmt", "title": "atlas" }\n'],
            ['igloo-policy.nix', '{ }\n'],
            ['workspace/AGENTS.md', '->', 'CLAUDE.md'],
            ['workspace/CLAUDE.md', `# atlas, at ${root}\n`],
          ],
        )
        // Planning writes nothing, the project's directory included.
        assert.isFalse(yield* fs.exists(root))
      }),
    ),
  )

  it.effect('follows the link a layer directory holds its templates as, and none below it', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { dir, root, tmp } = yield* scratch({ 'docs/README.md': 'read me\n' })
        const outside = path.join(tmp, 'outside')
        yield* fs.makeDirectory(outside)
        yield* fs.writeFileString(path.join(outside, 'secret'), 'not a template\n')
        yield* fs.symlink(outside, path.join(dir, 'linked'))
        const layer = path.join(tmp, 'layer')
        yield* fs.makeDirectory(layer)
        yield* fs.symlink(dir, Templates.dirIn(layer))

        const entries = yield* Templates.plan({ dir: Templates.dirIn(layer), set: {} }, root)
        assert.deepStrictEqual(
          entries.map(entry => [entry.kind, entry.path]),
          [
            ['file', 'docs/README.md'],
            ['link', 'linked'],
          ],
        )
      }),
    ),
  )

  it.effect('fails on a placeholder with no value, naming every template and placeholder', () =>
    provided(
      Effect.gen(function* () {
        const { dir, root } = yield* scratch({
          '.vscode/settings.json': '{ "fmt": "@oxfmt@" }\n',
          'workspace/CLAUDE.md': '@owner@ and @team@, for @project_name@\n',
        })

        const failed = message(yield* Templates.plan({ dir, set: {} }, root).pipe(Effect.result))
        assert.include(failed, 'nothing was created')
        assert.include(failed, '\n  .vscode/settings.json: @oxfmt@\n')
        assert.include(failed, '\n  workspace/CLAUDE.md: @owner@, @team@\n')
        assert.include(failed, '--set name=value')
      }),
    ),
  )

  it.effect('is no templates for a directory that is not there, or for none', () =>
    provided(
      Effect.gen(function* () {
        const { root, tmp } = yield* scratch({})
        const absent = path.join(tmp, 'layer/templates')

        assert.deepStrictEqual(yield* Templates.plan({ dir: absent, set: {} }, root), [])
        assert.deepStrictEqual(yield* Templates.plan({ dir: undefined, set: {} }, root), [])
        assert.isFalse(yield* Templates.declared({ dir: absent, set: {} }))
        assert.isFalse(yield* Templates.declared({ dir: undefined, set: {} }))
      }),
    ),
  )

  it.effect('refuses --set where there is no template for it to fill in', () =>
    provided(
      Effect.gen(function* () {
        const { root, tmp } = yield* scratch({})
        const absent = path.join(tmp, 'layer/templates')
        const set = { oxfmt: '/bin/oxfmt' }

        assert.include(
          message(yield* Templates.plan({ dir: absent, set }, root).pipe(Effect.result)),
          `there are no templates: ${absent} does not exist`,
        )
        assert.include(
          message(yield* Templates.plan({ dir: undefined, set }, root).pipe(Effect.result)),
          'there are no templates: this igloo has no user layer',
        )
      }),
    ),
  )

  it.effect('refuses a template whose parent in the project is a link, or is no directory', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { dir, root, tmp } = yield* scratch({
          '.vscode/deep/settings.json': '{ }\n',
          'docs/README.md': 'read me\n',
        })
        const elsewhere = path.join(tmp, 'elsewhere')
        yield* fs.makeDirectory(path.join(elsewhere, 'deep'), { recursive: true })
        yield* fs.makeDirectory(root)
        yield* fs.symlink(elsewhere, path.join(root, '.vscode'))

        assert.include(
          message(yield* Templates.plan({ dir, set: {} }, root).pipe(Effect.result)),
          `refusing the template .vscode/deep/settings.json: ${path.join(root, '.vscode')} is a link`,
        )

        yield* fs.remove(path.join(root, '.vscode'))
        yield* fs.writeFileString(path.join(root, 'docs'), 'a file\n')
        assert.include(
          message(yield* Templates.plan({ dir, set: {} }, root).pipe(Effect.result)),
          `cannot write the template docs/README.md: ${path.join(root, 'docs')} is not a directory`,
        )
      }),
    ),
  )
})

describe('Templates.write', () => {
  it.effect('writes each file with mode 0644 and each link with its target', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { dir, root } = yield* scratch({
          '.vscode/settings.json': '{ "title": "@project_name@" }\n',
          'workspace/CLAUDE.md': '# @project_name@\n',
          'workspace/empty': '',
        })
        yield* fs.symlink('CLAUDE.md', path.join(dir, 'workspace/AGENTS.md'))
        // As a template is in the store: read-only, and here executable too.
        yield* fs.chmod(path.join(dir, '.vscode/settings.json'), 0o555)
        yield* fs.makeDirectory(root)

        const outcomes = yield* Templates.write(root, yield* Templates.plan({ dir, set: {} }, root))
        assert.deepStrictEqual(outcomes, [
          { kind: 'wrote', path: '.vscode/settings.json' },
          { kind: 'linked', path: 'workspace/AGENTS.md', target: 'CLAUDE.md' },
          { kind: 'wrote', path: 'workspace/CLAUDE.md' },
          { kind: 'wrote', path: 'workspace/empty' },
        ])
        assert.strictEqual(
          yield* fs.readFileString(path.join(root, '.vscode/settings.json')),
          '{ "title": "atlas" }\n',
        )
        assert.strictEqual(yield* fs.readLink(path.join(root, 'workspace/AGENTS.md')), 'CLAUDE.md')
        assert.strictEqual(
          yield* fs.readFileString(path.join(root, 'workspace/AGENTS.md')),
          '# atlas\n',
        )
        assert.strictEqual(yield* fs.readFileString(path.join(root, 'workspace/empty')), '')
        for (const file of ['.vscode/settings.json', 'workspace/CLAUDE.md']) {
          assert.strictEqual(
            (yield* fs.stat(path.join(root, file))).mode & 0o777,
            0o644 & ~process.umask(),
          )
        }
      }),
    ),
  )

  it.effect('copies bytes that are not text as they are', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { dir, root } = yield* scratch({})
        const image = new Uint8Array([
          0x89,
          0x50,
          0x4e,
          0x47,
          0x00,
          0xff,
          ...bytes('@oxfmt@'),
          0xfe,
        ])
        yield* fs.writeFile(path.join(dir, 'logo.png'), image)
        yield* fs.makeDirectory(root)

        yield* Templates.write(root, yield* Templates.plan({ dir, set: {} }, root))
        assert.deepStrictEqual(yield* fs.readFile(path.join(root, 'logo.png')), image)
      }),
    ),
  )

  it.effect('leaves what exists alone, a link that leads nowhere included', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { dir, root } = yield* scratch({
          '.vscode/cspell.json': 'from the template\n',
          '.vscode/settings.json': 'from the template\n',
          'notes/today.md': 'from the template\n',
          'README.md': 'from the template\n',
        })
        yield* fs.symlink('settings.json', path.join(dir, '.vscode/linked.json'))
        yield* fs.makeDirectory(path.join(root, '.vscode'), { recursive: true })
        yield* fs.writeFileString(path.join(root, '.vscode/settings.json'), 'mine\n')
        yield* fs.writeFileString(path.join(root, '.vscode/linked.json'), 'mine\n')
        yield* fs.symlink('nowhere', path.join(root, 'README.md'))
        yield* fs.makeDirectory(path.join(root, 'notes/today.md'), { recursive: true })

        const outcomes = yield* Templates.write(root, yield* Templates.plan({ dir, set: {} }, root))
        assert.deepStrictEqual(outcomes, [
          { kind: 'wrote', path: '.vscode/cspell.json' },
          { kind: 'skipped', path: '.vscode/linked.json' },
          { kind: 'skipped', path: '.vscode/settings.json' },
          { kind: 'skipped', path: 'README.md' },
          { kind: 'skipped', path: 'notes/today.md' },
        ])
        assert.strictEqual(
          yield* fs.readFileString(path.join(root, '.vscode/settings.json')),
          'mine\n',
        )
        assert.strictEqual(
          yield* fs.readFileString(path.join(root, '.vscode/linked.json')),
          'mine\n',
        )
        assert.strictEqual(yield* fs.readLink(path.join(root, 'README.md')), 'nowhere')
        assert.isFalse(yield* fs.exists(path.join(root, 'nowhere')))
      }),
    ),
  )

  it.effect('writes nothing through a link that appeared among the parents after the plan', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { dir, root, tmp } = yield* scratch({ '.vscode/deep/settings.json': '{ }\n' })
        const elsewhere = path.join(tmp, 'elsewhere')
        yield* fs.makeDirectory(elsewhere)
        yield* fs.makeDirectory(root)
        const planned = yield* Templates.plan({ dir, set: {} }, root)
        yield* fs.symlink(elsewhere, path.join(root, '.vscode'))

        assert.include(
          message(yield* Templates.write(root, planned).pipe(Effect.result)),
          'refusing the template .vscode/deep/settings.json',
        )
        assert.deepStrictEqual(yield* fs.readDirectory(elsewhere), [])
      }),
    ),
  )
})

describe('Templates.report', () => {
  it('is a line for each template under a heading, and nothing for none', () => {
    assert.strictEqual(
      Templates.report([
        { kind: 'wrote', path: '.vscode/settings.json' },
        { kind: 'linked', path: 'workspace/AGENTS.md', target: 'CLAUDE.md' },
        { kind: 'skipped', path: 'workspace/CLAUDE.md' },
      ]),
      'templates\n' +
        '  wrote    .vscode/settings.json\n' +
        '  linked   workspace/AGENTS.md -> CLAUDE.md\n' +
        '  skipped  workspace/CLAUDE.md (exists)\n',
    )
    assert.strictEqual(Templates.report([]), '')
  })
})
