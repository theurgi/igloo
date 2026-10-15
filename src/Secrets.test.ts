import { BunServices } from '@effect/platform-bun'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Scope } from 'effect'
import { ChildProcessSpawner } from 'effect/unstable/process'

import * as Secrets from './Secrets.ts'

const provided = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Scope.Scope
  >,
) => effect.pipe(Effect.scoped, Effect.provide(BunServices.layer))

/** A scratch directory, a place to deliver into, and a way to write fake sources. */
const workspace = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* fs.makeTempDirectoryScoped()
  const out = `${dir}/run`
  yield* fs.makeDirectory(out, { recursive: true })

  const script = Effect.fnUntraced(function* (name: string, body: string) {
    const file = `${dir}/${name}`
    yield* fs.writeFileString(file, `#!/usr/bin/env bash\n${body}\n`)
    yield* fs.chmod(file, 0o755)
    return file
  })

  return { dir, out, script }
})

const failureOf = <A, E extends { readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<string, never, R> =>
  effect.pipe(
    Effect.as(''),
    Effect.catch((error: E) => Effect.succeed(error.message)),
  )

describe('Secrets.write', () => {
  it.effect('writes a file source through, readable only by its owner', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { dir, out } = yield* workspace()
        yield* fs.writeFileString(`${dir}/token`, 'hunter2\n')

        yield* Secrets.write(
          [
            {
              cwd: dir,
              hostPath: `${out}/TOKEN`,
              name: 'TOKEN',
              source: { _tag: 'File', path: `${dir}/token` },
            },
          ],
          [],
        )

        assert.strictEqual(yield* fs.readFileString(`${out}/TOKEN`), 'hunter2')
        const info = yield* fs.stat(`${out}/TOKEN`)
        assert.strictEqual((info.mode ?? 0) & 0o777, 0o600)
      }),
    ),
  )

  it.effect('runs a command source as an argument vector, not through a shell', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { dir, out, script } = yield* workspace()
        // A shell would split this into two arguments; an argument vector keeps
        // it one, which is the whole reason the source is a list.
        const echo = yield* script('echo-arg', 'printf "%s" "$1"')

        yield* Secrets.write(
          [
            {
              cwd: dir,
              hostPath: `${out}/S`,
              name: 'S',
              source: { _tag: 'Command', argv: [echo, 'one two'] },
            },
          ],
          [],
        )

        assert.strictEqual(yield* fs.readFileString(`${out}/S`), 'one two')
      }),
    ),
  )

  it.effect('drops exactly one trailing newline', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { dir, out, script } = yield* workspace()
        // `pass` and friends terminate the secret with a newline that is not
        // part of it; a PEM key ends with one that is. Dropping all trailing
        // whitespace would corrupt the second kind.
        const pem = yield* script('pem', 'printf "line1\\nline2\\n\\n"')

        yield* Secrets.write(
          [{ cwd: dir, hostPath: `${out}/K`, name: 'K', source: { _tag: 'Command', argv: [pem] } }],
          [],
        )

        assert.strictEqual(yield* fs.readFileString(`${out}/K`), 'line1\nline2\n')
      }),
    ),
  )

  it.effect('runs a command in the directory of the layer that declared it', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { dir, out, script } = yield* workspace()
        // The caller's directory can be inside the workspace, which the guest
        // writes, so a relative command there would be the guest's choice.
        const pwd = yield* script('pwd', 'pwd')
        const layer = `${dir}/layer`
        yield* fs.makeDirectory(layer)

        yield* Secrets.write(
          [
            {
              cwd: layer,
              hostPath: `${out}/W`,
              name: 'W',
              source: { _tag: 'Command', argv: [pwd] },
            },
          ],
          [],
        )

        assert.strictEqual(yield* fs.readFileString(`${out}/W`), yield* fs.realPath(layer))
      }),
    ),
  )

  it.effect('refuses a source that produced nothing rather than delivering it', () =>
    provided(
      Effect.gen(function* () {
        const { dir, out, script } = yield* workspace()
        const silent = yield* script('silent', 'true')

        const message = yield* failureOf(
          Secrets.write(
            [
              {
                cwd: dir,
                hostPath: `${out}/E`,
                name: 'E',
                source: { _tag: 'Command', argv: [silent] },
              },
            ],
            [],
          ),
        )
        assert.include(message, 'E:')
        assert.include(message, 'produced nothing')
      }),
    ),
  )

  it.effect('says which credential failed without quoting what the source printed', () =>
    provided(
      Effect.gen(function* () {
        const { dir, out, script } = yield* workspace()
        // A source that fails *after* printing something secret-shaped is the
        // case that matters: the message must name the command and stop there.
        const leaky = yield* script('leaky', 'printf "s3cret"; exit 3')

        const message = yield* failureOf(
          Secrets.write(
            [
              {
                cwd: dir,
                hostPath: `${out}/L`,
                name: 'L',
                source: { _tag: 'Command', argv: [leaky] },
              },
            ],
            [],
          ),
        )
        assert.include(message, 'L:')
        assert.notInclude(message, 's3cret')
      }),
    ),
  )

  it.effect('writes nothing at all when one of several sources fails', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { dir, out, script } = yield* workspace()
        yield* fs.writeFileString(`${dir}/good`, 'fine')
        const broken = yield* script('broken', 'exit 1')

        yield* failureOf(
          Secrets.write(
            [
              {
                cwd: dir,
                hostPath: `${out}/A`,
                name: 'A',
                source: { _tag: 'File', path: `${dir}/good` },
              },
              {
                cwd: dir,
                hostPath: `${out}/B`,
                name: 'B',
                source: { _tag: 'Command', argv: [broken] },
              },
            ],
            [],
          ),
        )

        // A VM given half its credentials fails later, somewhere else, as an
        // authentication error against whichever upstream is tried first. The
        // launch is what has to fail, so `up` never reaches the build.
        assert.isFalse(yield* fs.exists(`${out}/B`))
      }),
    ),
  )
})

/**
 * The guest writes its workspace and its home, so a source inside either is the
 * guest's to choose: a command there is its code run on the host, and a file
 * there can be a link to anything the developer can read.
 */
describe('Secrets.write: sources the guest can write', () => {
  const guestDirs = Effect.fnUntraced(function* () {
    const fs = yield* FileSystem.FileSystem
    const { dir, out, script } = yield* workspace()
    const guest = `${dir}/project/workspace`
    yield* fs.makeDirectory(guest, { recursive: true })
    return { dir, fs, guest, out, script }
  })

  it.effect('refuses a command inside one, and never runs it', () =>
    provided(
      Effect.gen(function* () {
        const { dir, fs, guest, out } = yield* guestDirs()
        const ran = `${dir}/ran`
        yield* fs.writeFileString(`${guest}/get`, `#!/usr/bin/env bash\ntouch ${ran}\necho x\n`)
        yield* fs.chmod(`${guest}/get`, 0o755)

        // Relative, resolved against the declaring layer's directory — the
        // project root, beside the workspace.
        const message = yield* failureOf(
          Secrets.write(
            [
              {
                cwd: `${dir}/project`,
                hostPath: `${out}/C`,
                name: 'C',
                source: { _tag: 'Command', argv: ['workspace/get'] },
              },
            ],
            [guest],
          ),
        )
        assert.include(message, 'C:')
        assert.include(message, 'the guest can write')
        assert.isFalse(yield* fs.exists(ran))
      }),
    ),
  )

  it.effect('refuses a file reached through a link the guest placed', () =>
    provided(
      Effect.gen(function* () {
        const { dir, fs, guest, out } = yield* guestDirs()
        yield* fs.writeFileString(`${dir}/id_ed25519`, 'private')
        yield* fs.symlink(`${dir}/id_ed25519`, `${guest}/token`)

        const message = yield* failureOf(
          Secrets.write(
            [
              {
                cwd: dir,
                hostPath: `${out}/F`,
                name: 'F',
                source: { _tag: 'File', path: `${guest}/token` },
              },
            ],
            [guest],
          ),
        )
        assert.include(message, 'the guest can write')
        assert.isFalse(yield* fs.exists(`${out}/F`))
      }),
    ),
  )

  it.effect('refuses a file whose link leads into one', () =>
    provided(
      Effect.gen(function* () {
        const { dir, fs, guest, out } = yield* guestDirs()
        yield* fs.writeFileString(`${guest}/token`, 'chosen by the guest')
        yield* fs.symlink(`${guest}/token`, `${dir}/token`)

        const message = yield* failureOf(
          Secrets.write(
            [
              {
                cwd: dir,
                hostPath: `${out}/L`,
                name: 'L',
                source: { _tag: 'File', path: `${dir}/token` },
              },
            ],
            [guest],
          ),
        )
        assert.include(message, 'the guest can write')
      }),
    ),
  )

  it.effect('reads a source beside the guest directories, outside them', () =>
    provided(
      Effect.gen(function* () {
        const { dir, fs, guest, out } = yield* guestDirs()
        // A prefix of the share's name is not inside it.
        yield* fs.writeFileString(`${guest}-keys`, 'fine')

        yield* Secrets.write(
          [
            {
              cwd: dir,
              hostPath: `${out}/O`,
              name: 'O',
              source: { _tag: 'File', path: `${guest}-keys` },
            },
          ],
          [guest],
        )
        assert.strictEqual(yield* fs.readFileString(`${out}/O`), 'fine')
      }),
    ),
  )
})
