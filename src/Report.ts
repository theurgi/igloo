/**
 * `igloo report`: what a bug report needs, as markdown to paste — the version,
 * `doctor`'s output and a launch's boot record — with what identifies the
 * machine and the person running it replaced by placeholders.
 *
 * It reads no layer and evaluates nothing, since a layer that does not evaluate
 * may be the bug being reported. Every value it replaces comes from the
 * environment, the project's root, and the record itself.
 */

import { Effect, FileSystem, Option, Predicate, Schema } from 'effect'
import { isIPv4, isIPv6 } from 'node:net'
import * as path from 'node:path'

import * as BootLog from './BootLog.ts'
import { profiles } from './broker.ts'
import * as Flake from './Flake.ts'
import * as Project from './Project.ts'

export class ReportError extends Schema.TaggedError<ReportError>()('ReportError', {
  message: Schema.String,
}) {}

/**
 * GitHub refuses an issue body longer than 65,536 characters, and the report
 * shares one with what the reporter writes above it.
 */
export const budget = 60_000

/** Held back for the table of what was replaced, which is written after the logs are cut. */
const tableAllowance = 2_000

/**
 * Each kind of value replaced, and what its placeholder stands for. A kind
 * without a fixed placeholder numbers its values, `<repo-1>`, `<repo-2>`, so
 * that one value reads the same everywhere and two never read alike.
 */
const kinds = {
  'project-root': { fixed: '<project-root>', standsFor: "the project's directory" },
  home: { fixed: '~', standsFor: 'the home directory' },
  user: { fixed: '<user>', standsFor: 'the user name' },
  hostname: { fixed: '<hostname>', standsFor: "this machine's host name" },
  project: { fixed: '<project>', standsFor: "the project's name" },
  'guest-hostname': { fixed: '<guest-hostname>', standsFor: "the guest's host name" },
  cid: { fixed: '<cid>', standsFor: "the guest's CID, a hash of the project's directory" },
  credential: { standsFor: "a credential's name" },
  repo: { standsFor: 'a repository' },
  'model-server': { standsFor: "a model server's name" },
  destination: { standsFor: 'a tunnel destination' },
  address: { standsFor: 'an address a destination resolved to' },
  host: { standsFor: 'a host name' },
  ip: { standsFor: 'an IP address' },
  email: { standsFor: 'an email address' },
  url: { standsFor: "a URL's path, or who it logs in as" },
} as const satisfies Record<string, KindInfo>

interface KindInfo {
  readonly fixed?: string
  readonly standsFor: string
}

type Kind = keyof typeof kinds

const isPathKind = (kind: Kind): boolean => kind === 'home' || kind === 'project-root'

/** Found by its shape wherever it is, rather than by its value. */
const isShapeKind = (kind: Kind): boolean =>
  kind === 'address' || kind === 'ip' || kind === 'email' || kind === 'url'

/**
 * Words that occur in ordinary output and identify nobody, which a value equal
 * to one is not worth taking with it: a user called `dev` would otherwise turn
 * every `/dev` into a placeholder. `scripts/redact.sh` leaves the same ones.
 */
const ordinary = [
  'root',
  'user',
  'users',
  'admin',
  'dev',
  'test',
  'guest',
  'home',
  'nixos',
  'localhost',
  'system',
  'server',
  'desktop',
  'laptop',
  'workstation',
  'nix',
  'igloo',
  'host',
  'main',
  'default',
  'local',
]

/**
 * The hosts igloo itself names: the binary cache every guest is built from,
 * and each broker profile's upstream. A URL keeps one of these.
 */
const namedHosts: ReadonlySet<string> = new Set([
  'cache.nixos.org',
  ...Object.values(profiles).map(profile => profile.host),
])

/**
 * What igloo itself calls things. A field holding one keeps it, and text keeps
 * every occurrence, so that a credential named after its profile, or a project
 * called `api`, does not take `api.anthropic.com` with it.
 */
const vocabulary: ReadonlySet<string> = new Set([
  ...ordinary,
  ...namedHosts,
  ...Object.keys(profiles),
  'model-server',
  // A tunnel's destinations when it may reach any public name.
  'any',
])

/** Kept wherever they occur as whole names, before any value is looked for. */
const kept: readonly string[] = [...namedHosts, '/nix/store']

/** `host` and `:port` of an authority, a bracketed IPv6 address's brackets kept. */
const splitHostPort = (hostPort: string): { readonly host: string; readonly port: string } => {
  const [, host = hostPort, port = ''] = /^(\[[^\]]*\]|[^:]*)(:\d*)?$/.exec(hostPort) ?? []
  return { host, port }
}

const unbracketed = (host: string): string => host.replace(/^\[(.*)\]$/, '$1')

/** Loopback, with or without a port, which says nothing about any machine. */
const isLoopback = (hostPort: string): boolean => {
  const host = unbracketed(splitHostPort(hostPort).host).toLowerCase()
  return host === 'localhost' || host === '::1' || (isIPv4(host) && host.startsWith('127.'))
}

/** An address that is no machine's own: loopback, or the unspecified one. */
const isNoMachines = (address: string): boolean =>
  address === '0.0.0.0' || address === '::' || isLoopback(address)

/**
 * The fields igloo writes that identify, by file and by what each holds. A field
 * means one thing on every line of its file — the broker's, as `audit` in
 * `broker.ts` sets out — but not across files: in `boot.jsonl`, `scope` is a
 * systemd unit.
 */
const fieldsOf: ReadonlyMap<string, ReadonlyMap<string, Kind>> = new Map([
  ['boot.jsonl', new Map([['credentials', 'credential']])],
  [
    'broker.log',
    new Map([
      ['address', 'address'],
      ['credential', 'credential'],
      ['credentials', 'credential'],
      ['destinations', 'destination'],
      ['host', 'host'],
      ['repos', 'repo'],
      ['scope', 'repo'],
      ['server', 'model-server'],
      ['target', 'destination'],
    ]),
  ],
])

/** What a line or a file became, and how many times each placeholder went into it. */
interface Redacted {
  readonly placed: ReadonlyMap<string, number>
  readonly text: string
}

/**
 * Every value the report replaces, each with its placeholder: one per distinct
 * value across the whole report, whichever file it is in and whichever way it
 * was found.
 */
const makeValues = () => {
  const byValue = new Map<string, string>()
  const kindOf = new Map<string, Kind>()
  const numbered = new Map<Kind, number>()
  let inText: ReadonlyArray<{
    readonly path: boolean
    readonly placeholder: string
    readonly value: string
  }> = []

  // Paths as they are, and names regardless of case, as hosts and
  // repositories are compared.
  const keyOf = (kind: Kind, value: string): string =>
    isPathKind(kind) ? value : value.toLowerCase()

  /**
   * The placeholder for `value`, given it on first sight, whatever kind it was
   * found as then. A value found by its
   * shape is found that way every time; any other is also replaced wherever it
   * occurs, unless it is too short or too common to take with it: a path that
   * is not `/` or `/root`, or a name of three characters or more that is not
   * one igloo itself uses.
   */
  const add = (kind: Kind, value: string): string => {
    const key = keyOf(kind, value)
    const known = byValue.get(key)
    if (known !== undefined) return known
    const { fixed }: KindInfo = kinds[kind]
    const n = (numbered.get(kind) ?? 0) + 1
    if (fixed === undefined) numbered.set(kind, n)
    const placeholder = fixed ?? `<${kind}-${String(n)}>`
    byValue.set(key, placeholder)
    kindOf.set(placeholder, kind)
    const replaced = isShapeKind(kind)
      ? false
      : isPathKind(kind)
        ? value !== '/' && value !== '/root'
        : value.length >= 3 && !vocabulary.has(key)
    if (replaced) {
      // Paths before names, and longer before shorter, so that no value
      // replaces part of another: a project's root before the home directory
      // it is in.
      inText = [...inText, { path: isPathKind(kind), placeholder, value }].toSorted(
        (a, b) => Number(b.path) - Number(a.path) || b.value.length - a.value.length,
      )
    }
    return placeholder
  }

  return {
    add,
    inText: () => inText,
    kindOf: (placeholder: string): Kind | undefined => kindOf.get(placeholder),
  }
}

type Values = ReturnType<typeof makeValues>

/** A run of text: still to be read, or settled — a placeholder, or text kept as it is. */
interface Piece {
  readonly placeholder?: string
  readonly settled: boolean
  readonly text: string
}

interface Span {
  readonly end: number
  readonly placeholder?: string
  readonly start: number
  readonly text: string
}

/**
 * Settle what `find` finds in each piece still to be read. `find` is given the
 * characters either side of the piece, so a boundary reads the same whether or
 * not a placeholder went in beside it, and yields spans in order, none
 * overlapping.
 */
const settle = (
  pieces: readonly Piece[],
  find: (text: string, before: string, after: string) => Iterable<Span>,
): Array<Piece> =>
  pieces.flatMap((piece, at) => {
    if (piece.settled) return [piece]
    const out: Array<Piece> = []
    let from = 0
    for (const span of find(
      piece.text,
      pieces[at - 1]?.text.at(-1) ?? '',
      pieces[at + 1]?.text[0] ?? '',
    )) {
      if (span.start > from) out.push({ settled: false, text: piece.text.slice(from, span.start) })
      out.push({
        ...(span.placeholder === undefined ? {} : { placeholder: span.placeholder }),
        settled: true,
        text: span.text,
      })
      from = span.end
    }
    if (from < piece.text.length) out.push({ settled: false, text: piece.text.slice(from) })
    return out
  })

const nameChar = /[A-Za-z0-9_]/
const pathChar = /[A-Za-z0-9_.-]/

/**
 * Every occurrence of `value` that stands alone: a name not inside a longer
 * word, and a path not inside a longer path.
 */
function* occurrences(
  text: string,
  before: string,
  after: string,
  value: string,
  asPath: boolean,
): Generator<Span> {
  const haystack = asPath ? text : text.toLowerCase()
  const needle = asPath ? value : value.toLowerCase()
  let from = 0
  for (;;) {
    const start = haystack.indexOf(needle, from)
    if (start === -1) return
    const end = start + needle.length
    const previous = start === 0 ? before : (text[start - 1] ?? '')
    const next = end === text.length ? after : (text[end] ?? '')
    const alone = asPath ? !pathChar.test(next) : !nameChar.test(previous) && !nameChar.test(next)
    if (alone) {
      yield { end, start, text: text.slice(start, end) }
      from = end
    } else {
      from = start + 1
    }
  }
}

/**
 * `scheme://`, an authority and what follows it. It ends at whitespace, a
 * quote, a bracket or a backslash, which is where a URL inside a sentence, a
 * JSON string or an error message ends.
 */
const urlPattern =
  /\b([A-Za-z][A-Za-z0-9+.-]*):\/\/([^\s/?#"'<>()[\]{}\\`]*)([^\s"'<>()[\]{}\\`]*)/g

const emailPattern =
  /(?<![\w.%+-])[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g

/** systemd's template units, such as `getty@tty1.service`, have an email address's shape. */
const unitSuffix =
  /\.(?:automount|device|mount|path|scope|service|slice|socket|swap|target|timer)$/i

const ipv4Pattern = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\w|\.\d)/g

const ipv6Pattern = /(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])/g

/** Whether a match of `ipv6Pattern` is an address, rather than a time of day or a hex dump. */
const isIpv6Address = (candidate: string): boolean =>
  isIPv6(candidate) && (candidate.includes('::') || candidate.split(':').length === 8)

/**
 * A URL as the report shows it: its scheme, then its host if igloo names it or
 * it is loopback, and a placeholder for the rest — for who it logs in as, and
 * for its path, query and fragment. A host it replaces is a value from then
 * on, so the same name outside a URL, in the error that failed to reach it, is
 * replaced too.
 */
function* urls(values: Values, text: string): Generator<Span> {
  for (const match of text.matchAll(urlPattern)) {
    const [whole, scheme = '', found = ''] = match
    // A full stop or a comma after a URL ends the sentence it is in.
    const trailing = /[.,;:!?]+$/.exec(whole)?.[0] ?? ''
    const rest = (match[3] ?? '').slice(0, (match[3] ?? '').length - trailing.length)
    const authority = rest === '' ? found.slice(0, found.length - trailing.length) : found
    const at = match.index
    const hostAt = at + scheme.length + 3
    yield { end: hostAt, start: at, text: `${scheme}://` }

    const login = authority.lastIndexOf('@')
    if (login !== -1) {
      const placeholder = values.add('url', `login:${authority.slice(0, login)}`)
      yield { end: hostAt + login + 1, placeholder, start: hostAt, text: `${placeholder}@` }
    }
    const hostPort = authority.slice(login + 1)
    const { host, port } = splitHostPort(hostPort)
    const bare = unbracketed(host)
    const hostStart = hostAt + login + 1
    if (bare !== '' && !namedHosts.has(bare.toLowerCase()) && !isLoopback(hostPort)) {
      const placeholder = values.add(isIPv4(bare) || isIPv6(bare) ? 'ip' : 'host', bare)
      yield { end: hostStart + host.length, placeholder, start: hostStart, text: placeholder }
    } else if (hostPort !== '') {
      yield { end: hostStart + host.length, start: hostStart, text: host }
    }
    if (port !== '') {
      yield { end: hostStart + hostPort.length, start: hostStart + host.length, text: port }
    }

    if (rest !== '' && rest !== '/') {
      const placeholder = values.add('url', `path:${rest}`)
      yield {
        end: hostAt + authority.length + rest.length,
        placeholder,
        start: hostAt + authority.length,
        text: `${rest.startsWith('/') ? '/' : ''}${placeholder}`,
      }
    }
  }
}

/**
 * Replace what identifies in one string: URLs and email addresses, then the
 * values known by now, then IP addresses.
 *
 * A URL and an email address go first, and whole, because every part of one
 * may identify. The hosts igloo names, and `/nix/store`, are kept whole before
 * any value is looked for. Every IP address but loopback is replaced by its
 * shape, which covers the machine's own addresses, its gateways and its DNS
 * servers. Its interface names, hardware addresses and search domains reach no
 * boot record, since no guest has a network card.
 */
const redactText = (values: Values, text: string): Redacted => {
  let pieces: Array<Piece> = [{ settled: false, text }]

  pieces = settle(pieces, piece => urls(values, piece))

  pieces = settle(pieces, function* (piece) {
    for (const match of piece.matchAll(emailPattern)) {
      if (unitSuffix.test(match[0])) continue
      const placeholder = values.add('email', match[0])
      yield {
        end: match.index + match[0].length,
        placeholder,
        start: match.index,
        text: placeholder,
      }
    }
  })

  for (const name of kept) {
    pieces = settle(pieces, (piece, before, after) =>
      occurrences(piece, before, after, name, false),
    )
  }

  for (const { path: asPath, placeholder, value } of values.inText()) {
    pieces = settle(pieces, function* (piece, before, after) {
      for (const { end, start } of occurrences(piece, before, after, value, asPath)) {
        yield { end, placeholder, start, text: placeholder }
      }
    })
  }

  for (const [pattern, isAddress] of [
    [ipv4Pattern, isIPv4],
    [ipv6Pattern, isIpv6Address],
  ] as const) {
    pieces = settle(pieces, function* (piece) {
      for (const match of piece.matchAll(pattern)) {
        const address = match[0].toLowerCase()
        if (!isAddress(address) || isNoMachines(address)) continue
        const placeholder = values.add('ip', address)
        yield {
          end: match.index + match[0].length,
          placeholder,
          start: match.index,
          text: placeholder,
        }
      }
    })
  }

  const placed = new Map<string, number>()
  for (const { placeholder } of pieces) {
    if (placeholder !== undefined) placed.set(placeholder, (placed.get(placeholder) ?? 0) + 1)
  }
  return { placed, text: pieces.map(piece => piece.text).join('') }
}

/** Tallies of placements, as one. */
const sum = (tallies: Iterable<ReadonlyMap<string, number>>): Map<string, number> => {
  const total = new Map<string, number>()
  for (const tally of tallies) {
    for (const [placeholder, n] of tally) total.set(placeholder, (total.get(placeholder) ?? 0) + n)
  }
  return total
}

/**
 * A field holding `text`, as the report shows it: one of `fields` is replaced by
 * what it holds, whatever that is, unless igloo itself names it, and any other
 * is text. A target's port stays, since the destination is the name before it.
 */
const fieldText = (
  values: Values,
  fields: ReadonlyMap<string, Kind>,
  field: string | undefined,
  text: string,
): Redacted => {
  const kind = field === undefined ? undefined : fields.get(field)
  if (kind === undefined) return redactText(values, text)
  const port = field === 'target' ? (/:\d+$/.exec(text)?.[0] ?? '') : ''
  const value = text.slice(0, text.length - port.length)
  if (vocabulary.has(value.toLowerCase()) || isLoopback(value)) return { placed: new Map(), text }
  const placeholder = values.add(kind, value)
  return { placed: new Map([[placeholder, 1]]), text: `${placeholder}${port}` }
}

/**
 * A decoded JSON value with each string in it replaced through `each`, which is
 * told the field the string is in; a list's items are in the list's field.
 */
const mapStrings = (
  value: unknown,
  each: (text: string, field: string | undefined) => Redacted,
  placed: Array<ReadonlyMap<string, number>>,
  field?: string,
): unknown => {
  if (Predicate.isString(value)) {
    const done = each(value, field)
    placed.push(done.placed)
    return done.text
  }
  if (Array.isArray(value)) return value.map(item => mapStrings(item, each, placed, field))
  if (Predicate.isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, each, placed, key)]),
    )
  }
  return value
}

const decodeJson = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))

/** One JSON value, redacted string by string and encoded again as it was written. */
const redactJson = (
  value: unknown,
  each: (text: string, field: string | undefined) => Redacted,
  space?: number,
): Redacted => {
  const placed: Array<ReadonlyMap<string, number>> = []
  const text = JSON.stringify(mapStrings(value, each, placed), undefined, space)
  return { placed: sum(placed), text }
}

/**
 * The escapes and colour codes a console writes, which a pasted report shows as
 * noise: each sequence whole, from a string one such as systemd's OSC 3008
 * context to one of a single character such as its reset, `ESC c`, and any
 * other control character.
 */
const printable = (line: string): string =>
  line.replaceAll(
    // oxlint-disable-next-line no-control-regex -- control characters are what this removes
    /\u001b[\]PX^_][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[ -/]*[0-~]|[\u0000-\u0008\u000b-\u001f\u007f]/g,
    '',
  )

/**
 * One file's lines, each with what was placed in it. JSON is redacted value by
 * value rather than as text, so that an escape such as `\n` cannot hide where a
 * word begins. A line that is not the JSON its file should hold is text.
 */
const redactFile = (values: Values, name: string, text: string): Array<Redacted> => {
  const fields = fieldsOf.get(name)
  const each =
    fields === undefined
      ? (part: string) => redactText(values, part)
      : (part: string, field: string | undefined) => fieldText(values, fields, field, part)
  if (name.endsWith('.json')) {
    const decoded = decodeJson(text)
    if (Option.isSome(decoded)) {
      const whole = redactJson(decoded.value, each, 2)
      return whole.text
        .split('\n')
        .map((line, at) => ({ placed: at === 0 ? whole.placed : new Map(), text: line }))
    }
  }
  if (text === '') return []
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
  const ofJson = fields !== undefined || name.endsWith('.jsonl')
  return lines.map(line => {
    const decoded = ofJson ? decodeJson(line) : Option.none()
    return Option.isSome(decoded) && Predicate.isObject(decoded.value)
      ? redactJson(decoded.value, each)
      : redactText(values, printable(line))
  })
}

/** The files of a boot record in the order the report shows them: its summary and trail first. */
const order = (name: string): string =>
  name === 'boot.json' ? '0' : name === 'boot.jsonl' ? '1' : `2${name}`

/** A fence no line of `lines` can close early. */
const fenceFor = (lines: readonly string[]): string => {
  let longest = 2
  for (const line of lines) {
    for (const run of line.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
  }
  return '`'.repeat(longest + 1)
}

const block = (info: string, lines: readonly string[]): string => {
  const fence = fenceFor(lines)
  return [`${fence}${info}`, ...lines, fence].join('\n')
}

const fileHeading = (name: string): string => `##### \`${name}\``

/** The fence, info string and marker line a cut file takes besides its lines. */
const frameAllowance = 120

/**
 * How much of `total` each of `sizes` gets: an even share, and what a smaller
 * one does not need goes to the larger ones.
 */
const shares = (sizes: readonly number[], total: number): Array<number> => {
  const out = sizes.map(() => 0)
  let left = Math.max(0, total)
  const smallestFirst = sizes.map((size, at) => ({ at, size })).toSorted((a, b) => a.size - b.size)
  for (const [done, { at, size }] of smallestFirst.entries()) {
    const share = Math.min(size, Math.floor(left / (smallestFirst.length - done)))
    out[at] = share
    left -= share
  }
  return out
}

/** The last of `lines` that fit in `room` characters, and how many before them were left out. */
const tail = (
  lines: readonly Redacted[],
  room: number,
): { readonly kept: ReadonlyArray<Redacted>; readonly left: number } => {
  let used = 0
  let from = lines.length
  while (from > 0) {
    const next = (lines[from - 1]?.text.length ?? 0) + 1
    if (used + next > room) break
    used += next
    from--
  }
  return { kept: lines.slice(from), left: from }
}

const linesOf = (count: number): string => `${String(count)} ${count === 1 ? 'line' : 'lines'}`

/** What the report says of each kind it replaced: how many values, and in how many places. */
const table = (values: Values, placed: ReadonlyMap<string, number>): string => {
  const rows: Array<string> = []
  for (const [kind, info] of Object.entries<KindInfo>(kinds)) {
    const used = [...placed].filter(([placeholder]) => values.kindOf(placeholder) === kind)
    if (used.length === 0) continue
    const places = used.reduce((total, [, n]) => total + n, 0)
    rows.push(
      `| \`${info.fixed ?? `<${kind}-N>`}\` | ${info.standsFor} | ${String(used.length)} | ${String(places)} |`,
    )
  }
  return rows.length === 0
    ? 'Nothing in this report needed replacing.'
    : [
        'Each value that identifies this machine or you is replaced by a placeholder, the same one wherever it occurs:',
        '',
        '| Placeholder | Stands for | Values | Places |',
        '| --- | --- | --: | --: |',
        ...rows,
      ].join('\n')
}

/** What the report replaces, known before it reads anything. */
export interface Known {
  /** The home directory, as the environment gives it and as it resolves. */
  readonly home: readonly string[]
  readonly hostName: string
  readonly project:
    | { readonly cid: number; readonly label: string; readonly root: string }
    | undefined
  readonly user: string | undefined
}

/** A boot record: its id and its files, as they were read. */
export interface BootRecord {
  readonly files: ReadonlyArray<{ readonly name: string; readonly text: string }>
  readonly id: string
}

export interface Parts {
  readonly doctor: string
  readonly known: Known
  /** The boot record, or why there is none. */
  readonly record: BootRecord | string
  /** The commit igloo was built from, when its flake recorded one. */
  readonly revision: string | undefined
  readonly version: string
}

/**
 * The report, as markdown. Pure, so that what it replaces, and how it cuts a
 * record to fit, are asserted rather than eyeballed.
 *
 * Values are gathered before anything is replaced: the fields igloo writes
 * first, so a value one names has its kind's placeholder everywhere, then
 * every URL's host, so that a host's name is replaced where it occurs outside
 * one too.
 */
export const render = (parts: Parts): string => {
  const values = makeValues()
  const { known } = parts
  if (known.project !== undefined) values.add('project-root', known.project.root)
  for (const home of known.home) values.add('home', home)
  if (known.user !== undefined && known.user !== '') values.add('user', known.user)
  for (const name of new Set([known.hostName, known.hostName.split('.')[0] ?? ''])) {
    if (name !== '') values.add('hostname', name)
  }
  if (known.project !== undefined) {
    values.add('project', known.project.label)
    values.add('guest-hostname', Flake.hostNameFrom(known.project.label))
    // In decimal, and in hex as every unit's name has it.
    values.add('cid', String(known.project.cid))
    values.add('cid', known.project.cid.toString(16))
  }

  const files =
    typeof parts.record === 'string'
      ? []
      : parts.record.files.toSorted((a, b) => order(a.name).localeCompare(order(b.name)))
  const structured = files.filter(file => fieldsOf.has(file.name))
  for (const { name, text } of [...structured, { name: 'doctor', text: parts.doctor }, ...files]) {
    redactFile(values, name, text)
  }

  const doctor = redactFile(values, 'doctor', parts.doctor)
  const summary = files.find(file => file.name === 'boot.json')
  const summaryLines = summary === undefined ? [] : redactFile(values, summary.name, summary.text)
  const logs = files
    .filter(file => file.name !== 'boot.json')
    .map(file => ({ lines: redactFile(values, file.name, file.text), name: file.name }))

  const version = [
    '#### Version',
    '',
    parts.revision === undefined
      ? `igloo ${parts.version}, from a build that records no commit`
      : `igloo ${parts.version}, commit \`${parts.revision}\``,
  ].join('\n')
  const doctorSection = [
    '#### `igloo doctor`',
    '',
    block(
      'text',
      doctor.map(line => line.text),
    ),
  ].join('\n')
  const head =
    typeof parts.record === 'string'
      ? ['#### Boot record', '', `None: ${redactText(values, parts.record).text}.`].join('\n')
      : [
          `#### Boot record \`${parts.record.id}\``,
          ...(summary === undefined
            ? []
            : [
                '',
                fileHeading('boot.json'),
                '',
                block(
                  'json',
                  summaryLines.map(line => line.text),
                ),
              ]),
        ].join('\n')
  const note =
    typeof parts.record === 'string'
      ? undefined
      : "Text igloo doesn't write itself, such as Nix's errors and the guest's console, is searched only for these values and for anything shaped like an email address, an IP address or a URL. Read it before you post: what is left is what your own build or guest printed."

  const fixed =
    version.length +
    doctorSection.length +
    head.length +
    (note?.length ?? 0) +
    logs.reduce((total, log) => total + fileHeading(log.name).length + frameAllowance, 0)
  const room = shares(
    logs.map(log => log.lines.reduce((total, line) => total + line.text.length + 1, 0)),
    budget - tableAllowance - fixed,
  )
  const shown = logs.map((log, at) => {
    const { kept: lines, left } = tail(log.lines, room[at] ?? 0)
    const text = lines.map(line => line.text)
    const body =
      log.lines.length === 0
        ? 'Empty.'
        : block(
            log.name.endsWith('.jsonl') ? 'json' : 'text',
            left === 0 ? text : [`[${linesOf(left)} before these left out]`, ...text],
          )
    return { lines, section: [fileHeading(log.name), '', body].join('\n') }
  })

  const placed = sum([
    ...doctor.map(line => line.placed),
    ...summaryLines.map(line => line.placed),
    ...shown.flatMap(log => log.lines.map(line => line.placed)),
  ])
  return `${[
    table(values, placed),
    ...(note === undefined ? [] : [note]),
    version,
    doctorSection,
    head,
    ...shown.map(log => log.section),
  ].join('\n\n')}\n`
}

/** Host facts the report needs, passed in rather than read from the environment. */
export interface Host {
  readonly home: string | undefined
  readonly hostName: string
  readonly user: string | undefined
}

export interface Request {
  /** Where the command ran, which a record is looked for above. */
  readonly cwd: string
  readonly doctor: string
  readonly host: Host
  /** A boot id, or a boot record's directory; the latest launch's when `undefined`. */
  readonly record: string | undefined
  readonly revision: string | undefined
  readonly version: string
}

/** A boot id names a directory under the logs; anything with a slash in it is a directory. */
const isDirectory = (record: string): boolean =>
  record.includes('/') || record === '.' || record === '..'

/**
 * The boot record a request names, and the project it is in. A directory is in
 * the project above it; a boot id, or none, in the one above where the command
 * ran. With nothing named, a missing record is reported rather than refused,
 * since the version and `doctor` are worth having without one.
 */
const locate = Effect.fnUntraced(function* (request: Request) {
  const fs = yield* FileSystem.FileSystem
  if (request.record !== undefined && isDirectory(request.record)) {
    const dir = path.resolve(request.cwd, request.record)
    return { dir, project: yield* Project.find(dir) }
  }
  const found = yield* Project.find(request.cwd).pipe(Effect.result)
  if (found._tag === 'Failure') {
    if (request.record !== undefined) return yield* found.failure
    return { missing: found.failure.message, project: undefined }
  }
  const project = found.success
  const dir = path.join(project.logDir, request.record ?? BootLog.LATEST)
  if (!(yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false)))) {
    if (request.record !== undefined) {
      return yield* new ReportError({
        message: `no boot record ${request.record} in ${project.logDir}`,
      })
    }
    return { missing: 'this project has no launch on record', project }
  }
  return { dir, project }
})

const read = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem
  const unreadable = () => new ReportError({ message: `cannot read the boot record at ${dir}` })
  const real = yield* fs.realPath(dir).pipe(Effect.mapError(unreadable))
  const files: Array<{ readonly name: string; readonly text: string }> = []
  for (const name of yield* fs.readDirectory(real).pipe(Effect.mapError(unreadable))) {
    const file = path.join(real, name)
    const info = yield* fs.stat(file).pipe(Effect.option)
    if (Option.isNone(info) || info.value.type !== 'File') continue
    files.push({ name, text: yield* fs.readFileString(file).pipe(Effect.mapError(unreadable)) })
  }
  return { files, id: path.basename(real) } satisfies BootRecord
})

/** The report for `request`, as markdown. Reads the record and the home directory's real path. */
export const run = Effect.fn('Report.run')(function* (request: Request) {
  const fs = yield* FileSystem.FileSystem
  const given = request.host.home?.replace(/(.)\/+$/, '$1')
  const home =
    given === undefined || given === ''
      ? []
      : [given, yield* fs.realPath(given).pipe(Effect.orElseSucceed(() => given))]
  const found = yield* locate(request)
  return render({
    doctor: request.doctor,
    known: {
      home: [...new Set(home)],
      hostName: request.host.hostName,
      project:
        found.project === undefined
          ? undefined
          : { cid: found.project.cid, label: found.project.label, root: found.project.root },
      user: request.host.user,
    },
    record: 'dir' in found ? yield* read(found.dir) : found.missing,
    revision: request.revision,
    version: request.version,
  })
})
