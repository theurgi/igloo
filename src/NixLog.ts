/**
 * nix's errors and warnings, kept in the boot record.
 *
 * A launch hands nix's stderr to the terminal as it is, since the progress bar
 * is the only sign a first build is moving, so igloo itself never reads nix's
 * account of a failure. nix's `json-log-path` setting, from Nix 2.30, sends a
 * copy of everything nix logs, as JSON lines, to a file or a Unix socket. A
 * socket rather than a file, because the copy carries every line every builder
 * prints, which for a large build runs to hundreds of megabytes: igloo reads it
 * as it comes and keeps only the messages logged as a warning or an error.
 */

import { Duration, Effect, FileSystem, Option, Schema } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import * as path from 'node:path'

/** The most a message may be and still be kept: nix's levels run from 0, an error, to 1, a warning. */
const WARNING = 1

/** A line of the copy that is a message, not an activity or a builder's output. */
const Message = Schema.fromJsonString(
  Schema.Struct({ action: Schema.Literal('msg'), level: Schema.Int, msg: Schema.String }),
)

const decodeMessage = Schema.decodeUnknownOption(Message)

/** nix colours a message whatever it writes it to. */
// oxlint-disable-next-line no-control-regex -- the escape is what this removes
const plain = (text: string): string => text.replaceAll(/\u001b\[[0-9;]*m/g, '')

/** What of one line of the copy is kept: the message, as it would read on a terminal. */
export const kept = (line: string): string | undefined =>
  decodeMessage(line).pipe(
    Option.filter(message => message.level <= WARNING),
    Option.map(message => plain(message.msg)),
    Option.getOrUndefined,
  )

/** How long the copy has to finish arriving once nix has exited, which closes it. */
const DRAIN = Duration.seconds(2)

interface Connection {
  readonly decoder: TextDecoder
  pending: string
}

/**
 * Listen on `socketPath`, giving `line` each line that any connection carries.
 * `idle` waits for every connection to have ended.
 */
const listen = (socketPath: string, line: (text: string) => void) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        let open = 0
        const waiting: Array<() => void> = []
        const split = (connection: Connection, text: string): void => {
          const lines = (connection.pending + text).split('\n')
          connection.pending = lines.pop() ?? ''
          for (const each of lines) line(each)
        }
        const listener = Bun.listen<Connection>({
          socket: {
            close(socket) {
              split(socket.data, `${socket.data.decoder.decode()}\n`)
              open--
              if (open === 0) for (const wake of waiting.splice(0)) wake()
            },
            data(socket, chunk) {
              split(socket.data, socket.data.decoder.decode(chunk, { stream: true }))
            },
            open(socket) {
              open++
              socket.data = { decoder: new TextDecoder(), pending: '' }
            },
          },
          unix: socketPath,
        })
        const idle = Effect.callback<void>(resume => {
          if (open === 0) resume(Effect.void)
          else waiting.push(() => resume(Effect.void))
        })
        return { idle, listener }
      },
      catch: () => `cannot listen on ${socketPath}`,
    }),
    ({ listener }) => Effect.sync(() => listener.stop(true)),
  )

/**
 * Whether this nix has `json-log-path`. One without it warns of an unknown
 * setting on every run it is passed to, and keeps nothing.
 */
const supported = (nix: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const code = yield* spawner.exitCode(
      ChildProcess.make(nix, ['config', 'show', 'json-log-path'], {
        extendEnv: true,
        stderr: 'ignore',
        stdin: 'ignore',
        stdout: 'ignore',
      }),
    )
    return code === 0
  }).pipe(Effect.orElseSucceed(() => false))

/** A nix command, given the arguments that send nix's log where it is kept. */
export type Keep = <A, E, R>(
  run: (args: readonly string[]) => Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>

/**
 * What runs each nix command of a launch so that its errors and warnings are
 * appended to `file`, once the command is done, however it ended.
 *
 * Keeping them is never worth a launch: on a nix without `json-log-path`, or
 * where the socket cannot be made, the command runs without it and nothing is
 * kept.
 */
export const make = Effect.fnUntraced(function* (nix: string, file: string) {
  const fs = yield* FileSystem.FileSystem
  const keeps = yield* supported(nix)
  const keep: Keep = run =>
    keeps
      ? Effect.scoped(
          Effect.gen(function* () {
            const messages: Array<string> = []
            const opened = yield* Effect.gen(function* () {
              const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'igloo-nix-' })
              const socketPath = path.join(dir, 'log.sock')
              const { idle } = yield* listen(socketPath, line => {
                const message = kept(line)
                if (message !== undefined) messages.push(message)
              })
              return { idle, socketPath }
            }).pipe(Effect.option)
            if (Option.isNone(opened)) return yield* run([])
            const { idle, socketPath } = opened.value
            return yield* run(['--option', 'json-log-path', socketPath]).pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  yield* Effect.timeoutOption(idle, DRAIN)
                  if (messages.length === 0) return
                  yield* fs
                    .writeFileString(file, messages.map(message => `${message}\n`).join(''), {
                      flag: 'a',
                    })
                    .pipe(Effect.ignore)
                }),
              ),
            )
          }),
        )
      : run([])
  return keep
})
