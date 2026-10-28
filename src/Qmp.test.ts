import { BunServices } from '@effect/platform-bun'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Result } from 'effect'
import { closeSync, constants, openSync } from 'node:fs'

import * as Qmp from './Qmp.ts'

/**
 * A QMP server as QEMU is one: a greeting on connecting, then a reply per
 * command, and an event before the reply to `system_powerdown`. Every byte it
 * is sent is kept, so a test can tell whether anything reached it at all.
 */
const serve = (path: string, reply: (command: string) => string = () => '{"return": {}}') =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const commands: string[] = []
      let bytes = 0
      const server = Bun.listen({
        socket: {
          data: (socket, data) => {
            bytes += data.length
            for (const line of data.toString().split('\n')) {
              if (line.trim() === '') continue
              const command = String(JSON.parse(line).execute)
              commands.push(command)
              const event =
                command === 'system_powerdown'
                  ? '{"event": "POWERDOWN", "data": {}, "timestamp": {"seconds": 0, "microseconds": 0}}\r\n'
                  : ''
              socket.write(`${event}${reply(command)}\r\n`)
            }
          },
          open: socket => {
            socket.write('{"QMP": {"version": {}, "capabilities": ["oob"]}}\r\n')
          },
        },
        unix: path,
      })
      return { bytes: () => bytes, commands, server }
    }),
    ({ server }) => Effect.sync(() => server.stop(true)),
  )

describe('Qmp.powerdown', () => {
  it.live('asks the expected process to power the guest off, after negotiating', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const qemu = yield* serve(`${dir}/control.socket`)

      yield* Qmp.powerdown({ dir, name: 'control.socket', pid: process.pid })

      assert.deepStrictEqual(qemu.commands, ['qmp_capabilities', 'system_powerdown'])
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.live('sends nothing through a control socket that is a symlink to another listener', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      // Another VM's QMP socket, which a QEMU that can write its own runtime
      // directory can point this one's name at.
      yield* fs.makeDirectory(`${dir}/other`)
      const other = yield* serve(`${dir}/other/control.socket`)
      yield* fs.makeDirectory(`${dir}/this`)
      yield* fs.symlink(`${dir}/other/control.socket`, `${dir}/this/control.socket`)

      // The listener is this process, so any other pid stands for this VM's
      // QEMU.
      const result = yield* Effect.result(
        Qmp.powerdown({ dir: `${dir}/this`, name: 'control.socket', pid: process.ppid }),
      )

      assert.isTrue(Result.isFailure(result))
      const message = Result.isFailure(result) ? result.failure.message : ''
      assert.include(message, `leads to process ${String(process.pid)}`)
      assert.include(message, 'nothing was sent')
      assert.strictEqual(other.bytes(), 0)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.live('reports a command QEMU refused, by what QEMU said', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* serve(`${dir}/control.socket`, command =>
        command === 'system_powerdown'
          ? '{"error": {"class": "GenericError", "desc": "no ACPI"}}'
          : '{"return": {}}',
      )

      const result = yield* Effect.result(
        Qmp.powerdown({ dir, name: 'control.socket', pid: process.pid }),
      )

      assert.isTrue(Result.isFailure(result))
      assert.strictEqual(
        Result.isFailure(result) ? result.failure.message : '',
        'QEMU refused system_powerdown: no ACPI',
      )
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.live('reports what QEMU said with its control characters made visible', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      // A title sequence, a line break and an 8-bit CSI, each of which a
      // terminal would act on.
      yield* serve(`${dir}/control.socket`, command =>
        command === 'system_powerdown'
          ? String.raw`{"error": {"class": "GenericError", "desc": "\u001b]0;x\u0007no\nACPI\u009b2J"}}`
          : '{"return": {}}',
      )

      const result = yield* Effect.result(
        Qmp.powerdown({ dir, name: 'control.socket', pid: process.pid }),
      )

      assert.strictEqual(
        Result.isFailure(result) ? result.failure.message : '',
        'QEMU refused system_powerdown: ?]0;x?no?ACPI?2J',
      )
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.live('reaches a socket whose path is longer than a socket address holds', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      // A runtime directory ends in the project's name, which is as long as a
      // directory name can be.
      const dir = `${yield* fs.makeTempDirectoryScoped()}/${'p'.repeat(120)}`
      yield* fs.makeDirectory(dir)
      // The server has the same limit, and gets around it the same way.
      const dirFd = yield* Effect.acquireRelease(
        Effect.sync(() => openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY)),
        fd => Effect.sync(() => closeSync(fd)),
      )
      const qemu = yield* serve(`/proc/self/fd/${String(dirFd)}/control.socket`)

      yield* Qmp.powerdown({ dir, name: 'control.socket', pid: process.pid })

      assert.deepStrictEqual(qemu.commands, ['qmp_capabilities', 'system_powerdown'])
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.live('fails when nothing is listening', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()

      const result = yield* Effect.result(
        Qmp.powerdown({ dir, name: 'control.socket', pid: process.pid }),
      )

      assert.isTrue(Result.isFailure(result))
      assert.include(
        Result.isFailure(result) ? result.failure.message : '',
        'nothing accepted a connection',
      )
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )
})
