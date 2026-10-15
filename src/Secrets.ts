import { Effect, FileSystem, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import * as path from 'node:path'

/**
 * Never carries a secret's value, and never quotes a source's output. An error
 * is the surface most likely to be pasted somewhere, so the rule is that this
 * type can say which credential and which source failed, and nothing else.
 */
export class SecretsError extends Schema.TaggedError<SecretsError>()('SecretsError', {
  message: Schema.String,
}) {}

/**
 * Where the host gets a credential's value.
 *
 * `command` is the pluggability: `pass`, `keepassxc-cli`, `secret-tool`, the
 * 1Password CLI, a hardware-backed anything. One extension point rather than an
 * integration per store, which is what suits an audience of one — and it means
 * igloo stores nothing it does not have to.
 */
export type Source =
  | { readonly _tag: 'Command'; readonly argv: readonly [string, ...string[]] }
  | { readonly _tag: 'File'; readonly path: string }

/** One credential to place where QEMU will read it. */
export interface Delivery {
  /**
   * Where a command source runs: the directory of the layer that declared it,
   * never wherever the caller happened to be. That can be inside the
   * workspace, which the guest writes, so a relative command there would be the
   * guest's choice.
   */
  readonly cwd: string
  /** Under `XDG_RUNTIME_DIR`, which is a tmpfs: no copy is written to disk. */
  readonly hostPath: string
  readonly name: string
  readonly source: Source
}

/** How a source is named in a message, with nothing of its output in it. */
const describe = (source: Source): string =>
  source._tag === 'File' ? source.path : `\`${source.argv.join(' ')}\``

/**
 * How long a source may take.
 *
 * Generous because unlocking is legitimate: a gpg-agent passphrase prompt or a
 * hardware key's touch happens inside this budget, and a human is present by
 * construction — only a command a person just ran reaches this code.
 */
const budget = '120 seconds'

/**
 * Refused beyond this. It does not bound what the command allocates, since the
 * output is read before it is measured; it bounds what reaches a guest, and it
 * turns "the command printed its help" into a message rather than a credential.
 */
const maxBytes = 1024 * 1024

/**
 * The output convention, stated rather than inherited from whatever the shell
 * does: take stdout, and drop **one** trailing newline if present.
 *
 * Exactly one, because `pass` and friends terminate their output with a newline
 * that is not part of the secret, while a PEM private key ends with a newline
 * that is. Stripping all trailing whitespace would corrupt the second kind;
 * stripping none would corrupt the first.
 */
const oneTrailingNewline = (out: string): string => (out.endsWith('\n') ? out.slice(0, -1) : out)

/**
 * Run a source command and return its standard output — but only if it
 * succeeded.
 *
 * The exit code is checked explicitly, and that is the whole reason this does
 * not simply capture the output: a command that fails **and prints something**
 * would otherwise have whatever it printed delivered into a VM as the
 * credential. `pass show` on a missing entry is the mundane version, and an
 * error message is the last thing that should end up in an `Authorization`
 * header.
 *
 * stdin and stderr are the caller's terminal, so a passphrase prompt or a touch
 * request reaches the person who typed `igloo up`. Only stdout is captured,
 * which also keeps a chatty source's warnings out of the value.
 */
const fromCommand = Effect.fnUntraced(function* (
  name: string,
  argv: readonly [string, ...string[]],
  cwd: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const [command, ...args] = argv
  const refuse = (reason: string) =>
    new SecretsError({
      message: `${name}: ${describe({ _tag: 'Command', argv })} ${reason}`,
    })

  return yield* Effect.gen(function* () {
    const handle = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        cwd,
        extendEnv: true,
        stderr: 'inherit',
        stdin: 'inherit',
      }),
    )
    const out = yield* handle.stdout.pipe(Stream.decodeText, Stream.mkString)
    const code = yield* handle.exitCode
    if (code !== 0) return yield* refuse(`exited ${String(code)}; its own output is above.`)
    return out
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: budget,
      orElse: () =>
        Effect.fail(
          refuse(
            `did not finish within ${budget}. If it waits for input, it has to do so on this terminal.`,
          ),
        ),
    }),
    Effect.catchTag('PlatformError', () => Effect.fail(refuse('could not be run.'))),
  )
})

const fromFile = Effect.fnUntraced(function* (name: string, file: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(file).pipe(
    Effect.mapError(
      () =>
        new SecretsError({
          message: `${name}: cannot read ${file}.`,
        }),
    ),
  )
})

/**
 * Refuse a source the guest could have written.
 *
 * A command there would run the guest's code on the host, and a file there
 * could be a symlink the guest pointed at anything the developer can read,
 * which would then be delivered into the guest. So the path is checked both
 * resolved and by the resolved directory holding it: the first catches a link
 * into a guest directory, the second a link inside one.
 *
 * Only a command's program is checked. Its arguments are free text, and a
 * command named by bare name is found on `PATH`.
 */
const outsideGuest = Effect.fnUntraced(function* (
  name: string,
  file: string,
  guestWritable: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem
  const real = (target: string) => fs.realPath(target).pipe(Effect.orElseSucceed(() => target))
  const resolved = [yield* real(file), yield* real(path.dirname(file))]
  for (const dir of guestWritable) {
    const share = yield* real(dir)
    if (resolved.some(target => target === share || target.startsWith(`${share}/`))) {
      return yield* new SecretsError({
        message: `${name}: ${file} is inside ${dir}, which the guest can write, so it cannot be a credential's source. Keep the credential outside the project's workspace and home.`,
      })
    }
  }
})

/**
 * Fetch one credential's value. Kept private: a value that can be returned is a
 * value that can be logged, and nothing outside this module has a reason to
 * hold one.
 */
const fetch = Effect.fnUntraced(function* (delivery: Delivery, guestWritable: readonly string[]) {
  const { cwd, name, source } = delivery
  let raw: string
  if (source._tag === 'File') {
    yield* outsideGuest(name, source.path, guestWritable)
    raw = yield* fromFile(name, source.path)
  } else {
    const [program] = source.argv
    if (program.includes('/')) yield* outsideGuest(name, path.resolve(cwd, program), guestWritable)
    raw = yield* fromCommand(name, source.argv, cwd)
  }

  if (raw.length > maxBytes) {
    return yield* new SecretsError({
      message: `${delivery.name}: ${describe(delivery.source)} produced more than ${maxBytes} bytes, which is not a credential.`,
    })
  }
  const value = oneTrailingNewline(raw)
  if (value === '') {
    return yield* new SecretsError({
      message: `${delivery.name}: ${describe(delivery.source)} produced nothing.`,
    })
  }
  return value
})

/**
 * Fetch every credential and write it where QEMU will read it.
 *
 * Values live only here and in the files, both of which are on a tmpfs under
 * `XDG_RUNTIME_DIR` — mode 0600 inside a 0700 directory. Nothing is written
 * under the project, which is on disk and the kind of thing that ends up in a
 * backup.
 *
 * All-or-nothing on purpose. A VM that booted with half its credentials would
 * fail later, somewhere else, as an authentication error against whichever
 * upstream happened to be tried first.
 *
 * `guestWritable` is the host directories the guest can write, none of which a
 * source may lie in.
 */
export const write = Effect.fn('Secrets.write')(function* (
  deliveries: readonly Delivery[],
  guestWritable: readonly string[],
) {
  if (deliveries.length === 0) return
  const fs = yield* FileSystem.FileSystem

  for (const delivery of deliveries) {
    const value = yield* fetch(delivery, guestWritable)
    yield* fs
      .writeFileString(delivery.hostPath, value)
      .pipe(
        Effect.mapError(
          () =>
            new SecretsError({ message: `${delivery.name}: cannot write ${delivery.hostPath}.` }),
        ),
      )
    yield* fs
      .chmod(delivery.hostPath, 0o600)
      .pipe(
        Effect.mapError(
          () =>
            new SecretsError({ message: `${delivery.name}: cannot secure ${delivery.hostPath}.` }),
        ),
      )
  }
})
