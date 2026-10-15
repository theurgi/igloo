/**
 * A QMP client for exactly one exchange: asking a VM's QEMU to press the
 * guest's power button.
 *
 * The control socket is in the VM's runtime directory, which QEMU can write, so
 * its name may not lead to this VM's QEMU at all. A QEMU the guest has escaped
 * into can put a symlink there to another VM's control socket, and the power
 * event would then stop that VM instead. So which process is on the far end is
 * read off the connection itself, with `SO_PEERCRED`, and nothing is sent unless
 * it is the one the caller named. Checking the path before connecting would be
 * a race; checking the connection that carries the commands is not.
 *
 * Bun's sockets do not report their peer, so the connection is libc's, through
 * `bun:ffi`. Every call on it is non-blocking, so a peer that never answers
 * costs the caller's timeout rather than the event loop.
 */

import type { Library } from 'bun:ffi'

import { dlopen, FFIType } from 'bun:ffi'
import { Effect, Schema } from 'effect'
import { closeSync, constants, openSync } from 'node:fs'

export class QmpError extends Schema.TaggedError<QmpError>()('QmpError', {
  message: Schema.String,
}) {}

// Linux's values on x86_64, the one system the flake builds for.
const AF_UNIX = 1
const SOCK_STREAM = 1
const SOCK_NONBLOCK = 0o4000
const SOCK_CLOEXEC = 0o2000000
const SOL_SOCKET = 1
const SO_PEERCRED = 17
const POLLIN = 0x1
const MSG_DONTWAIT = 0x40
const MSG_NOSIGNAL = 0x4000
const O_PATH = 0o10000000
const O_CLOEXEC = 0o2000000
/** `struct sockaddr_un`: a two-byte family, then 108 bytes of path. */
const SOCKADDR_UN = 110

const definitions = {
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  connect: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  getsockopt: {
    args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  recv: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
  send: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
  socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
} as const

let opened: Library<typeof definitions>['symbols'] | undefined

/**
 * Opened on first use rather than on import, because every command imports this
 * and only `down` connects. By soname, which resolves to the libc this process
 * already has loaded.
 */
const libc = () => (opened ??= dlopen('libc.so.6', definitions).symbols)

/**
 * What QEMU sends, one JSON object per line: a greeting on connecting, then
 * events, and a reply to each command.
 */
const Message = Schema.fromJsonString(
  Schema.Struct({
    QMP: Schema.optionalKey(Schema.Unknown),
    error: Schema.optionalKey(Schema.Struct({ desc: Schema.String })),
    event: Schema.optionalKey(Schema.String),
    return: Schema.optionalKey(Schema.Unknown),
  }),
)

/**
 * More than QEMU's greeting, an event or a reply would ever need. A line that
 * runs past it is not QMP.
 */
const lineLimit = 64 * 1024

/**
 * Ask the QEMU at `dir`/`name` to power the guest off, if it is the process
 * `pid`, and return once QEMU has accepted the request. The guest's shutdown
 * takes longer than that; waiting on it is the caller's.
 *
 * The socket is reached through the directory's descriptor rather than by its
 * path, because a socket address holds at most 107 bytes and `dir` ends in a
 * project's name. The directory is not QEMU's to replace — only what is inside
 * it — so going through it changes nothing about what the name can lead to.
 */
export const powerdown = Effect.fnUntraced(function* (options: {
  readonly dir: string
  readonly name: string
  readonly pid: number
}) {
  const path = `${options.dir}/${options.name}`

  const dirFd = yield* Effect.acquireRelease(
    Effect.try({
      try: () => openSync(options.dir, O_PATH | constants.O_DIRECTORY | O_CLOEXEC),
      catch: () => new QmpError({ message: `cannot open ${options.dir}` }),
    }),
    held => Effect.sync(() => closeSync(held)),
  )
  const fd = yield* Effect.acquireRelease(
    Effect.suspend(() => {
      const created = libc().socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0)
      return created < 0
        ? Effect.fail(new QmpError({ message: 'cannot create a socket' }))
        : Effect.succeed(created)
    }),
    held => Effect.sync(() => libc().close(held)),
  )

  // Zero-filled, so the path is terminated however long it is.
  const address = new Uint8Array(SOCKADDR_UN)
  new DataView(address.buffer).setUint16(0, AF_UNIX, true)
  address.set(new TextEncoder().encode(`/proc/self/fd/${String(dirFd)}/${options.name}`), 2)
  if (libc().connect(fd, address, SOCKADDR_UN) !== 0) {
    return yield* new QmpError({ message: `nothing accepted a connection on ${path}` })
  }

  // `struct ucred`: the pid, uid and gid of whoever was listening, as of
  // when it began to.
  const peer = new Int32Array(3)
  if (libc().getsockopt(fd, SOL_SOCKET, SO_PEERCRED, peer, new Uint32Array([12])) !== 0) {
    return yield* new QmpError({ message: `cannot tell what is listening on ${path}` })
  }
  if (peer[0] !== options.pid) {
    return yield* new QmpError({
      message: `${path} leads to process ${String(peer[0])}, not to this VM's QEMU (${String(options.pid)}), so nothing was sent`,
    })
  }

  const chunk = new Uint8Array(4096)
  const decoder = new TextDecoder()
  const pollfd = new Uint8Array(8)
  const ready = new DataView(pollfd.buffer)
  let pending = ''

  const line = Effect.fnUntraced(function* () {
    for (;;) {
      const end = pending.indexOf('\n')
      if (end >= 0) {
        const found = pending.slice(0, end)
        pending = pending.slice(end + 1)
        return found
      }
      if (pending.length > lineLimit) {
        return yield* new QmpError({ message: `${path} sent a line too long to be QMP` })
      }
      // `struct pollfd`. Any event at all is a reason to read: data, or the
      // hang-up or error that `recv` then reports.
      ready.setInt32(0, fd, true)
      ready.setInt16(4, POLLIN, true)
      if (libc().poll(pollfd, 1, 0) <= 0) {
        yield* Effect.sleep('20 millis')
        continue
      }
      const read = Number(libc().recv(fd, chunk, chunk.length, MSG_DONTWAIT))
      if (read <= 0) {
        return yield* new QmpError({ message: `QEMU closed ${path} before it replied` })
      }
      pending += decoder.decode(chunk.subarray(0, read), { stream: true })
    }
  })

  const message = Effect.fnUntraced(function* () {
    return yield* Schema.decodeEffect(Message)(yield* line()).pipe(
      Effect.mapError(() => new QmpError({ message: `${path} sent something that is not QMP` })),
    )
  })

  const greeting = yield* message()
  if (!('QMP' in greeting)) {
    return yield* new QmpError({ message: `${path} did not greet as QMP does` })
  }

  for (const command of ['qmp_capabilities', 'system_powerdown']) {
    const bytes = new TextEncoder().encode(`{"execute": "${command}"}\n`)
    // A command is a few dozen bytes into an empty buffer, so all of it is
    // written at once or the connection is broken.
    if (
      Number(libc().send(fd, bytes, bytes.length, MSG_DONTWAIT | MSG_NOSIGNAL)) !== bytes.length
    ) {
      return yield* new QmpError({ message: `cannot send ${command} to ${path}` })
    }
    // Events can arrive between a command and its reply, and say nothing
    // about it.
    for (;;) {
      const reply = yield* message()
      if (reply.error !== undefined) {
        return yield* new QmpError({ message: `QEMU refused ${command}: ${reply.error.desc}` })
      }
      if ('return' in reply) break
    }
  }
}, Effect.scoped)
