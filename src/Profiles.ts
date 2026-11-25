/**
 * Broker profiles, as the CLI reads them: what a service's key may do, as
 * data the broker reads and never code it runs.
 *
 * A profile names the hosts a key goes to and how it is sent at each, the
 * variables the service's clients read a key from, named sets of rules, and
 * `deny` rules that hold whatever is chosen. Defining one grants nothing. A
 * credential grants it to a project by choosing sets and pinning the hosts
 * they reach, and the broker is sent those sets' rules alone (`grantOf`).
 *
 * Three places define them: igloo's own, read beneath the user layer from
 * the JSON its package carries; the user layer's, which may replace one of
 * igloo's; and a project's, for that project alone. Which may define what,
 * and who may grant which, is `Config.compose`'s.
 *
 * Read strictly: a field this file does not read is refused rather than
 * ignored, since it would be a limit someone wrote down that nothing
 * enforces. The checks on a host, a rule's path and methods, a placeholder
 * and how a key is sent are the broker's own, imported, so a profile read
 * here is one the broker reads.
 */

import { Effect, FileSystem, Predicate, Result, Schema } from 'effect'

import {
  type ChosenRule,
  type PathRule,
  type ProfileGrant,
  type ProfileHost,
  type Repository,
  type Rule,
  isHostname,
  isPlaceholderName,
  isProfileNameForm,
  isSend,
  namesRepo,
  repoSegment,
  rulePathProblem,
  ruleMethods,
  sendProblem,
} from './broker.ts'

export class ProfilesError extends Schema.TaggedError<ProfilesError>()('ProfilesError', {
  message: Schema.String,
}) {}

/** A service, as a profile describes it. */
export interface Profile {
  /** Set name, then host, then the rules the set holds there. */
  readonly allow: Readonly<Record<string, Readonly<Record<string, readonly Rule[]>>>>
  /** Host, then the rules that refuse whatever is chosen. */
  readonly deny: Readonly<Record<string, readonly PathRule[]>>
  /** Host, then how the key is sent there and the host's options. */
  readonly hosts: Readonly<Record<string, Host>>
  /** The variables the guest holds the placeholder in, for a project granted this profile. */
  readonly placeholders: readonly string[]
  /** What a repository is in its paths, for a profile whose grants list them. */
  readonly repository?: Repository
}

/** One of a profile's hosts: how the key is sent there, and the options a forge's API needs. */
export type Host = Omit<ProfileHost, 'allow' | 'deny'>

/** The fields a profile has. Any other is refused. */
const profileFields = new Set(['allow', 'deny', 'hosts', 'placeholders', 'repository'])

/** An attribute set, and not a list. */
const asRecord = (raw: unknown): Record<string, unknown> | undefined =>
  Predicate.isObject(raw) ? raw : undefined

const methodsText = [...ruleMethods].map(method => `"${method}"`).join(', ')

/**
 * A rule as a profile writes it, in the form the broker reads: `method` a list
 * or `"*"`. `allowed` for a rule in a set, which may carry a reader or name a
 * repository; `slotted` for a profile with a `repository`, the only kind whose
 * rules may name one.
 */
const readRule = (
  where: string,
  raw: unknown,
  allowed: boolean,
  slotted: boolean,
): Result.Result<Rule, string> => {
  const rule = asRecord(raw)
  if (rule === undefined) {
    return Result.fail(
      `${where}: a rule is an attribute set, as in \`{ method = "GET"; path = "v1/**"; }\`.`,
    )
  }
  if ('git' in rule) {
    if (!allowed) {
      return Result.fail(
        `${where}: \`git\` serves a repository a grant lists, so it has no place in a \`deny\` rule, which belongs to no set.`,
      )
    }
    const { git } = rule
    if (Object.keys(rule).length !== 1 || (git !== 'fetch' && git !== 'push')) {
      return Result.fail(
        `${where}: a git rule is \`{ git = "fetch"; }\` or \`{ git = "push"; }\` alone: git's reader fixes its methods and paths.`,
      )
    }
    if (!slotted) {
      return Result.fail(
        `${where}: \`{ git = "${git}"; }\` serves a repository, and the profile says of none what one is. Set \`repository = { segments = 2; ignoreCase = true; };\`, as a forge whose repositories are \`owner/repo\` would.`,
      )
    }
    return Result.succeed({ git })
  }
  for (const key of Object.keys(rule)) {
    if (key === 'method' || key === 'path') continue
    if ((key === 'graphql' || key === 'length') && allowed) continue
    return Result.fail(
      key === 'graphql' || key === 'length'
        ? `${where}: \`${key}\` ${key === 'graphql' ? 'reads a body' : 'sends a body'} a set allows, so it has no place in a \`deny\` rule, which refuses whatever it matches.`
        : `${where}: \`${key}\` is not a rule's field. A rule takes \`method\` and \`path\`${allowed ? ', `graphql` for a GraphQL request, `length = "kept"` for an upload, or `git` alone' : ''}.`,
    )
  }
  const { graphql, length, method, path } = rule
  if (typeof path !== 'string') {
    return Result.fail(
      `${where}: a rule's \`path\` is a string of segments, as in "v2/pods/*", or "" for the host's root.`,
    )
  }
  const problem = rulePathProblem(path)
  if (problem !== undefined) {
    return Result.fail(
      `${where}: ${problem}. A path is segments, where \`*\` is any one and a last \`**\` any number of them${slotted && allowed ? ', and `{repo}` a repository' : ''}.`,
    )
  }
  if (path.split('/').includes(repoSegment)) {
    if (!allowed) {
      return Result.fail(
        `${where}: ${JSON.stringify(path)} names \`{repo}\`, a repository a grant lists for a set, and a \`deny\` rule belongs to no set. Name a repository by its segments, as "repos/*/*/…", to refuse it for every one.`,
      )
    }
    if (!slotted) {
      return Result.fail(
        `${where}: ${JSON.stringify(path)} names \`{repo}\`, and the profile says of none what one is. Set \`repository = { segments = 2; ignoreCase = true; };\`, as a forge whose repositories are \`owner/repo\` would.`,
      )
    }
  }
  const listed = method === '*' ? '*' : typeof method === 'string' ? [method] : method
  if (
    listed !== '*' &&
    (!Array.isArray(listed) ||
      listed.length === 0 ||
      !listed.every(each => typeof each === 'string' && ruleMethods.has(each)))
  ) {
    return Result.fail(
      `${where}: \`method\` at ${JSON.stringify(path)} is ${JSON.stringify(method)}. Write one of ${methodsText}, a list of them, or "*" for any.`,
    )
  }
  const methods: PathRule['method'] =
    listed === '*' ? '*' : [...new Set(listed as readonly string[])]
  if (length !== undefined && length !== 'kept') {
    return Result.fail(
      `${where}: \`length\` at ${JSON.stringify(path)} is "kept", which sends a body with the length the guest stated, for a service that takes an upload only with one.`,
    )
  }
  const kept = length === undefined ? {} : { length: 'kept' as const }
  if (graphql === undefined) return Result.succeed({ ...kept, method: methods, path })
  if (length !== undefined) {
    return Result.fail(
      `${where}: the GraphQL rule at ${JSON.stringify(path)} sends the body the broker wrote for it, so it takes no \`length\`.`,
    )
  }
  const reader = asRecord(graphql)
  const withheld = reader?.['withheld'] ?? []
  if (
    reader === undefined ||
    Object.keys(reader).some(key => key !== 'withheld') ||
    !Array.isArray(withheld) ||
    !withheld.every(name => typeof name === 'string' && /^[_A-Za-z][_0-9A-Za-z]*$/.test(name))
  ) {
    return Result.fail(
      `${where}: \`graphql\` at ${JSON.stringify(path)} is \`{ withheld = [ … ]; }\`, the fields no query may name, each a GraphQL name.`,
    )
  }
  if (methods === '*' || methods.length !== 1 || methods[0] !== 'POST') {
    return Result.fail(
      `${where}: the GraphQL rule at ${JSON.stringify(path)} reads a request's body, so its \`method\` is "POST" alone.`,
    )
  }
  return Result.succeed({
    graphql: { withheld: withheld as readonly string[] },
    method: methods,
    path,
  })
}

/** A list of rules at one host, each read as `readRule` reads it. */
const readRules = (
  where: string,
  raw: unknown,
  allowed: boolean,
  slotted: boolean,
): Result.Result<readonly Rule[], string> =>
  Result.gen(function* () {
    if (!Array.isArray(raw) || raw.length === 0) {
      return yield* Result.fail(
        `${where} is a non-empty list of rules, as in \`[ { method = "GET"; path = "v1/**"; } ]\`.`,
      )
    }
    const rules: Array<Rule> = []
    for (const each of raw as readonly unknown[]) {
      rules.push(yield* readRule(where, each, allowed, slotted))
    }
    return rules
  })

/** One profile, as `name` in `where`, the file that defines it. */
const readProfile = (where: string, name: string, raw: unknown): Result.Result<Profile, string> =>
  Result.gen(function* () {
    const setting = `profiles.${name}`
    const entry = asRecord(raw)
    if (entry === undefined) {
      return yield* Result.fail(`${where}: \`${setting}\` must be an attribute set.`)
    }
    for (const key of Object.keys(entry)) {
      if (profileFields.has(key)) continue
      return yield* Result.fail(
        `${where}: \`${setting}.${key}\` is not a profile's field. A profile takes \`hosts\`, \`placeholders\`, \`repository\`, \`allow\` and \`deny\`.`,
      )
    }

    let repository: Repository | undefined
    if (entry['repository'] !== undefined) {
      const shape = asRecord(entry['repository'])
      const segments = shape?.['segments']
      const ignoreCase = shape?.['ignoreCase']
      if (
        shape === undefined ||
        Object.keys(shape).some(key => key !== 'segments' && key !== 'ignoreCase') ||
        typeof segments !== 'number' ||
        !Number.isInteger(segments) ||
        segments < 1 ||
        segments > 20 ||
        typeof ignoreCase !== 'boolean'
      ) {
        return yield* Result.fail(
          `${where}: \`${setting}.repository\` says what a repository is in the profile's paths: \`{ segments = 2; ignoreCase = true; }\` for one named \`owner/repo\`, compared ignoring case. \`segments\` is a whole number from 1 to 20, and \`ignoreCase\` true or false.`,
        )
      }
      repository = { ignoreCase, segments }
    }
    const slotted = repository !== undefined

    const hostsRaw = asRecord(entry['hosts'])
    if (hostsRaw === undefined || Object.keys(hostsRaw).length === 0) {
      return yield* Result.fail(
        `${where}: \`${setting}.hosts\` names the hosts its key is sent to, each with how it is sent, as in \`hosts."api.example.com".send = "bearer";\`.`,
      )
    }
    const hosts: Record<string, Host> = {}
    for (const [written, value] of Object.entries(hostsRaw)) {
      const host = written.toLowerCase()
      const at = `${setting}.hosts."${written}"`
      if (!isHostname(host) || !host.includes('.')) {
        return yield* Result.fail(
          `${where}: \`${at}\` is not a host. Write a name with a dot, as in "api.example.com": no scheme, no port and no address, since the key goes to that name over HTTPS on 443.`,
        )
      }
      if (Object.hasOwn(hosts, host)) {
        return yield* Result.fail(`${where}: \`${setting}.hosts\` names ${host} twice.`)
      }
      const options = asRecord(value)
      if (options === undefined || !('send' in options)) {
        return yield* Result.fail(
          `${where}: \`${at}\` says how the key is sent there: \`send = "bearer";\`, \`send.header = "<name>";\` or \`send.basic = "<username>";\`.`,
        )
      }
      for (const key of Object.keys(options)) {
        if (key === 'send' || key === 'redirects' || key === 'pages') continue
        return yield* Result.fail(
          `${where}: \`${at}.${key}\` is not a host's field. A host takes \`send\`, and \`redirects\` and \`pages\` for a forge's API.`,
        )
      }
      const { pages, redirects, send } = options
      if (!isSend(send)) {
        return yield* Result.fail(`${where}: \`${at}\`: ${sendProblem(send) ?? ''}.`)
      }
      if (redirects !== undefined && redirects !== 'return') {
        return yield* Result.fail(
          `${where}: \`${at}.redirects\` is "return", which passes the host's redirects back to the guest unfollowed, for a signed URL that needs no credential. Leave it out to refuse them.`,
        )
      }
      if (pages !== undefined && pages !== 'github') {
        return yield* Result.fail(
          `${where}: \`${at}.pages\` is "github", GitHub's page links put back under the repository a request named. Leave it out for any other service.`,
        )
      }
      if (pages !== undefined && !slotted) {
        return yield* Result.fail(
          `${where}: \`${at}.pages\` puts a page link back under the repository a request named, and the profile says of none what one is. Set \`${setting}.repository\`, or leave \`pages\` out.`,
        )
      }
      hosts[host] = {
        ...(pages === undefined ? {} : { pages }),
        ...(redirects === undefined ? {} : { redirects }),
        send,
      }
    }
    const named = (at: string, written: string): Result.Result<string, string> => {
      const host = written.toLowerCase()
      return Object.hasOwn(hosts, host)
        ? Result.succeed(host)
        : Result.fail(
            `${where}: \`${at}\` is at ${written}, which is not in \`${setting}.hosts\`. A rule is at one of the profile's own hosts.`,
          )
    }

    const placeholdersRaw = entry['placeholders'] ?? []
    if (
      !Array.isArray(placeholdersRaw) ||
      !placeholdersRaw.every(each => typeof each === 'string')
    ) {
      return yield* Result.fail(
        `${where}: \`${setting}.placeholders\` is a list of variable names, as in \`[ "EXAMPLE_API_KEY" ]\`.`,
      )
    }
    for (const variable of placeholdersRaw as readonly string[]) {
      if (isPlaceholderName(variable)) continue
      return yield* Result.fail(
        `${where}: \`${variable}\` in \`${setting}.placeholders\` is not a key's variable. Each is set in the guest to a placeholder for the key, so it is named as one: capitals, digits and \`_\`, ending in \`_API_KEY\`, \`_KEY\` or \`_TOKEN\`.`,
      )
    }

    const allowRaw = asRecord(entry['allow'])
    if (allowRaw === undefined || Object.keys(allowRaw).length === 0) {
      return yield* Result.fail(
        `${where}: \`${setting}.allow\` names the sets of what the key may do, at least one, as in \`allow.read."api.example.com" = [ { method = "GET"; path = "v1/**"; } ];\`. A credential grants the profile by choosing some of them.`,
      )
    }
    const allow: Record<string, Record<string, readonly Rule[]>> = {}
    for (const [set, byHost] of Object.entries(allowRaw)) {
      const at = `${setting}.allow.${set}`
      if (!isProfileNameForm(set)) {
        return yield* Result.fail(
          `${where}: \`${set}\` is not a usable set name. Use lowercase letters, digits and \`-\`, starting with a letter or digit.`,
        )
      }
      const hostsOfSet = asRecord(byHost)
      if (hostsOfSet === undefined || Object.keys(hostsOfSet).length === 0) {
        return yield* Result.fail(
          `${where}: \`${at}\` is empty, so choosing it would allow nothing. Give it rules at one of the profile's hosts, or delete it.`,
        )
      }
      const rules: Record<string, readonly Rule[]> = {}
      for (const [written, list] of Object.entries(hostsOfSet)) {
        const host = yield* named(at, written)
        rules[host] = yield* readRules(`${where}: \`${at}."${written}"\``, list, true, slotted)
      }
      allow[set] = rules
    }

    const denyRaw = entry['deny'] === undefined ? {} : asRecord(entry['deny'])
    if (denyRaw === undefined) {
      return yield* Result.fail(
        `${where}: \`${setting}.deny\` is rules by host, as in \`deny."api.example.com" = [ … ];\`.`,
      )
    }
    const deny: Record<string, readonly PathRule[]> = {}
    for (const [written, list] of Object.entries(denyRaw)) {
      const host = yield* named(`${setting}.deny`, written)
      const rules = yield* readRules(
        `${where}: \`${setting}.deny."${written}"\``,
        list,
        false,
        slotted,
      )
      deny[host] = rules.filter((rule): rule is PathRule => 'path' in rule)
    }

    return {
      allow,
      deny,
      hosts,
      placeholders: placeholdersRaw,
      ...(repository === undefined ? {} : { repository }),
    }
  })

/**
 * One layer's `profiles`, by name. `where` is the file that holds them, for
 * a message.
 */
export const read = (
  where: string,
  raw: unknown,
): Result.Result<ReadonlyMap<string, Profile>, string> =>
  Result.gen(function* () {
    const entries = asRecord(raw)
    if (entries === undefined) {
      return yield* Result.fail(
        `${where}: \`profiles\` defines broker profiles by name, so it is an attribute set — \`profiles.NAME = { hosts = …; allow = …; };\`.`,
      )
    }
    const profiles = new Map<string, Profile>()
    for (const [name, entry] of Object.entries(entries)) {
      if (!isProfileNameForm(name)) {
        return yield* Result.fail(
          `${where}: \`${name}\` is not a usable profile name. Use lowercase letters, digits and \`-\`, starting with a letter or digit.`,
        )
      }
      if (name === 'model-server') {
        return yield* Result.fail(
          `${where}: \`profiles.${name}\` takes the name the broker gives a model server’s grant. Name the profile something else.`,
        )
      }
      profiles.set(name, yield* readProfile(where, name, entry))
    }
    return profiles
  })

/** The hosts `sets` of `profile` reach, each once. */
export const reached = (profile: Profile, sets: readonly string[]): readonly string[] => [
  ...new Set(sets.flatMap(set => Object.keys(profile.allow[set] ?? {}))),
]

/**
 * What the broker is granted for a credential choosing `sets` of the profile
 * `name` for the whole account, and `repos`' sets for each repository it
 * lists: each host the sets chosen reach, how the key is sent there and the
 * host's options, the chosen sets' rules there, each under its set's name, and
 * the `deny` rules there; and, for a profile with a repository, what one is
 * and the repositories listed. A set not chosen never reaches the broker, and
 * nor does a host no chosen set reaches.
 */
export const grantOf = (
  name: string,
  profile: Profile,
  sets: readonly string[],
  repos: Readonly<Record<string, readonly string[]>> = {},
): Omit<ProfileGrant, 'credential'> => {
  const chosen = [...new Set([...sets, ...Object.values(repos).flat()])]
  const reaches = reached(profile, chosen)
  return {
    hosts: Object.fromEntries(
      Object.entries(profile.hosts)
        .filter(([host]) => reaches.includes(host))
        .map(([host, options]) => [
          host,
          {
            ...options,
            allow: chosen.flatMap(set =>
              (profile.allow[set]?.[host] ?? []).map((rule): ChosenRule => ({ ...rule, set })),
            ),
            deny: profile.deny[host] ?? [],
          },
        ]),
    ),
    profile: name,
    ...(profile.repository === undefined ? {} : { repos, repository: profile.repository }),
  }
}

/** The sets of `profile` with a rule naming a repository, which a grant chooses per repository. */
export const repoSets = (profile: Profile): readonly string[] =>
  Object.entries(profile.allow)
    .filter(([, byHost]) => Object.values(byHost).some(rules => rules.some(namesRepo)))
    .map(([set]) => set)

/** Every host of every profile in `profiles`, each once. */
export const hostsOf = (profiles: ReadonlyMap<string, Profile>): readonly string[] => [
  ...new Set([...profiles.values()].flatMap(profile => Object.keys(profile.hosts))),
]

/**
 * The profiles igloo ships, from the JSON its package carries at `file`:
 * `IGLOO_PROFILES`, which the package's wrapper and the devshell set.
 */
export const shipped = Effect.fn('Profiles.shipped')(function* (file: string | undefined) {
  if (file === undefined || file === '') {
    return yield* new ProfilesError({
      message:
        'IGLOO_PROFILES is not set, so the broker profiles igloo ships cannot be read. Run the `igloo` its package installs, or run a checkout from `nix develop`, which set it.',
    })
  }
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs
    .readFileString(file)
    .pipe(
      Effect.mapError(
        () => new ProfilesError({ message: `cannot read igloo's broker profiles at ${file}` }),
      ),
    )
  const raw = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(() => new ProfilesError({ message: `${file} is not JSON` })),
  )
  return yield* Result.match(read(file, raw), {
    onFailure: message => Effect.fail(new ProfilesError({ message })),
    onSuccess: Effect.succeed,
  })
})
