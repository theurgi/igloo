import { Effect, FileSystem, Result, Schema } from 'effect'
import * as path from 'node:path'

export class TemplateError extends Schema.TaggedError<TemplateError>()('TemplateError', {
  message: Schema.String,
}) {}

/**
 * Where a new project's starting files come from: a directory laid out like a
 * project root, and the values given as `--set`. `dir` is `undefined` for a
 * user with no user layer, and may name a directory that does not exist, for
 * one whose layer declares no templates.
 */
export interface Source {
  readonly dir: string | undefined
  readonly set: Readonly<Record<string, string>>
}

/** Where a user layer keeps its templates, beside its two layer files. */
export const dirIn = (userLayerDir: string): string => path.join(userLayerDir, 'templates')

/** A template read and filled in, with its path relative to the project root. */
export type Entry =
  | { readonly kind: 'file'; readonly bytes: Uint8Array; readonly path: string }
  | { readonly kind: 'link'; readonly path: string; readonly target: string }

/** What became of one template. */
export type Outcome =
  | { readonly kind: 'wrote'; readonly path: string }
  | { readonly kind: 'linked'; readonly path: string; readonly target: string }
  | { readonly kind: 'skipped'; readonly path: string }

const NAME = '[A-Za-z_][A-Za-z0-9_]*'
const PLACEHOLDER = new RegExp(`@(${NAME})@`, 'g')
const KEY = new RegExp(`^${NAME}$`)

/** The values `init` gives itself, which `--set` may not. */
const RESERVED = ['at', 'project_name', 'project_root']

/**
 * The `--set` arguments as values by name. A value may be empty and may hold
 * `=`; a name has to be one a placeholder can spell.
 */
export const parseSet = (
  args: ReadonlyArray<string>,
): Result.Result<Readonly<Record<string, string>>, TemplateError> => {
  const set: Record<string, string> = {}
  for (const arg of args) {
    const cut = arg.indexOf('=')
    const key = cut === -1 ? arg : arg.slice(0, cut)
    if (cut === -1 || !KEY.test(key)) {
      return Result.fail(
        new TemplateError({
          message: `--set ${arg}: expected name=value, the name made of letters, digits and _ and not starting with a digit, as a template spells it between two @`,
        }),
      )
    }
    if (RESERVED.includes(key)) {
      return Result.fail(
        new TemplateError({
          message: `--set ${arg}: @${key}@ is a value igloo fills in itself`,
        }),
      )
    }
    set[key] = arg.slice(cut + 1)
  }
  return Result.succeed(set)
}

// `fatal` so that bytes which are not text are found out rather than replaced,
// and `ignoreBOM` so that a byte order mark stays in the text it began.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

/**
 * Replace each `@name@` in a template with its value, reading left to right,
 * and name the placeholders that have none.
 *
 * Only text is read for placeholders: bytes that hold a NUL or are not UTF-8
 * are an image or the like, where `@x@` turns up by chance. Those come back as
 * they were, and so does text in which nothing was replaced, so a file is
 * rewritten only where a value went in.
 */
export const fillIn = (
  bytes: Uint8Array,
  values: ReadonlyMap<string, string>,
): { readonly bytes: Uint8Array; readonly missing: ReadonlyArray<string> } => {
  if (bytes.includes(0)) return { bytes, missing: [] }
  let text: string
  try {
    text = decoder.decode(bytes)
  } catch {
    return { bytes, missing: [] }
  }
  const missing = new Set<string>()
  let replaced = false
  const filled = text.replaceAll(PLACEHOLDER, (whole, name: string) => {
    const value = values.get(name)
    if (value === undefined) {
      missing.add(name)
      return whole
    }
    replaced = true
    return value
  })
  return { bytes: replaced ? encoder.encode(filled) : bytes, missing: [...missing] }
}

type Kind = 'directory' | 'file' | 'link' | 'missing' | 'other'

/** What is at `target` itself, a link being a link wherever it leads. */
const kindOf = Effect.fnUntraced(function* (target: string) {
  const fs = yield* FileSystem.FileSystem
  if (Result.isSuccess(yield* Effect.result(fs.readLink(target)))) return 'link' satisfies Kind
  const info = yield* Effect.result(fs.stat(target))
  if (Result.isFailure(info)) return 'missing' satisfies Kind
  if (info.success.type === 'Directory') return 'directory' satisfies Kind
  return (info.success.type === 'File' ? 'file' : 'other') satisfies Kind
})

/** Whether `source` names a templates directory that is there. */
export const declared = Effect.fnUntraced(function* (source: Source) {
  return source.dir !== undefined && (yield* kindOf(source.dir)) !== 'missing'
})

type Found =
  | { readonly kind: 'file'; readonly from: string; readonly path: string }
  | { readonly kind: 'link'; readonly path: string; readonly target: string }

/**
 * Every file and link under `dir`, each directory's in the order of their names. A link is
 * recorded and not followed, so one to a directory is a link in the project
 * too. A directory is only somewhere its files are, so an empty one yields
 * nothing.
 */
const walk: (
  dir: string,
  prefix: string,
) => Effect.Effect<Array<Found>, TemplateError, FileSystem.FileSystem> = Effect.fnUntraced(
  function* (dir, prefix) {
    const fs = yield* FileSystem.FileSystem
    const names = yield* fs
      .readDirectory(dir)
      .pipe(Effect.mapError(() => new TemplateError({ message: `cannot read ${dir}` })))
    const found: Array<Found> = []
    for (const name of names.toSorted()) {
      const from = path.join(dir, name)
      const relative = path.join(prefix, name)
      const kind = yield* kindOf(from)
      if (kind === 'link') {
        const target = yield* fs
          .readLink(from)
          .pipe(Effect.mapError(() => new TemplateError({ message: `cannot read ${from}` })))
        found.push({ kind: 'link', path: relative, target })
        continue
      }
      if (kind === 'directory') found.push(...(yield* walk(from, relative)))
      else if (kind === 'file') found.push({ kind: 'file', from, path: relative })
      else {
        return yield* new TemplateError({
          message: `the template ${from} is neither a file, a link nor a directory`,
        })
      }
    }
    return found
  },
)

/** Each directory between `root` and the template at `relative`, outermost first. */
const parents = (root: string, relative: string): ReadonlyArray<string> => {
  const dirs: Array<string> = []
  let current = path.dirname(relative)
  while (current !== '.') {
    dirs.unshift(path.join(root, current))
    current = path.dirname(current)
  }
  return dirs
}

const refusal = (relative: string, parent: string, kind: Kind): TemplateError =>
  new TemplateError({
    message:
      kind === 'link'
        ? `refusing the template ${relative}: ${parent} is a link, and a template is written into the project, not wherever a link in it leads`
        : `cannot write the template ${relative}: ${parent} is not a directory`,
  })

/**
 * Read every template and fill it in for the project that `root` is about to
 * become, writing nothing. A project-relative path that could not be written
 * fails here, before there is a project, and so does a placeholder with no
 * value: all of them at once, each with the template that names it.
 */
export const plan = Effect.fnUntraced(function* (source: Source, root: string) {
  const fs = yield* FileSystem.FileSystem
  if (source.dir === undefined || !(yield* declared(source))) {
    const given = Object.keys(source.set)
    if (given.length === 0) return []
    return yield* new TemplateError({
      message: `--set gives a value to a template, and there are no templates: ${
        source.dir === undefined
          ? 'this igloo has no user layer. programs.igloo.templates declares them'
          : `${source.dir} does not exist`
      }`,
    })
  }

  const dir = yield* fs
    .realPath(source.dir)
    .pipe(Effect.mapError(() => new TemplateError({ message: `cannot resolve ${source.dir}` })))
  const values = new Map([
    ...Object.entries(source.set),
    ['at', '@'],
    ['project_name', path.basename(root)],
    ['project_root', root],
  ])

  const entries: Array<Entry> = []
  const unfilled: Array<string> = []
  for (const found of yield* walk(dir, '')) {
    for (const parent of parents(root, found.path)) {
      const kind = yield* kindOf(parent)
      if (kind === 'missing') break
      if (kind !== 'directory') return yield* refusal(found.path, parent, kind)
    }
    if (found.kind === 'link') {
      entries.push(found)
      continue
    }
    const raw = yield* fs
      .readFile(found.from)
      .pipe(Effect.mapError(() => new TemplateError({ message: `cannot read ${found.from}` })))
    const filled = fillIn(raw, values)
    if (filled.missing.length > 0) {
      unfilled.push(`  ${found.path}: ${filled.missing.map(name => `@${name}@`).join(', ')}`)
    }
    entries.push({ kind: 'file', bytes: filled.bytes, path: found.path })
  }

  if (unfilled.length > 0) {
    return yield* new TemplateError({
      message: `nothing was created, because a template names a value that was not given:\n${unfilled.join('\n')}\nGive each as --set name=value. A literal @ is written @at@.`,
    })
  }
  return entries
})

/**
 * Write planned templates under `root`, never over anything: a target that is
 * there already, a link that leads nowhere included, is left as it is. A file
 * is created with mode 0644, less what the umask takes, whatever its
 * template's, which in the store is read-only.
 */
export const write = Effect.fnUntraced(function* (root: string, entries: ReadonlyArray<Entry>) {
  const fs = yield* FileSystem.FileSystem
  const outcomes: Array<Outcome> = []
  for (const entry of entries) {
    const target = path.join(root, entry.path)
    const cannot = () => new TemplateError({ message: `cannot write ${target}` })
    // One level at a time and no link followed, where a recursive make would
    // create the rest wherever a link among the parents led.
    for (const parent of parents(root, entry.path)) {
      const kind = yield* kindOf(parent)
      if (kind === 'missing') yield* fs.makeDirectory(parent).pipe(Effect.mapError(cannot))
      else if (kind !== 'directory') return yield* refusal(entry.path, parent, kind)
    }
    if ((yield* kindOf(target)) !== 'missing') {
      outcomes.push({ kind: 'skipped', path: entry.path })
    } else if (entry.kind === 'link') {
      yield* fs.symlink(entry.target, target).pipe(Effect.mapError(cannot))
      outcomes.push({ kind: 'linked', path: entry.path, target: entry.target })
    } else {
      // Exclusive, so a file that appeared since the check is not written over.
      yield* fs
        .writeFile(target, entry.bytes, { flag: 'wx', mode: 0o644 })
        .pipe(Effect.mapError(cannot))
      outcomes.push({ kind: 'wrote', path: entry.path })
    }
  }
  return outcomes
})

/** What `init` prints about its templates, a line each, or nothing for none. */
export const report = (outcomes: ReadonlyArray<Outcome>): string => {
  if (outcomes.length === 0) return ''
  const lines = outcomes.map(outcome => {
    if (outcome.kind === 'wrote') return `  wrote    ${outcome.path}`
    if (outcome.kind === 'linked') return `  linked   ${outcome.path} -> ${outcome.target}`
    return `  skipped  ${outcome.path} (exists)`
  })
  return `templates\n${lines.join('\n')}\n`
}
