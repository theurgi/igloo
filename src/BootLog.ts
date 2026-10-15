import { Cause, Clock, DateTime, Effect, Exit, FileSystem, Random, Schema } from 'effect'
import * as path from 'node:path'

export class BootLogError extends Schema.TaggedError<BootLogError>()('BootLogError', {
  message: Schema.String,
}) {}

/**
 * Boot directories kept under a project's log directory. Pruned as a boot opens
 * rather than on a schedule, so nothing has to run between launches for the
 * trail to stay bounded.
 */
const RETAIN = 20

/** The newest boot directory, reachable without knowing its id. */
export const LATEST = 'latest'

/** One step of a launch, as it appears in the summary. */
interface PhaseTiming {
  readonly durationMs: number
  readonly name: string
  readonly ok: boolean
}

/** Anything added to the trail. `event` says which kind of line it is. */
export interface Event {
  readonly [key: string]: unknown
  readonly event: string
}

const Phase = Schema.Struct({
  durationMs: Schema.Finite,
  name: Schema.String,
  ok: Schema.Boolean,
})

/**
 * What a launch leaves behind, written the moment it concludes.
 *
 * `boot.jsonl` beside it carries the same story as it happened. That one is the
 * durable half: a launch that never concludes — killed, or hung on a step that
 * never returns — has a trail and no summary, and that is the case this record
 * exists for.
 */
const Summary = Schema.Struct({
  bootId: Schema.String,
  durationMs: Schema.Finite,
  failure: Schema.optionalKey(Schema.String),
  finishedAt: Schema.String,
  outcome: Schema.Literals(['success', 'failure', 'interrupted']),
  phases: Schema.Array(Phase),
  startedAt: Schema.String,
})

/** One line of `boot.jsonl`. */
const EventLine = Schema.fromJsonString(Schema.Unknown)

/** `boot.json`: how a launch ended, and how long each of its steps took. */
export const SummaryJson = Schema.fromJsonString(Summary, { space: 2 })

export interface Boot {
  /** This boot's directory. Every log file of the launch is written into it. */
  readonly dir: string
  /**
   * Remove this boot's directory, for a launch that concluded with nothing in
   * it worth reading, and point `latest` back at the newest boot that remains.
   * Only once nothing will write here again: a unit started with a log file in
   * this directory would lose it.
   */
  readonly discard: Effect.Effect<void>
  /** Absolute path for a log file in this boot's directory. */
  readonly file: (name: string) => string
  /**
   * Write the summary for however the launch ended. Only the first call writes
   * one, so a caller that concludes a boot explicitly keeps its own account.
   */
  readonly finish: <A, E>(exit: Exit.Exit<A, E>) => Effect.Effect<void>
  readonly id: string
  /**
   * Time a named step, recording its duration and whether it succeeded on both
   * paths. The original result is re-raised unchanged, so wrapping a step
   * cannot alter what it does.
   */
  readonly phase: <A, E, R>(name: string, step: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** Add a line to the trail. Never fails: a record is not worth a launch. */
  readonly record: (event: Event) => Effect.Effect<void>
}

const iso = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms))

/**
 * Sortable and collision-resistant: a fixed-width timestamp, so a lexical sort
 * is chronological — which the prune relies on — and a short random suffix, so
 * two launches in the same millisecond cannot share a directory.
 *
 * `:` and `.` are swapped out because the id is also a directory name.
 */
const bootId = (ms: number, entropy: number): string =>
  `${iso(ms).replaceAll(/[:.]/g, '-')}-${(entropy >>> 0).toString(16).slice(-4).padStart(4, '0')}`

/**
 * The boot directories under `logsRoot`, oldest first. Boot ids start with a
 * four-digit year, which is also what leaves `latest` out of the list rather
 * than a special case for it. Empty if the directory cannot be read.
 */
const listBoots = (
  fs: FileSystem.FileSystem,
  logsRoot: string,
): Effect.Effect<ReadonlyArray<string>> =>
  fs.readDirectory(logsRoot).pipe(
    Effect.map(entries => entries.filter(entry => /^\d{4}-/.test(entry)).toSorted()),
    Effect.orElseSucceed(() => []),
  )

/**
 * Drop the oldest boot directories, keeping `keep` of them.
 *
 * Best-effort throughout: a directory that cannot be read or removed must not
 * fail a launch.
 *
 * `keeping` is the boot being opened, and it is excluded by name rather than
 * assumed to sort last: the order here is the order of the timestamps in the
 * names, so a host clock that stepped backwards would otherwise make the
 * newest boot the first one deleted — out from under the launch writing to it.
 */
const prune = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  logsRoot: string,
  keep: number,
  keeping: string,
) {
  const boots = (yield* listBoots(fs, logsRoot)).filter(name => name !== keeping)
  for (const name of boots.slice(0, Math.max(0, boots.length - keep + 1))) {
    yield* fs.remove(path.join(logsRoot, name), { recursive: true }).pipe(Effect.ignore)
  }
})

/**
 * Open a boot directory under `logsRoot` and return the handle a launch writes
 * through.
 *
 * The units' own log files belong in here rather than in `logsRoot` itself:
 * systemd appends to the path it is given, so one flat `serial.log` would carry
 * every boot a project has ever had, in order, with nothing marking where one
 * ended — and would grow without bound. A directory per boot bounds both, and
 * the prune above keeps the set finite.
 */
export const open = Effect.fnUntraced(function* (logsRoot: string) {
  const fs = yield* FileSystem.FileSystem
  const startedMs = yield* Clock.currentTimeMillis
  const id = bootId(startedMs, yield* Random.nextInt)
  const dir = path.join(logsRoot, id)

  yield* fs
    .makeDirectory(dir, { recursive: true })
    .pipe(Effect.mapError(() => new BootLogError({ message: `cannot create ${dir}` })))

  const latest = path.join(logsRoot, LATEST)
  yield* fs.remove(latest, { force: true }).pipe(Effect.ignore)
  // Relative, so the link still resolves if the project directory moves.
  yield* fs.symlink(id, latest).pipe(Effect.ignore)
  yield* prune(fs, logsRoot, RETAIN, id)

  const phases: Array<PhaseTiming> = []
  let finished = false

  const file = (name: string): string => path.join(dir, name)

  // A line that cannot be written is dropped, as one that cannot be encoded
  // is: the trail is an account of a launch, never a reason for one to fail.
  const record = (event: Event): Effect.Effect<void> =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis
      const line = yield* Schema.encodeEffect(EventLine)({ t: iso(at), ...event })
      yield* fs.writeFileString(file('boot.jsonl'), `${line}\n`, { flag: 'a' })
    }).pipe(Effect.ignore)

  const phase = <A, E, R>(name: string, step: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis
      const exit = yield* Effect.exit(step)
      const durationMs = (yield* Clock.currentTimeMillis) - started
      const ok = Exit.isSuccess(exit)
      phases.push({ durationMs, name, ok })
      yield* record({ durationMs, event: 'phase', name, ok })
      return yield* exit
    })

  const finish = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (finished) return
      finished = true
      const finishedMs = yield* Clock.currentTimeMillis
      const durationMs = finishedMs - startedMs
      const outcome = Exit.isSuccess(exit)
        ? 'success'
        : Cause.hasInterruptsOnly(exit.cause)
          ? 'interrupted'
          : 'failure'
      yield* record({ durationMs, event: 'outcome', outcome })
      // The whole write is best-effort: it runs on the failure path too, where
      // a second failure would replace the one worth reporting.
      yield* Schema.encodeEffect(SummaryJson)({
        bootId: id,
        durationMs,
        ...(Exit.isSuccess(exit) ? {} : { failure: Cause.pretty(exit.cause) }),
        finishedAt: iso(finishedMs),
        outcome,
        phases,
        startedAt: iso(startedMs),
      }).pipe(
        Effect.andThen(json => fs.writeFileString(file('boot.json'), `${json}\n`)),
        Effect.ignore,
      )
    })

  const discard: Effect.Effect<void> = Effect.gen(function* () {
    yield* fs.remove(dir, { recursive: true }).pipe(Effect.ignore)
    // A launch that opened after this one owns the link now, and keeps it.
    const pointsHere = yield* fs.readLink(latest).pipe(
      Effect.map(target => target === id),
      Effect.orElseSucceed(() => false),
    )
    if (!pointsHere) return
    yield* fs.remove(latest, { force: true }).pipe(Effect.ignore)
    const newest = (yield* listBoots(fs, logsRoot)).at(-1)
    if (newest !== undefined) yield* fs.symlink(newest, latest).pipe(Effect.ignore)
  })

  return { dir, discard, file, finish, id, phase, record } satisfies Boot
})
