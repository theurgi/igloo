/**
 * `igloo profile check`: what a profile's sets allow at a service, read
 * against the operations the service's spec names.
 *
 * Every answer is the broker's own. Each operation's path, its slots filled
 * with a sample value (`sample/sample` for one that may hold a `/`, and a
 * repository's as the sample grant lists it), is sent through
 * `decideAddressed` with a grant, and what it decides is read: a grant of one
 * set for what that set allows, of every set for what nothing allows, of one
 * rule for whether that rule matches anything, and of everything less the
 * profile's `deny` for what `deny` refuses. So the check and the broker
 * cannot disagree about what a rule matches.
 *
 * A review tool: neither the broker nor a launch reads a spec.
 */

import { Effect, FileSystem, Predicate, Result, Schema } from 'effect'
import { createHash } from 'node:crypto'
import * as path from 'node:path'

import {
  type ChosenRule,
  type PathRule,
  type ProfileGrant,
  type Rule,
  decideAddressed,
  repoSegment,
  ruleText,
} from './broker.ts'
import * as Profiles from './Profiles.ts'
import { type Index, type Operation, covers, indexOf, readIndex, segmentsOf } from './SpecIndex.ts'

export class ProfileCheckError extends Schema.TaggedError<ProfileCheckError>()(
  'ProfileCheckError',
  { message: Schema.String },
) {}

/** What a reviewer states beside a profile, which the profile itself never holds. */
export interface Review {
  /** Set, then the groups it is meant to reach. A set not named is not held to any. */
  readonly groups?: Readonly<Record<string, readonly string[]>>
  /**
   * Host, then the writes nothing allows or denies there, as `METHOD path`,
   * read and left so. One missing or one too many is a failure.
   */
  readonly unallowed?: Readonly<Record<string, readonly string[]>>
}

/**
 * What a host comes to with every set chosen: anything (a `"*"` method at
 * `**`), anything but what `deny` refuses, or what its rules list.
 */
export type Level = 'allow-list' | 'host' | 'host-less-deny'

/**
 * An operation a set allows, and for one with a slot that may hold a `/`,
 * where only one form is allowed, which: `one-segment` where that slot is
 * one segment, `slashed` where it holds a `/`.
 */
export interface Allowed {
  readonly only?: 'one-segment' | 'slashed'
  readonly operation: Operation
}

export interface SetReport {
  /** The operations this set alone allows here, in either form. */
  readonly allowed: readonly Allowed[]
  /** Its rules here whose paths the indexes do not cover, as text. */
  readonly outside: readonly string[]
  readonly set: string
  /** Its rules here that match no operation, as text. */
  readonly unmatched: readonly string[]
}

export interface HostReport {
  /** Whether an index describes the host. One that none does is unchecked, not failed. */
  readonly checked: boolean
  /** The `deny` rules here whose paths the indexes do not cover. */
  readonly denyOutside: readonly string[]
  /** The `deny` rules here that match no operation. */
  readonly denyUnmatched: readonly string[]
  readonly host: string
  readonly level: Level
  /** Every set with a rule here, in the profile's order. */
  readonly sets: readonly SetReport[]
  /** The writes no set allows and `deny` does not refuse. */
  readonly unallowed: readonly Operation[]
}

export interface Report {
  /** What failed, each a sentence; empty for a profile that passes. */
  readonly failures: readonly string[]
  readonly hosts: readonly HostReport[]
  readonly name: string
  readonly sources: readonly { readonly sha256: string; readonly source: string }[]
}

const sample = 'sample'

/** An operation as a reader finds it: `METHOD path`, which is how `unallowed` names it. */
export const operationText = (operation: Operation): string =>
  `${operation.method} ${operation.path === '' ? '/' : operation.path}`

/**
 * The paths the broker is asked about for `operation`: its slots filled with
 * a sample segment, and for one with a slot that may hold a `/`, again with
 * that slot holding one.
 */
const sampledPaths = (operation: Operation): readonly string[] => {
  const filled = (multi: boolean) =>
    operation.path.replace(/\{([^}]*)\}/g, (_, slot: string) =>
      multi && operation.multiSegment.includes(slot) ? `${sample}/${sample}` : sample,
    )
  return operation.multiSegment.length === 0 ? [filled(false)] : [filled(false), filled(true)]
}

/** Whether `method` changes something: anything but a read, as the broker counts one. */
const isWrite = (method: string): boolean => method !== 'GET' && method !== 'HEAD'

/** The rules a profile holds at `host` for `set`. */
const rulesAt = (profile: Profiles.Profile, set: string, host: string): readonly Rule[] =>
  profile.allow[set]?.[host] ?? []

/**
 * Check `profile`, named `name`, against `indexes`, and hold it to `review`.
 * Pure: the report says what failed and the caller decides what to do.
 */
export const check = (
  name: string,
  profile: Profiles.Profile,
  indexes: readonly Index[],
  review: Review = {},
): Report => {
  const sets = Object.keys(profile.allow)
  const repo =
    profile.repository === undefined
      ? undefined
      : Array.from({ length: profile.repository.segments }, () => sample).join('/')
  // The repository every grant here lists, for every set, so that a rule
  // naming `{repo}` applies wherever its set is chosen.
  const repos = repo === undefined ? {} : { [repo]: sets }
  const repoFields =
    profile.repository === undefined ? {} : { repos, repository: profile.repository }

  const ofSets = (chosen: readonly string[]): ProfileGrant => ({
    credential: 'check',
    ...Profiles.grantOf(name, profile, chosen, repo === undefined ? {} : { [repo]: chosen }),
  })
  const atHost = (host: string, allow: readonly ChosenRule[], deny: readonly PathRule[]) => {
    const options = profile.hosts[host]
    const grant: ProfileGrant = {
      credential: 'check',
      hosts: options === undefined ? {} : { [host]: { ...options, allow, deny } },
      profile: name,
      ...repoFields,
    }
    return grant
  }
  /** Whether the broker, holding `grant`, allows each form of `operation`. */
  const decided = (grant: ProfileGrant, operation: Operation): readonly boolean[] =>
    sampledPaths(operation).map(
      sampled =>
        decideAddressed([grant], operation.method, `https://${operation.host}/${sampled}`)._tag ===
        'Profile',
    )
  const anyAllowed = (grant: ProfileGrant, operation: Operation): boolean =>
    decided(grant, operation).includes(true)
  const anyRefused = (grant: ProfileGrant, operation: Operation): boolean =>
    decided(grant, operation).includes(false)

  const operations = indexes.flatMap(index => index.operations)
  const everySet = ofSets(sets)
  const failures: string[] = []

  const hosts = Object.keys(profile.hosts).map((host): HostReport => {
    const here = operations.filter(operation => operation.host === host)
    const describing = indexes.filter(index => index.operations.some(each => each.host === host))
    const checked = describing.length > 0
    // Whether an index here kept the part of the spec `rule` is in, judged by
    // a path it matches: each `*` a sample, `{repo}` the sample repository,
    // and a last `**` nothing.
    const covered = (rule: Rule): boolean => {
      if ('git' in rule) return false
      const written = segmentsOf(rule.path)
      const open = written.at(-1) === '**'
      const asked = (open ? written.slice(0, -1) : written).flatMap(segment =>
        segment === repoSegment
          ? (repo ?? sample).split('/')
          : [segment === '*' ? sample : segment],
      )
      return describing.some(
        index => index.paths === undefined || index.paths.some(each => covers(each, asked)),
      )
    }

    const deny = profile.deny[host] ?? []
    const denyUnmatched: string[] = []
    const denyOutside: string[] = []
    const anything: ChosenRule = { method: '*', path: '**', set: '' }
    for (const rule of checked ? deny : []) {
      if (!covered(rule)) {
        denyOutside.push(ruleText(rule))
        continue
      }
      const alone = atHost(host, [anything], [rule])
      if (here.some(operation => anyRefused(alone, operation))) continue
      denyUnmatched.push(ruleText(rule))
      failures.push(`${host}: the deny rule ${ruleText(rule)} matches no operation`)
    }
    const denies = atHost(host, [anything], deny)

    const setReports = sets.flatMap((set): readonly SetReport[] => {
      const rules = rulesAt(profile, set, host)
      if (rules.length === 0) return []
      const unmatched: string[] = []
      const outside: string[] = []
      for (const rule of checked ? rules : []) {
        if (!covered(rule)) {
          outside.push(ruleText(rule))
          continue
        }
        const alone = atHost(host, [{ ...rule, set }], [])
        if (here.some(operation => anyAllowed(alone, operation))) continue
        unmatched.push(ruleText(rule))
        failures.push(`${set} at ${host}: ${ruleText(rule)} matches no operation`)
      }
      const grant = ofSets([set])
      const allowed = here.flatMap((operation): readonly Allowed[] => {
        const [one, slashed] = decided(grant, operation)
        if (one !== true && slashed !== true) return []
        if (slashed === undefined || one === slashed) return [{ operation }]
        return [{ only: one === true ? 'one-segment' : 'slashed', operation }]
      })
      const meant = review.groups?.[set]
      for (const { operation } of meant === undefined ? [] : allowed) {
        if (meant?.includes(operation.group) === true) continue
        failures.push(
          `${set} at ${host} allows ${operation.operationId} (${operationText(operation)}), in ${operation.group}, which is not among its groups: ${meant?.join(', ') ?? ''}`,
        )
      }
      return [{ allowed, outside, set, unmatched }]
    })

    const unallowed = here.filter(
      operation =>
        isWrite(operation.method) &&
        !anyAllowed(everySet, operation) &&
        !anyRefused(denies, operation),
    )
    const listed = review.unallowed?.[host]
    if (review.unallowed !== undefined && checked) {
      const found = unallowed.map(operationText)
      for (const operation of unallowed) {
        if (listed?.includes(operationText(operation)) === true) continue
        failures.push(
          `${host}: ${operation.operationId} (${operationText(operation)}), in ${operation.group}, is a write nothing allows or denies, which the unallowed list does not name. Read it, then allow it in a set, refuse it in \`deny\`, or add it to the list.`,
        )
      }
      for (const entry of listed ?? []) {
        if (found.includes(entry)) continue
        failures.push(
          `${host}: the unallowed list names ${entry}, which is not a write nothing allows or denies. Take it out.`,
        )
      }
    }

    const all = everySet.hosts[host]?.allow ?? []
    const open = all.some(rule => 'path' in rule && rule.method === '*' && rule.path === '**')
    const level: Level = !open ? 'allow-list' : deny.length > 0 ? 'host-less-deny' : 'host'
    return { checked, denyOutside, denyUnmatched, host, level, sets: setReports, unallowed }
  })

  for (const set of Object.keys(review.groups ?? {})) {
    if (sets.includes(set)) continue
    failures.push(`the groups name ${set}, which is not one of ${name}'s sets`)
  }
  for (const host of Object.keys(review.unallowed ?? {})) {
    if (hosts.some(each => each.host === host && each.checked)) continue
    failures.push(
      `the unallowed list names ${host}, which is not a host of ${name} an index describes`,
    )
  }

  return {
    failures,
    hosts,
    name,
    sources: indexes.map(({ sha256, source }) => ({ sha256, source })),
  }
}

const levelText: Readonly<Record<Level, string>> = {
  'allow-list': 'an allow-list',
  host: 'the host alone: anything there',
  'host-less-deny': 'the host less a refusal list: anything there but what `deny` refuses',
}

const onlyText = (operation: Operation, only: Allowed['only']): string => {
  const slots = operation.multiSegment.map(slot => `{${slot}}`).join(' and ')
  return only === undefined
    ? ''
    : only === 'one-segment'
      ? `, only where ${slots} is one segment`
      : `, only where ${slots} holds a /`
}

/** `operations`, grouped, each group sorted, as lines indented by `indent`. */
const grouped = (operations: readonly Allowed[], indent: string): readonly string[] => {
  const groups = new Map<string, Allowed[]>()
  for (const each of operations) {
    const { group } = each.operation
    groups.set(group, [...(groups.get(group) ?? []), each])
  }
  return [...groups.keys()].toSorted().flatMap(group => {
    const members = groups.get(group) ?? []
    return [
      `${indent}${group} (${members.length}):`,
      ...members.map(
        ({ only, operation }) =>
          `${indent}  ${operationText(operation)}  ${operation.operationId}${onlyText(operation, only)}`,
      ),
    ]
  })
}

/** The report as text, for a reviewer: per host, per set, then the failures. */
export const render = (report: Report): string => {
  const lines: string[] = [`${report.name}, against:`]
  for (const { sha256, source } of report.sources) lines.push(`  ${source} (sha256 ${sha256})`)
  if (report.sources.length === 0) lines.push('  no spec')
  for (const host of report.hosts) {
    lines.push('', `${host.host}: ${levelText[host.level]}, with every set chosen`)
    if (!host.checked) {
      lines.push('  unchecked: no spec given describes this host')
      continue
    }
    for (const set of host.sets) {
      lines.push(
        set.allowed.length === 0
          ? `  ${set.set} allows no operation here`
          : `  ${set.set} allows ${set.allowed.length}:`,
        ...grouped(set.allowed, '    '),
        ...set.unmatched.map(rule => `    matching no operation: ${rule}`),
        ...set.outside.map(rule => `    unchecked, outside what the spec was indexed for: ${rule}`),
      )
    }
    lines.push(
      ...host.denyUnmatched.map(rule => `  deny, matching no operation: ${rule}`),
      ...host.denyOutside.map(
        rule => `  deny, unchecked, outside what the spec was indexed for: ${rule}`,
      ),
      host.unallowed.length === 0
        ? '  every write is allowed or denied'
        : `  writes nothing allows or denies (${host.unallowed.length}):`,
      ...grouped(
        host.unallowed.map(operation => ({ operation })),
        '    ',
      ),
    )
  }
  if (report.failures.length > 0) {
    lines.push('', 'Failed:', ...report.failures.map(failure => `  ${failure}`))
  }
  return `${lines.join('\n')}\n`
}

/** Whether `raw` is an object of lists of strings, as `--groups` and `--unallowed` take. */
export const isLists = (raw: unknown): raw is Readonly<Record<string, readonly string[]>> =>
  Predicate.isObject(raw) &&
  !Array.isArray(raw) &&
  Object.values(raw).every(
    list => Array.isArray(list) && list.every(each => typeof each === 'string'),
  )

/** The JSON in `file`, or a failure naming it. */
const readJson = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs
    .readFileString(file)
    .pipe(Effect.mapError(() => new ProfileCheckError({ message: `cannot read ${file}` })))
  return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(() => new ProfileCheckError({ message: `${file} is not JSON` })),
  )
})

/** The index of the spec in `file`, made as `scripts/spec-index.ts` makes one, of the whole spec. */
export const indexSpec = Effect.fn('ProfileCheck.indexSpec')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const bytes = yield* fs
    .readFile(file)
    .pipe(Effect.mapError(() => new ProfileCheckError({ message: `cannot read ${file}` })))
  const spec = yield* readJson(file)
  const made = indexOf(spec, {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    source: path.resolve(file),
  })
  if ('message' in made)
    return yield* new ProfileCheckError({ message: `${file}: ${made.message}` })
  return made.index
})

/** An index `scripts/spec-index.ts` wrote to `file`. */
export const loadIndex = Effect.fn('ProfileCheck.loadIndex')(function* (file: string) {
  const read = readIndex(yield* readJson(file))
  if ('message' in read)
    return yield* new ProfileCheckError({ message: `${file}: ${read.message}` })
  return read.index
})

/** A record of lists of strings in `file`, as `--groups` and `--unallowed` take, by `what` it holds. */
export const loadLists = Effect.fn('ProfileCheck.loadLists')(function* (
  file: string,
  what: string,
) {
  const raw = yield* readJson(file)
  if (!isLists(raw)) {
    return yield* new ProfileCheckError({
      message: `${file}: ${what} is an object of lists of strings, as in \`{ "pods": [ "Pods" ] }\``,
    })
  }
  return raw
})

/**
 * A profile as JSON in `file`, for one defined outside any layer: named for
 * the file, less `.json`.
 */
export const loadProfile = Effect.fn('ProfileCheck.loadProfile')(function* (file: string) {
  const raw = yield* readJson(file)
  const base = path.basename(file).replace(/\.json$/, '')
  const name = /^[a-z0-9][a-z0-9-]*$/.test(base) && base !== 'model-server' ? base : 'profile'
  return yield* Result.match(Profiles.read(file, { [name]: raw }), {
    onFailure: message => Effect.fail(new ProfileCheckError({ message })),
    onSuccess: read => {
      const profile = read.get(name)
      return profile === undefined
        ? Effect.fail(new ProfileCheckError({ message: `${file} holds no profile` }))
        : Effect.succeed({ name, profile })
    },
  })
})
