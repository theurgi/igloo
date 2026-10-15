import { BunServices } from '@effect/platform-bun'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, FileSystem } from 'effect'
import * as path from 'node:path'

import * as NixLog from './NixLog.ts'

const json = (value: Record<string, unknown>): string => JSON.stringify(value)

/** What a failed evaluation sends, as nix writes its copy of the log. */
const copy = [
  json({ action: 'start', id: 1, level: 3, text: "building '/nix/store/0abc-runner.drv'" }),
  json({ action: 'result', fields: ['a builder printed this'], id: 1, type: 101 }),
  json({ action: 'msg', level: 3, msg: 'copying 1 path' }),
  json({ action: 'msg', level: 1, msg: '\u001b[35;1mwarning:\u001b[0m Git tree is dirty' }),
  json({
    action: 'msg',
    column: 7,
    file: '/p/igloo.nix:2:7',
    level: 0,
    line: 2,
    msg: "\u001b[31;1merror:\u001b[0m syntax error, unexpected ';'\n       \u001b[34;1mat \u001b[35;1m/p/igloo.nix:2:7\u001b[0m:",
    raw_msg: "syntax error, unexpected ';'",
  }),
  'not a line nix writes',
  json({ action: 'stop', id: 1 }),
].join('\n')

const expected =
  "warning: Git tree is dirty\nerror: syntax error, unexpected ';'\n       at /p/igloo.nix:2:7:\n"

describe('NixLog.kept', () => {
  it('keeps errors and warnings, as a terminal would show them, and nothing else', () => {
    assert.deepStrictEqual(copy.split('\n').map(NixLog.kept), [
      undefined,
      undefined,
      undefined,
      'warning: Git tree is dirty',
      "error: syntax error, unexpected ';'\n       at /p/igloo.nix:2:7:",
      undefined,
      undefined,
    ])
  })
})

/** A `nix` that has `json-log-path`, or one too old to. */
const fakeNix = Effect.fnUntraced(function* (dir: string, supported: boolean) {
  const fs = yield* FileSystem.FileSystem
  const file = path.join(dir, 'nix')
  yield* fs.writeFileString(
    file,
    `#!/usr/bin/env bash\n[ "$*" = "config show json-log-path" ] && exit ${supported ? 0 : 1}\nexit 2\n`,
  )
  yield* fs.chmod(file, 0o755)
  return file
})

/** Send `text` down the socket `args` names, as nix would, in two pieces that split a line. */
const send = Effect.fnUntraced(function* (args: readonly string[], text: string) {
  const socketPath = args[args.indexOf('json-log-path') + 1] ?? ''
  const socket = yield* Effect.promise(() =>
    Bun.connect({ socket: { data: () => {} }, unix: socketPath }),
  )
  const middle = Math.floor(text.length / 2)
  socket.write(text.slice(0, middle))
  yield* Effect.sleep('10 millis')
  socket.write(text.slice(middle))
  socket.end()
})

describe('NixLog.make', () => {
  // it.live: the copy arrives over a real socket, and is waited for in real time.
  it.live('appends what nix logged as an error or a warning once the command is done', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const file = path.join(dir, 'nix.log')
      const keep = yield* NixLog.make(yield* fakeNix(dir, true), file)

      let given: readonly string[] = []
      yield* keep(args => {
        given = args
        return send(args, copy)
      })
      assert.deepStrictEqual(given.slice(0, 2), ['--option', 'json-log-path'])
      assert.strictEqual(yield* fs.readFileString(file), expected)
      // The socket's directory goes with the command.
      assert.isFalse(yield* fs.exists(path.dirname(given[2] ?? '')))

      // A second command's are appended after the first's.
      yield* keep(args => send(args, copy))
      assert.strictEqual(yield* fs.readFileString(file), `${expected}${expected}`)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.live('keeps them from a command that failed, and fails as the command did', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const file = path.join(dir, 'nix.log')
      const keep = yield* NixLog.make(yield* fakeNix(dir, true), file)

      const exit = yield* Effect.exit(
        keep(args => send(args, copy).pipe(Effect.andThen(Effect.fail('nix exited 1')))),
      )
      assert.deepStrictEqual(exit, Exit.fail('nix exited 1'))
      assert.strictEqual(yield* fs.readFileString(file), expected)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.live('writes no file when nix logged nothing worth keeping', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const file = path.join(dir, 'nix.log')
      const keep = yield* NixLog.make(yield* fakeNix(dir, true), file)

      yield* keep(args => send(args, json({ action: 'msg', level: 3, msg: 'copying 1 path' })))
      assert.isFalse(yield* fs.exists(file))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.live('passes a nix without json-log-path nothing, and keeps nothing', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const file = path.join(dir, 'nix.log')
      const keep = yield* NixLog.make(yield* fakeNix(dir, false), file)

      const given = yield* keep(args => Effect.succeed(args))
      assert.deepStrictEqual(given, [])
      assert.isFalse(yield* fs.exists(file))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )
})
