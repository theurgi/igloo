import { Effect, FileSystem, Option, Schema } from 'effect'
import * as crypto from 'node:crypto'
import * as path from 'node:path'

/**
 * What a VM was launched from: one hash per input, keyed by the name the
 * diagnostic will print.
 *
 * File paths where there is a file, because someone told their configuration
 * changed needs to know which one to look at. Not everything that decides a
 * launch is a file, so the key is a label rather than a path type.
 */
const Inputs = Schema.Record(Schema.String, Schema.String)

export type Inputs = typeof Inputs.Type

const InputsJson = Schema.fromJsonString(Inputs, { space: 2 })

/**
 * What a file that could not be read records as.
 *
 * Distinct from the hash of an empty file on purpose: a layer that was deleted
 * and a layer that was emptied are different events, and collapsing them would
 * make the first one invisible.
 */
const ABSENT = 'absent'

export const digest = (content: string): string =>
  crypto.createHash('sha256').update(content).digest('hex')

/**
 * Hash each file, keyed by its own path.
 *
 * Never fails: every use of this is a diagnostic, and a diagnostic that can
 * fail a launch is worse than no diagnostic. An unreadable file is recorded as
 * such rather than skipped, so its disappearance still counts as a change.
 *
 * **The caller must pass every file that decides the VM.** One left out is one
 * whose edit goes unreported — the content layers in particular are
 * *referenced* from the generated flake rather than inlined, so that file's
 * hash does not move when a layer changes. What this cannot reach either way is
 * a second file a content layer imports for itself.
 */
export const ofFiles = (files: readonly string[]) =>
  ofNamedFiles(Object.fromEntries(files.map(file => [file, file])))

/**
 * The same, keyed by a name the caller chooses rather than by the path.
 *
 * For a file whose path moves when the file has not: anything in the store,
 * where the path is a hash of the whole tree around it. Keyed by path, such a
 * file reads as one input removed and another added — changed twice over —
 * whether or not a byte of it differs.
 */
export const ofNamedFiles = Effect.fnUntraced(function* (files: Readonly<Record<string, string>>) {
  const fs = yield* FileSystem.FileSystem
  const hashed: Record<string, string> = {}
  for (const [name, file] of Object.entries(files)) {
    const content = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined))
    hashed[name] = content === undefined ? ABSENT : digest(content)
  }
  return hashed
})

/**
 * igloo's own files a runner is built from, each keyed by its path in igloo's
 * tree: `flake.nix`, `flake.lock`, and every file under `nix/`, where what the
 * flake defines lives.
 *
 * `nix/` is walked rather than listed, so a file added there is covered
 * without anyone remembering to add it here. Keyed by name for the reason
 * `ofNamedFiles` gives: igloo's tree moves in the store with every upgrade.
 */
export const ofIgloo = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const files = ['flake.lock', 'flake.nix']
  const nixDir = path.join(root, 'nix')
  const entries = yield* fs
    .readDirectory(nixDir, { recursive: true })
    .pipe(Effect.orElseSucceed(() => []))
  for (const entry of entries) {
    const info = yield* fs.stat(path.join(nixDir, entry)).pipe(Effect.option)
    if (Option.isSome(info) && info.value.type === 'File') files.push(path.join('nix', entry))
  }
  return yield* ofNamedFiles(
    Object.fromEntries(files.toSorted().map(file => [`igloo's ${file}`, path.join(root, file)])),
  )
})

/**
 * The inputs that differ between two records, sorted.
 *
 * An entry in one record and not the other counts as changed: a content layer
 * added or removed is a different VM, and the generated flake that names the
 * layers is hashed too, so both halves of that are visible.
 */
export const changed = (before: Inputs, after: Inputs): readonly string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(name => before[name] !== after[name])
    .toSorted()

/**
 * The record for the VM that is running, or `undefined` when there is none to
 * compare against.
 *
 * Absent and unchanged are different answers and the caller has to keep them
 * apart: a project whose last launch predates this file has nothing to compare,
 * and "your configuration changed" is not the honest answer to that.
 */
export const read = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeEffect(InputsJson)),
    Effect.orElseSucceed(() => undefined),
  )
})

/**
 * Best-effort, like everything here: a record that cannot be written costs a
 * later diagnostic, never this launch.
 */
export const write = Effect.fnUntraced(function* (file: string, record: Inputs) {
  const fs = yield* FileSystem.FileSystem
  yield* Schema.encodeEffect(InputsJson)(record).pipe(
    Effect.flatMap(json => fs.writeFileString(file, `${json}\n`)),
    Effect.ignore,
  )
})
