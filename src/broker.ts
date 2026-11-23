/**
 * The per-VM credential broker: one process, holding one project's credentials,
 * listening on a Unix socket that only its own VM can reach through a forward
 * the host opened.
 *
 * What it will do is a list of grants, passed as an argument. A broker with no
 * grants refuses everything, and that is a configuration rather than a stub: it
 * holds no upstream it is authorized to construct a request to.
 *
 * Code for protocols, data for services. A **profile** grant is a service as
 * data: the hosts its key goes to, how the key is sent at each, and the rules
 * of the sets a credential chose there, which this file reads and never runs
 * (`ProfileGrant`). `github` is still code of its own: it fetches and pushes
 * over git's smart HTTP protocol, and reads and writes through GitHub's API,
 * for a fixed set of repositories. Beside them, a `model-server` grant calls a
 * model server on this host's loopback, at a port the grant names. In each
 * case the upstream request is *constructed* — from the grant's own copy of
 * what it permits — so nothing a guest sends reaches the upstream URL, and the
 * credential header, where there is one, is always this file's. A git
 * request's other headers are built here too; any other request carries the
 * guest's, less its credentials and what describes its connection. That makes
 * absolute-form targets, a `Host` that disagrees with the URL and a colliding
 * `Authorization` into consequences of the shape rather than checks that could
 * be forgotten.
 *
 * A request is authorized by its path alone, and on the TLS listener by the name
 * it was addressed to as well, which stands where the path form puts the host;
 * a profile's hosts are answered by name alone. Its body is streamed upstream
 * as it arrives and never read: what a service does with it, the tools a
 * provider runs on a model's behalf included, is the service's. One body is
 * read: a GraphQL request at a rule with GraphQL's reader, where a query and a
 * mutation share a path, so only the body can say which it is
 * (`graphqlQuery`).
 *
 * Deliberately free of dependencies. It is packaged from this file alone, so its
 * closure is the runtime and nothing else, and a compromise reaches no library
 * this repository did not write. Every decision is pure and exported so it can
 * be asserted, and each listener is exported so it can be started on a socket
 * of a test's choosing; nothing runs on import.
 *
 * A credential value is never logged, never written, and never placed in an
 * error. Names are, because a name is what an operator needs to see.
 */

import { createSocket } from 'node:dgram'
import { lstatSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'

const usage =
  'usage: broker <socket-path> [--grants <json>] [--proxy <socket-path>] [--tunnel <json>] [--tls <socket-path>]'

/**
 * The profiles this file is the code of, and the upstream each reaches.
 *
 * The host is fixed by the profile rather than configured, so a grant cannot
 * name a destination: what a profile knows about an upstream — that it speaks
 * git's smart HTTP, that it takes a token in the username slot — is knowledge
 * about that one host, and pointing it somewhere else would carry the knowledge
 * without the host it was true of. A model server is the one upstream a grant
 * places, and it is placed no further than a port: see `ModelServerGrant`.
 *
 * A `git` profile fetches from the repositories a grant lists, and reads its
 * forge's API, at `api`, for them, and pushes to and writes through the API
 * for those in its `write`, uploading a release's assets at `uploads`.
 *
 * No grant limits a body's size. A body is streamed, so the broker holds
 * little of it at once however large it is, and the upstream's own limit is
 * the one that applies: a provider's refusal reaches the guest as the provider
 * gave it. A body that never ends is ended by `headerTimeoutMs`, or by an
 * upstream that answers before it has all of it. The one body read, a GraphQL
 * request's, is held whole, and so is held to `graphqlBodyLimit`.
 */
export const profiles = {
  github: { api: 'api.github.com', host: 'github.com', kind: 'git', uploads: 'uploads.github.com' },
} as const

export type ProfileName = keyof typeof profiles

export const isProfileName = (value: unknown): value is ProfileName =>
  typeof value === 'string' && Object.hasOwn(profiles, value)

/**
 * The names a git profile is answered at: its host, its API's, and the one its
 * API takes uploads at. A guest's client reaches each by its own name, through
 * the tunnel, which hands the connection to the broker's TLS listener rather
 * than to the host. A remote then reads as the repository's own URL, which is
 * how a client that reads remotes recognises one, and a URL the API gives in
 * an answer, a release's for its assets among them, leads back to the broker,
 * which is where a client that follows one goes.
 */
const answeredAt = (name: ProfileName): readonly string[] => {
  const profile = profiles[name]
  return [profile.host, profile.api, profile.uploads]
}

/**
 * Every name this file's own code may answer TLS for, whichever of them a
 * project's grants use. The certificate covers these and the hosts of every
 * profile igloo ships, so that granting one changes neither the certificate
 * nor the authority the guest is built trusting.
 */
export const tlsNamesCovered: readonly string[] = [
  ...new Set(Object.keys(profiles).filter(isProfileName).flatMap(answeredAt)),
]

/**
 * The names the broker's own code answers for a forge, which no profile may
 * name: a request is routed by the name it was addressed to.
 */
export const forgeNames: readonly string[] = answeredAt('github')

/**
 * Every git profile's API and the host it takes uploads at. Their clients
 * read an error's reason from the `message` of a JSON body, as the API writes
 * one, and show a response with none as its status alone.
 */
const apiNames: readonly string[] = Object.keys(profiles)
  .filter(isProfileName)
  .flatMap(name => [profiles[name].api, profiles[name].uploads])

/**
 * Fetch over git's smart HTTP, and read through the forge's API, for a fixed
 * set of repositories, and push to and write through the API those of them in
 * `write`. At most one per profile: a request to the API may name no
 * repository, so nothing in it could choose between two.
 *
 * `repos` and `write` are the broker's own copy of what is permitted. They are
 * compared against a request, never built from one.
 */
export interface GitGrant {
  /** The credential to inject, under the name systemd loaded it as. */
  readonly credential: string
  readonly profile: 'github'
  /** `owner/repo`, the repositories this grant may fetch and read, and no more. */
  readonly repos: readonly string[]
  /** `owner/repo`, the repositories it may push to and write through the API as well, each fetched and read as one in `repos` is. */
  readonly write?: readonly string[]
}

/**
 * Call a model server on this host's loopback, at the port the grant names.
 *
 * The one upstream a grant places, and it places no more than a port: the
 * address is always loopback, so a grant cannot send a request off this
 * machine, and the port comes from policy, which the guest cannot write. What
 * listens there is whatever the user runs, which is why the endpoints served
 * are only those every OpenAI-compatible server shares.
 *
 * `credential` is the key sent as a bearer token, absent for a server that
 * takes none. At most one per name: the name is what a request chooses by.
 */
export interface ModelServerGrant {
  readonly credential?: string
  /** What the guest calls it, in the path that reaches it, and what the log says. */
  readonly name: string
  readonly port: number
  readonly profile: 'model-server'
}

/**
 * How a profile's key is sent at one of its hosts: as `Authorization: Bearer`,
 * as the whole value of one named header, or as `Authorization: Basic` with a
 * fixed username. Never in a query or a path, which a server can echo into an
 * error or a log.
 */
export type Send = 'bearer' | { readonly basic: string } | { readonly header: string }

/**
 * What a rule matches: a request by one of `method`, `'*'` for any, at a path
 * in `apiWrites`' form, where `*` is any one segment, a last `**` any number
 * of them, none included, and `""` the host's root. Fixed segments are
 * compared as they are written, since services match them by case.
 *
 * `graphql` makes it a GraphQL request's rule: the body is read, and sent only
 * if it holds queries alone and names no field in `withheld` (`graphqlQuery`).
 */
export interface Rule {
  readonly graphql?: { readonly withheld: readonly string[] }
  readonly method: '*' | readonly string[]
  readonly path: string
}

/** A rule a grant allows, under the name of the set it was chosen as part of. */
export interface ChosenRule extends Rule {
  readonly set: string
}

/** One host of a profile grant: how its key is sent there, and the rules that hold there. */
export interface ProfileHost {
  readonly allow: readonly ChosenRule[]
  readonly deny: readonly Rule[]
  readonly send: Send
}

/**
 * A service's key, sent to the hosts a profile names under the rules of the
 * sets the grant chose. Data rather than code: the hosts, the way the key is
 * sent and every rule are the grant's own, written by whoever defined the
 * profile and pinned to those hosts by whoever holds the key.
 *
 * Only the sets a grant chose reach the broker, and only at the hosts they
 * reach, so a host no chosen rule names is not one of `hosts` and is not
 * answered. `deny` holds whatever is chosen. Answered by name alone, over the
 * TLS listener: there is no path form for a profile's host. At most one per
 * profile, and a host is one grant's: a request is routed by the name it was
 * addressed to.
 */
export interface ProfileGrant {
  readonly credential: string
  readonly hosts: Readonly<Record<string, ProfileHost>>
  readonly profile: string
}

export type Grant = GitGrant | ModelServerGrant | ProfileGrant

/** Anything whose fields can be read by name: a non-null object, an array included. */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const isProfileGrant = (grant: Grant): grant is ProfileGrant => 'hosts' in grant

export const isModelServerGrant = (grant: Grant): grant is ModelServerGrant =>
  grant.profile === 'model-server' && !isProfileGrant(grant)

export const isGitGrant = (grant: Grant): grant is GitGrant =>
  !isModelServerGrant(grant) && !isProfileGrant(grant)

/**
 * The names a broker holding `grants` answers TLS for: each git grant's, and
 * each host of a profile grant's, once.
 */
export const tlsNames = (grants: readonly Grant[]): readonly string[] => [
  ...new Set(
    grants.flatMap(grant =>
      isProfileGrant(grant)
        ? Object.keys(grant.hosts)
        : isGitGrant(grant)
          ? answeredAt(grant.profile)
          : [],
    ),
  ),
]

/**
 * The names whose clients read an error's reason from the `message` of a JSON
 * body: `apiNames`, and each host of a profile grant. A refusal the broker
 * writes for one of them is written that way.
 */
const jsonNames = (grants: readonly Grant[]): readonly string[] => [
  ...apiNames,
  ...grants.filter(isProfileGrant).flatMap(grant => Object.keys(grant.hosts)),
]

/**
 * What a profile may be called: lowercase letters, digits and `-`, as a
 * credential's `profile` names it and the log records it. A set is named the
 * same way.
 */
export const isProfileNameForm = (value: string): boolean => /^[a-z0-9][a-z0-9-]*$/.test(value)

/**
 * A variable a profile's clients read a key from, which the guest holds the
 * placeholder in: a name with the form of a key's, so that no profile can set
 * `PATH` or `LD_PRELOAD`.
 */
export const isPlaceholderName = (value: string): boolean =>
  /^[A-Z][A-Z0-9_]*_(?:KEY|TOKEN)$/.test(value)

/** The methods a rule may name. */
export const ruleMethods: ReadonlySet<string> = new Set([
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
])

/**
 * Headers the broker drops, sets or frames a request by, which a key sent as
 * a named header would collide with: each would be dropped before it was sent,
 * replaced by the broker's own, or read as describing the connection or the
 * body rather than as holding a key.
 */
const unsendableHeaders: ReadonlySet<string> = new Set([
  'accept-encoding',
  'connection',
  'content-encoding',
  'content-length',
  'content-type',
  'expect',
  'host',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** An HTTP header's name: a token, as RFC 9110 has it. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** The shapes `send` takes, for a message refusing one. */
const SEND_SHAPES = 'send is "bearer", { header = "<name>"; } or { basic = "<username>"; }'

/** Why `send` cannot send a key, or `undefined` if it can. */
export const sendProblem = (send: unknown): string | undefined => {
  if (send === 'bearer') return undefined
  if (!isObject(send) || Array.isArray(send)) return SEND_SHAPES
  const keys = Object.keys(send)
  const [only] = keys
  if (keys.length !== 1 || (only !== 'header' && only !== 'basic')) return SEND_SHAPES
  const value = send[only]
  if (only === 'header') {
    if (typeof value !== 'string' || !HEADER_NAME.test(value)) {
      return `${JSON.stringify(value)} is not a header's name`
    }
    if (unsendableHeaders.has(value.toLowerCase())) {
      return `${value} is a header the broker drops, sets or frames a request by, so it cannot carry a key`
    }
    return undefined
  }
  // A Basic username is everything before the first `:`.
  // oxlint-disable-next-line no-control-regex -- control characters are what it refuses.
  return typeof value === 'string' && /^[^:\u0000-\u001f\u007f]+$/.test(value)
    ? undefined
    : `${JSON.stringify(value)} is not a username: one with no ":" and no control characters`
}

/** Whether `send` is a way a key can be sent, as `sendProblem` reads it. */
export const isSend = (send: unknown): send is Send => sendProblem(send) === undefined

/** One fixed segment of a rule's path: what a URL's path may hold, less `%`. */
const RULE_SEGMENT = /^[A-Za-z0-9._~!$&'()+,;=:@-]+$/

/** Why `path` is not a rule's path, or `undefined` if it is. */
export const rulePathProblem = (path: string): string | undefined => {
  if (path === '') return undefined
  if (path.startsWith('/') || path.endsWith('/')) {
    return `${JSON.stringify(path)} is written with no leading or trailing /, and the host's root as ""`
  }
  const segments = path.split('/')
  for (const [at, segment] of segments.entries()) {
    if (segment === '') return `${JSON.stringify(path)} has an empty segment`
    if (segment === '**') {
      if (at === segments.length - 1) continue
      return `${JSON.stringify(path)} has ** before its last segment, the one place it means any number of segments`
    }
    if (segment === '*') continue
    if (segment.includes('*')) {
      return `${JSON.stringify(path)} has * inside a segment, where it is a segment of its own`
    }
    if (segment === '.' || segment === '..') {
      return `${JSON.stringify(path)} has a ${segment} segment, which no path it is matched against keeps`
    }
    if (!RULE_SEGMENT.test(segment)) {
      return `${JSON.stringify(path)} has ${JSON.stringify(segment)}, which no path it is matched against holds`
    }
  }
  return undefined
}

/** A GraphQL name, which `graphql.withheld` lists fields by. */
const GRAPHQL_FIELD = /^[_A-Za-z][_0-9A-Za-z]*$/

/**
 * A rule as the broker reads it, from its fields as the grant has them, or
 * why it is not one. `chosen` for an `allow` rule, which carries its set.
 */
const readRule = (
  raw: unknown,
  chosen: boolean,
): { readonly rule: ChosenRule | Rule } | { readonly message: string } => {
  if (!isObject(raw) || Array.isArray(raw)) return { message: 'a rule is an object' }
  const fields = new Set(chosen ? ['graphql', 'method', 'path', 'set'] : ['method', 'path'])
  const unread = Object.keys(raw).find(key => !fields.has(key))
  if (unread !== undefined) {
    return {
      message: `a${chosen ? 'n allow' : ' deny'} rule sets ${unread}, which this broker does not read`,
    }
  }
  const { graphql, method, path, set } = raw
  if (typeof path !== 'string') return { message: 'a rule has no path' }
  const problem = rulePathProblem(path)
  if (problem !== undefined) return { message: problem }
  let methods: Rule['method']
  if (method === '*') {
    methods = '*'
  } else if (
    Array.isArray(method) &&
    method.length > 0 &&
    method.every(each => typeof each === 'string' && ruleMethods.has(each))
  ) {
    methods = [...new Set(method as readonly string[])]
  } else {
    return {
      message: `${JSON.stringify(method)} at ${JSON.stringify(path)} is not "*" or a list of methods`,
    }
  }
  let reader: Rule['graphql']
  if (graphql !== undefined) {
    if (methods === '*' || methods.length !== 1 || methods[0] !== 'POST') {
      return { message: `the GraphQL rule at ${JSON.stringify(path)} is for POST alone` }
    }
    const withheld = isObject(graphql) ? graphql['withheld'] : undefined
    if (
      !isObject(graphql) ||
      Array.isArray(graphql) ||
      Object.keys(graphql).some(key => key !== 'withheld') ||
      !Array.isArray(withheld) ||
      !withheld.every(name => typeof name === 'string' && GRAPHQL_FIELD.test(name))
    ) {
      return {
        message: `the GraphQL rule at ${JSON.stringify(path)} takes withheld, a list of field names, and nothing else`,
      }
    }
    reader = { withheld: withheld as readonly string[] }
  }
  const rule = { ...(reader === undefined ? {} : { graphql: reader }), method: methods, path }
  if (!chosen) return { rule }
  if (typeof set !== 'string' || !isProfileNameForm(set)) {
    return { message: `the rule at ${JSON.stringify(path)} names no set it was chosen as part of` }
  }
  return { rule: { ...rule, set } }
}

/** The rules of one host of a profile grant, or why they are not rules. */
const readRules = (
  where: string,
  list: unknown,
  chosen: boolean,
): { readonly rules: readonly (ChosenRule | Rule)[] } | { readonly message: string } => {
  if (!Array.isArray(list)) return { message: `${where} lists no rules` }
  const rules: Array<ChosenRule | Rule> = []
  for (const each of list as unknown[]) {
    const read = readRule(each, chosen)
    if ('message' in read) return { message: `${where}: ${read.message}` }
    rules.push(read.rule)
  }
  return { rules }
}

/** A profile grant as the broker reads it, or why it is not one. */
const readProfileGrant = (
  entry: Record<string, unknown>,
): { readonly grant: ProfileGrant } | { readonly message: string } => {
  const { credential, hosts, profile } = entry
  // Not a name the broker's own code answers to.
  if (
    typeof profile !== 'string' ||
    !isProfileNameForm(profile) ||
    profile === 'model-server' ||
    (isProfileName(profile) && profiles[profile].kind === 'git')
  ) {
    return { message: `${JSON.stringify(profile)} is not a profile's name` }
  }
  const unread = Object.keys(entry).find(key => !['credential', 'hosts', 'profile'].includes(key))
  if (unread !== undefined) {
    return { message: `the ${profile} grant sets ${unread}, which this broker does not read` }
  }
  if (typeof credential !== 'string' || credential === '') {
    return { message: 'a grant needs a credential name' }
  }
  if (!isObject(hosts) || Array.isArray(hosts) || Object.keys(hosts).length === 0) {
    return { message: `the ${profile} grant reaches no host` }
  }
  const read: Record<string, ProfileHost> = {}
  for (const [host, raw] of Object.entries(hosts)) {
    // A name with a dot, in the form the TLS listener compares it in: never
    // an address, which the tunnel judges as one, and never a single label.
    if (!isHostname(host) || !host.includes('.')) {
      return {
        message: `${JSON.stringify(host)} in the ${profile} grant is not a lowercase hostname with a dot`,
      }
    }
    const where = `the ${profile} grant's ${host}`
    if (!isObject(raw) || Array.isArray(raw)) return { message: `${where} is not an object` }
    const field = Object.keys(raw).find(key => !['allow', 'deny', 'send'].includes(key))
    if (field !== undefined) {
      return { message: `${where} sets ${field}, which this broker does not read` }
    }
    const send = raw['send']
    if (!isSend(send)) return { message: `${where}: ${sendProblem(send) ?? ''}` }
    const allow = readRules(where, raw['allow'], true)
    if ('message' in allow) return allow
    if (allow.rules.length === 0) {
      return { message: `${where} allows nothing, so it is not one of the grant's hosts` }
    }
    const deny = readRules(where, raw['deny'], false)
    if ('message' in deny) return deny
    read[host] = {
      allow: allow.rules.filter((rule): rule is ChosenRule => 'set' in rule),
      deny: deny.rules,
      send,
    }
  }
  return { grant: { credential, hosts: read, profile } }
}

/**
 * The names the broker's TLS certificate and key are loaded under, beside the
 * credentials. Taken out of the credentials it serves before it serves any, so
 * no grant can send either upstream.
 */
export const tlsCertificateCredential = 'broker.tls-certificate'
export const tlsKeyCredential = 'broker.tls-key'

/**
 * What a model server may be called: lowercase letters, digits and `-`, as one
 * path segment that needs no encoding and reads the same in the log.
 */
export const isModelServerName = (value: string): boolean => /^[a-z0-9][a-z0-9-]*$/.test(value)

/** A TCP port: a whole number from 1 to 65535. */
export const isTcpPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535

/** The two requests git makes to fetch over HTTP: the ref advertisement, and the fetch. */
export type FetchOperation = 'fetch' | 'ls-refs'

/** Those, and the two it makes to push: the advertisement a push asks for, and the push. */
export type GitOperation = FetchOperation | 'push' | 'push-refs'

/** The endpoints of a model server a grant may reach. */
export type ModelServerOperation = 'chat-completions' | 'list-models' | 'responses' | 'systemone'

/**
 * A read on a name the broker answers that no grant covers: git's two fetch
 * requests, or anything else read with GET or HEAD.
 */
export type AnonymousOperation = FetchOperation | 'read'

/**
 * A request through a forge's API: a read or a write under a repository, an
 * upload of a release's asset, or a GraphQL query.
 */
export type ApiOperation = 'graphql' | 'read' | 'upload' | 'write'

export type Operation = AnonymousOperation | ApiOperation | GitOperation | ModelServerOperation

/**
 * Where a request is going, once it is known to be one this broker serves.
 *
 * Split by kind rather than carrying one `Allow` with optional fields, because
 * a git request is for one repository and a profile's names none, and the
 * headers each sends and returns are built differently. A model server's
 * request is built as a profile's is, and goes to a server the grant names,
 * with a credential only if the grant holds one. An anonymous one goes to the
 * host it was addressed to with no credential at all.
 */
export type Decision =
  | {
      readonly _tag: 'Git'
      readonly credential: string
      readonly host: string
      readonly operation: GitOperation
      readonly profile: GitGrant['profile']
      /** The repository as the *grant* spells it, not as the request did. */
      readonly repo: string
      readonly upstream: string
    }
  | {
      readonly _tag: 'ModelServer'
      readonly credential?: string
      /** `127.0.0.1:<port>`: where the request goes. */
      readonly host: string
      readonly operation: ModelServerOperation
      /** The server's name, as the grant spells it. */
      readonly server: string
      readonly upstream: string
    }
  | {
      readonly _tag: 'Api'
      readonly credential: string
      readonly host: string
      readonly operation: ApiOperation
      readonly profile: GitGrant['profile']
      /** The repository as the *grant* spells it, for a request under one. */
      readonly repo?: string
      readonly upstream: string
    }
  | {
      readonly _tag: 'Profile'
      readonly credential: string
      /** Set for a rule with GraphQL's reader: the body is read and checked before anything is sent. */
      readonly graphql?: { readonly withheld: readonly string[] }
      readonly host: string
      readonly profile: string
      /** The rule that allowed it, as text: its methods and its path. */
      readonly rule: string
      readonly send: Send
      /** Whether the request sends a body: anything but a GET or a HEAD. */
      readonly sendsBody: boolean
      /** The set the rule was chosen as part of. */
      readonly set: string
      readonly upstream: string
    }
  | {
      readonly _tag: 'Anonymous'
      /** A name the broker answers: where the request goes. */
      readonly host: string
      readonly operation: AnonymousOperation
      readonly upstream: string
    }
  | {
      readonly _tag: 'Deny'
      /**
       * What the request named that the reason repeats, under the field the
       * log gives it elsewhere, so that the log records it as a fact of its own
       * rather than only inside a sentence.
       */
      readonly asked?: Asked
      /** Set for a request addressed to one of `apiNames`, whose refusal is written in JSON. */
      readonly json?: true
      readonly reason: string
      readonly status: number
    }

/** A git host, a repository or a model server, as a request named it. */
interface Asked {
  readonly host?: string
  readonly scope?: string
  readonly server?: string
}

const deny = (status: number, reason: string, asked?: Asked): Decision => ({
  _tag: 'Deny',
  ...(asked === undefined ? {} : { asked }),
  reason,
  status,
})

/** `decision`, set to be written in JSON if it refuses a request addressed to one of `jsonNames`. */
const refusedAt = (grants: readonly Grant[], host: string, decision: Decision): Decision =>
  decision._tag === 'Deny' && jsonNames(grants).includes(host)
    ? { ...decision, json: true }
    : decision

/** `owner/repo`, with no path traversal and nothing that needs encoding. */
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Git protocol version, as git sends it. Forwarded rather than constructed
 * because it is a negotiation between the guest's git and the upstream, and
 * bounded by this pattern because it is the one request header that is the
 * guest's to choose.
 */
const GIT_PROTOCOL = /^version=[0-9]$/

/** `owner/repo.git` and `owner/repo` are the same repository to git and to GitHub. */
const withoutGit = (repo: string): string => (repo.endsWith('.git') ? repo.slice(0, -4) : repo)

/** Whether `repo` names a repository a grant may hold: `owner/repo`, with or without `.git`. */
export const isRepo = (repo: string): boolean => REPO.test(withoutGit(repo))

/**
 * The form two spellings of one repository are compared in. GitHub treats owner
 * and repository names case-insensitively, so a grant for `owner/repo` covers a
 * clone of `Owner/Repo` — but the *upstream* URL is built from the grant's
 * spelling, so this normalisation never decides what is requested.
 */
export const normaliseRepo = (repo: string): string => withoutGit(repo).toLowerCase()

/**
 * The repository in `among` that `wanted`, already normalised, names, as the
 * grant spells it.
 */
const grantedAs = (among: readonly string[] | undefined, wanted: string): string | undefined =>
  among?.find(candidate => normaliseRepo(candidate) === wanted)

/** The fields a grant of each kind carries. */
const grantFields = {
  git: new Set(['credential', 'profile', 'repos', 'write']),
  'model-server': new Set(['credential', 'name', 'port', 'profile']),
} as const

/** A git grant's list of repositories, or why it is not one. */
const repoList = (
  profile: string,
  field: string,
  value: unknown,
): Array<string> | { message: string } => {
  if (!Array.isArray(value)) return { message: `the ${profile} grant's ${field} is not a list` }
  const named: Array<string> = []
  for (const repo of value as unknown[]) {
    if (typeof repo !== 'string' || !isRepo(repo)) {
      return { message: `${JSON.stringify(repo)} is not owner/repo` }
    }
    named.push(repo)
  }
  return named
}

/**
 * Read the grants a broker was started with.
 *
 * Fails closed and fails loudly: a broker that started with a grant it could not
 * parse would serve a smaller policy than the one written down, which is the
 * kind of difference nobody notices until the fetch that should have been
 * refused succeeds.
 */
export const parseGrants = (json: string): { grants: Grant[] } | { message: string } => {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return { message: '--grants is not JSON' }
  }
  if (!Array.isArray(raw)) return { message: '--grants must be a JSON array' }

  const grants: Array<Grant> = []
  for (const entry of raw as unknown[]) {
    if (!isObject(entry)) return { message: 'a grant must be an object' }
    const { credential, profile, repos } = entry

    if ('hosts' in entry) {
      const read = readProfileGrant(entry)
      if ('message' in read) return read
      const { grant } = read
      if (grants.some(other => other.profile === grant.profile)) {
        return {
          message: `there are two ${grant.profile} grants, and a request could not choose one`,
        }
      }
      // A request is routed by the name it was addressed to, so a name is one
      // grant's or none, and never one the broker's own code answers.
      const taken = [...tlsNames(grants), ...forgeNames]
      const shared = Object.keys(grant.hosts).find(host => taken.includes(host))
      if (shared !== undefined) {
        return {
          message: `${shared} is a host of the ${grant.profile} grant and of another, and a request to it could not choose one`,
        }
      }
      grants.push(grant)
      continue
    }

    if (profile === 'model-server') {
      const unread = Object.keys(entry).find(key => !grantFields['model-server'].has(key))
      if (unread !== undefined) {
        return { message: `the model-server grant sets ${unread}, which this broker does not read` }
      }
      const { name, port } = entry
      if (typeof name !== 'string' || !isModelServerName(name)) {
        return { message: `${JSON.stringify(name)} is not a model server's name` }
      }
      if (!isTcpPort(port)) {
        return { message: `the ${name} model server's port, ${JSON.stringify(port)}, is not one` }
      }
      if (credential !== undefined && (typeof credential !== 'string' || credential === '')) {
        return { message: `the ${name} model server's credential is not a name` }
      }
      if (grants.some(grant => isModelServerGrant(grant) && grant.name === name)) {
        return {
          message: `there are two model servers named ${name}, and a request could not choose one`,
        }
      }
      grants.push({ ...(credential === undefined ? {} : { credential }), name, port, profile })
      continue
    }

    if (!isProfileName(profile)) {
      return {
        message: `unknown profile ${JSON.stringify(profile)}; the broker's own are ${Object.keys(profiles).join(', ')}, and any other is a profile grant, with hosts`,
      }
    }
    // Refused rather than ignored: a field this file does not read is a limit
    // someone wrote down that nothing would enforce.
    const unread = Object.keys(entry).find(key => !grantFields[profiles[profile].kind].has(key))
    if (unread !== undefined) {
      return { message: `the ${profile} grant sets ${unread}, which this broker does not read` }
    }
    if (typeof credential !== 'string' || credential === '') {
      return { message: 'a grant needs a credential name' }
    }

    // One per profile: a request that names no repository, or no credential,
    // could not choose between two.
    if (grants.some(grant => grant.profile === profile)) {
      return { message: `there are two ${profile} grants, and a request could not choose one` }
    }

    const read = repoList(profile, 'repos', repos)
    if ('message' in read) return read
    const written = entry['write'] === undefined ? [] : repoList(profile, 'write', entry['write'])
    if ('message' in written) return written
    if (read.length + written.length === 0) {
      return { message: `the ${profile} grant names no repositories` }
    }
    grants.push({
      credential,
      profile,
      repos: read,
      ...(written.length === 0 ? {} : { write: written }),
    })
  }
  return { grants }
}

/**
 * What the guest holds where a client reads its key, so that an unmodified
 * client reaches the broker: a profile's placeholders, `GH_TOKEN`, and a model
 * server's key where a harness reads one.
 *
 * A **placeholder**, and that is load-bearing rather than tidy: a client
 * refuses to construct itself with no key at all, so a VM that deliberately
 * holds no key still needs something in the variable for a request to be made
 * — the broker replaces it with the real one, which never leaves the host.
 * Anything reading it inside the guest learns nothing.
 *
 * This is content, not policy. A module that unsets these makes a client send
 * no key, which the broker sets regardless, or fail to start. It cannot make a
 * credential reachable, which is the thing worth protecting.
 */
export const guestPlaceholderKey = 'igloo-broker-holds-the-real-key'

/** The first path segment of every request for a model server. */
const modelServerPrefix = 'local'

/**
 * Where a model server is reached from the guest: the base an OpenAI-shaped
 * client appends `chat/completions`, `responses` or `models` to.
 */
export const modelServerBase = (name: string, port: number): string =>
  `http://127.0.0.1:${String(port)}/${modelServerPrefix}/${name}/v1`

/**
 * The variables the guest is given for `grants` beside a profile's
 * placeholders, which composition sets from the profile. Every value is plain
 * text with no `"` or `\`: NixOS writes these into a shell script and a PAM
 * file inside double quotes, unescaped, so a quote in a value ends it.
 */
export const guestEnvironment = (
  grants: readonly Grant[],
  port: number,
): Record<string, string> => {
  const environment: Record<string, string> = {}
  // omp's built-in llama.cpp provider takes its base from this variable and
  // finds the server's models itself. It holds one URL, so with several
  // servers none is chosen for it.
  const [server, ...others] = grants.filter(isModelServerGrant)
  if (server !== undefined && others.length === 0) {
    environment['LLAMA_CPP_BASE_URL'] = modelServerBase(server.name, port)
  }
  // GitHub's CLI reaches its API by name, which the broker answers, and makes
  // no request without a token. Its own name for one, ahead of `GITHUB_TOKEN`.
  if (grants.some(grant => isGitGrant(grant) && grant.profile === 'github')) {
    environment['GH_TOKEN'] = guestPlaceholderKey
  }
  return environment
}

/**
 * The endpoints a model server serves, and the operation each one is: the
 * ones every OpenAI-compatible server shares, a model call in either shape and
 * the listing a client finds models by; and llama.cpp's call of a decision
 * model, which answers typed questions about a state with probabilities rather
 * than text, and finds its model as a chat completion does.
 *
 * A server's other endpoints are left out, because what they reach is not a
 * model call: some read other clients' requests, some save to files on the
 * host, and some load, unload or reconfigure models for every client of that
 * server.
 */
const modelServerEndpoints: Readonly<Record<string, ModelServerOperation>> = {
  'v1/chat/completions': 'chat-completions',
  'v1/models': 'list-models',
  'v1/responses': 'responses',
  'v1/systemone': 'systemone',
}

/**
 * Whether an operation sends a body: a model listing, a ref advertisement and
 * a read are read.
 */
const sendsBody = (operation: Operation): boolean =>
  operation !== 'list-models' &&
  operation !== 'ls-refs' &&
  operation !== 'push-refs' &&
  operation !== 'read'

/** How each model server operation is requested: a listing is read, the rest are sent a body. */
const methodOf = (operation: ModelServerOperation): 'GET' | 'POST' =>
  sendsBody(operation) ? 'POST' : 'GET'

/** The methods that write through a forge's API. */
const writeMethods: ReadonlySet<string> = new Set(['DELETE', 'PATCH', 'POST', 'PUT'])

/**
 * What a repository in a grant's `write` may be written at through the REST
 * API, and by which methods: a path under `repos/<owner>/<repo>/`, a segment at
 * a time, where `*` is any one segment and a last `**` any number of them, none
 * included.
 *
 * What GitHub's CLI writes: issues and pull requests, with their comments,
 * labels, reviews and merges; releases and their assets; a workflow run's rerun
 * and cancel, and a workflow's dispatch; and a commit's statuses and checks.
 * The rest of what a token that writes a repository may write is left out, its
 * settings, collaborators, webhooks, deploy keys, Actions secrets and variables
 * and runner registration among it: each reaches past the repository, to the
 * people it lets in, the hosts a webhook calls, the machines a key opens, or
 * the jobs a runner is given.
 */
const apiWrites: Readonly<Record<string, readonly string[]>> = {
  'actions/jobs/*/rerun': ['POST'],
  'actions/runs/*/cancel': ['POST'],
  'actions/runs/*/force-cancel': ['POST'],
  'actions/runs/*/rerun': ['POST'],
  'actions/runs/*/rerun-failed-jobs': ['POST'],
  'actions/workflows/*/dispatches': ['POST'],
  'check-runs': ['POST'],
  'check-runs/*': ['PATCH'],
  'check-runs/*/rerequest': ['POST'],
  'check-suites': ['POST'],
  'check-suites/*/rerequest': ['POST'],
  'issues/**': [...writeMethods],
  'pulls/**': [...writeMethods],
  'releases/**': [...writeMethods],
  'statuses/*': ['POST'],
}

/**
 * What `apiWrites` admits and is refused all the same, in its form.
 *
 * A Codespace made from a pull request: a machine of its own, billed to the
 * token's account and open to the internet, that runs the code on the pull
 * request's branch with whatever Codespaces secrets that account gives the
 * repository. It reaches past the repository, as a runner's registration does.
 * GitHub matches a path's fixed segments by case, so these are compared as
 * they are written.
 */
const apiWritesRefused: Readonly<Record<string, readonly string[]>> = {
  'pulls/*/codespaces': [...writeMethods],
}

/**
 * Whether `pattern`, a path in `apiWrites`' form, matches `path`, a sequence
 * of segments: `*` any one segment, a last `**` any number of them, none
 * included, `""` the root alone, and every other segment compared as written.
 */
const pathMatches = (pattern: string, path: readonly string[]): boolean => {
  const segments = pattern === '' ? [] : pattern.split('/')
  const open = segments.at(-1) === '**'
  const fixed = open ? segments.slice(0, -1) : segments
  return (
    (open ? path.length >= fixed.length : path.length === fixed.length) &&
    fixed.every((segment, at) => segment === '*' || segment === path[at])
  )
}

/** Whether `rule` matches a request by `method` at `path`, a sequence of segments. */
const ruleMatches = (rule: Rule, method: string, path: readonly string[]): boolean =>
  (rule.method === '*' || rule.method.includes(method)) && pathMatches(rule.path, path)

/** A rule as the log and a refusal name it: `GET,HEAD v2/**`, the root as `/`. */
const ruleText = (rule: Rule): string =>
  `${rule.method === '*' ? '*' : rule.method.join(',')} ${rule.path === '' ? '/' : rule.path}`

/**
 * Whether `table`, paths in `apiWrites`' form, lets `method` write at `path`,
 * a sequence of segments.
 */
const listedIn = (
  table: Readonly<Record<string, readonly string[]>>,
  method: string,
  path: readonly string[],
): boolean =>
  Object.entries(table).some(
    ([listed, methods]) => methods.includes(method) && pathMatches(listed, path),
  )

/**
 * Whether `method` may write at `tail`, the path past a repository: one
 * `apiWrites` lists and `apiWritesRefused` does not.
 */
const writesTo = (method: string, tail: readonly string[]): boolean =>
  listedIn(apiWrites, method, tail) && !listedIn(apiWritesRefused, method, tail)

/**
 * Route a request for a profile grant's host, or `undefined` if the path's
 * host is none of them.
 *
 * A `deny` rule that matches refuses it, whatever is chosen; then a chosen
 * rule that matches allows it; and anything else is refused. Order means
 * nothing: of the chosen rules that match, one with no reader is taken before
 * one with GraphQL's, since a request any rule allows unread is allowed.
 *
 * The upstream is the host and the request's path, segment by segment —
 * `decide` has refused a percent-escape and an empty segment, and the URL
 * parser has resolved every `.` and `..`, so the path sent is the one the
 * rule matched — and its query, rebuilt so that each name and value is
 * encoded. A GraphQL request goes without its query, since a server may take
 * an operation from the query in place of the body that was read.
 */
const routeProfile = (
  grants: readonly Grant[],
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
): Decision | undefined => {
  const [host, ...rest] = segments
  if (host === undefined) return undefined
  const lowered = host.toLowerCase()
  const grant = grants
    .filter(isProfileGrant)
    .find(candidate => Object.hasOwn(candidate.hosts, lowered))
  const at = grant?.hosts[lowered]
  if (grant === undefined || at === undefined) return undefined

  const path = `/${rest.join('/')}`
  const denied = at.deny.find(rule => ruleMatches(rule, method, rest))
  if (denied !== undefined) {
    return deny(
      403,
      `${method} ${path} is refused at ${lowered} by the ${grant.profile} profile's deny rule ${ruleText(denied)}`,
      { host: lowered },
    )
  }
  const matching = at.allow.filter(rule => ruleMatches(rule, method, rest))
  const rule = matching.find(each => each.graphql === undefined) ?? matching[0]
  if (rule === undefined) {
    // A path a chosen rule names, by other methods: a `*` rule would have
    // matched any.
    const methods = [
      ...new Set(
        at.allow.flatMap(each =>
          each.method !== '*' && pathMatches(each.path, rest) ? each.method : [],
        ),
      ),
    ]
    if (methods.length > 0) {
      return deny(
        405,
        `${method} ${path} is not something this VM may do through ${lowered}, which allows ${methods.join(', ')} there`,
        { host: lowered },
      )
    }
    return deny(403, `${method} ${path} is not something this VM may do through ${lowered}`, {
      host: lowered,
    })
  }
  const filter = rule.graphql === undefined ? new URLSearchParams(query).toString() : ''
  return {
    _tag: 'Profile',
    credential: grant.credential,
    ...(rule.graphql === undefined ? {} : { graphql: rule.graphql }),
    host: lowered,
    profile: grant.profile,
    rule: ruleText(rule),
    send: at.send,
    sendsBody: method !== 'GET' && method !== 'HEAD',
    set: rule.set,
    upstream: `https://${lowered}${path}${filter === '' ? '' : `?${filter}`}`,
  }
}

/**
 * Route a request for a git grant's API, or `undefined` if the path's host is
 * no held grant's API.
 *
 * A read under `repos/<owner>/<repo>/` for a repository a grant lists is sent
 * with that grant's credential, and so is a write there that `apiWrites` lists,
 * for a repository in the grant's `write`. The upstream path is the grant's
 * spelling of the repository, then the rest of the path as the request had it,
 * segment by segment: `decide` has already refused a percent-escape and an
 * empty segment, and the URL parser has resolved every `.` and `..`, so no
 * segment can leave the repository it follows. The query is carried, rebuilt
 * so that each name and value is encoded. A read of the API's root is sent with
 * the credential too, and without its query.
 *
 * A GraphQL query, a `POST` to `graphql`, is sent with the credential too, and
 * its body as it arrived. It names what it reads and writes in that body, some
 * of it by node IDs that say which repository they belong to only after a
 * lookup, so no grant's repositories could be matched against it even by
 * reading it: the token's own scope is all that bounds it.
 *
 * Everything else is refused.
 */
const routeApi = (
  grants: readonly Grant[],
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
): Decision | undefined => {
  const [host, ...rest] = segments
  if (host === undefined) return undefined
  const lowered = host.toLowerCase()
  const held = grants.filter(isGitGrant).filter(grant => profiles[grant.profile].api === lowered)
  const [grant] = held
  if (grant === undefined) return undefined

  if (rest.length === 1 && rest[0] === 'graphql') {
    if (method !== 'POST') return deny(405, `${method} is not how /graphql is requested`)
    return {
      _tag: 'Api',
      credential: grant.credential,
      host: lowered,
      operation: 'graphql',
      profile: grant.profile,
      upstream: `https://${lowered}/graphql`,
    }
  }
  const writes = writeMethods.has(method)
  if (!writes && method !== 'GET' && method !== 'HEAD') {
    return deny(405, `${method} is not a method this VM may use through ${lowered}`, {
      host: lowered,
    })
  }
  const [area, owner, repo, ...tail] = rest
  // The API's root names its endpoints and, asked with a token, that token's
  // scopes, which is what `gh auth status` reads once it has a login.
  if (area === undefined && !writes) {
    return {
      _tag: 'Api',
      credential: grant.credential,
      host: lowered,
      operation: 'read',
      profile: grant.profile,
      upstream: `https://${lowered}/`,
    }
  }
  if (area !== 'repos') {
    return deny(
      403,
      `/${rest.join('/')} is not something this VM may ${writes ? 'write' : 'read'} through ${lowered}`,
      { host: lowered },
    )
  }
  if (owner === undefined || repo === undefined) {
    return deny(404, 'a repository is named at /repos/<owner>/<repo>')
  }

  const wanted = `${owner}/${repo}`.toLowerCase()
  for (const candidate of held) {
    const writable = grantedAs(candidate.write, wanted)
    const allowed = writable ?? grantedAs(candidate.repos, wanted)
    if (allowed === undefined) continue
    if (writes && writable === undefined) {
      return deny(403, `this VM may read ${wanted}, not write to it`, { scope: wanted })
    }
    if (writes && !writesTo(method, tail)) {
      return deny(403, `${method} /${rest.join('/')} is not a write this VM may make`, {
        scope: wanted,
      })
    }
    const path = withoutGit(allowed)
    const filter = new URLSearchParams(query).toString()
    return {
      _tag: 'Api',
      credential: candidate.credential,
      host: lowered,
      operation: writes ? 'write' : 'read',
      profile: candidate.profile,
      repo: path,
      upstream: `https://${lowered}/repos/${[path, ...tail].join('/')}${filter === '' ? '' : `?${filter}`}`,
    }
  }
  return deny(403, `${wanted} is not a repository this VM may ${writes ? 'write to' : 'read'}`, {
    scope: wanted,
  })
}

/**
 * Route a request for the host a git grant's API takes uploads at, or
 * `undefined` if the path's host is no held grant's.
 *
 * GitHub takes a release's asset there, as a `POST` to
 * `repos/<owner>/<repo>/releases/<id>/assets` with the asset's name in the
 * query. One for a repository in a grant's `write` is sent with that grant's
 * credential, its upstream built as an API write's is. Everything else there is
 * refused.
 */
const routeUploads = (
  grants: readonly Grant[],
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
): Decision | undefined => {
  const [host, ...rest] = segments
  if (host === undefined) return undefined
  const lowered = host.toLowerCase()
  const held = grants
    .filter(isGitGrant)
    .filter(grant => profiles[grant.profile].uploads === lowered)
  if (held.length === 0) return undefined

  const [area, owner, repo, releases, release, assets, ...beyond] = rest
  if (
    area !== 'repos' ||
    owner === undefined ||
    repo === undefined ||
    releases !== 'releases' ||
    release === undefined ||
    assets !== 'assets' ||
    beyond.length > 0
  ) {
    return deny(403, `/${rest.join('/')} is not something this VM may send to ${lowered}`, {
      host: lowered,
    })
  }
  if (method !== 'POST') return deny(405, `${method} is not how a release's asset is uploaded`)

  const wanted = `${owner}/${repo}`.toLowerCase()
  for (const candidate of held) {
    const writable = grantedAs(candidate.write, wanted)
    if (writable === undefined) {
      if (grantedAs(candidate.repos, wanted) === undefined) continue
      return deny(403, `this VM may read ${wanted}, not write to it`, { scope: wanted })
    }
    const path = withoutGit(writable)
    const filter = new URLSearchParams(query).toString()
    return {
      _tag: 'Api',
      credential: candidate.credential,
      host: lowered,
      operation: 'upload',
      profile: candidate.profile,
      repo: path,
      upstream: `https://${lowered}/repos/${path}/releases/${release}/assets${filter === '' ? '' : `?${filter}`}`,
    }
  }
  return deny(403, `${wanted} is not a repository this VM may write to`, { scope: wanted })
}

/**
 * Route a git request, or `undefined` if the path is not a git endpoint at all —
 * which is what lets a model server's endpoint be tried against the same path
 * without weakening any of the refusals below.
 */
const routeGit = (
  grants: readonly Grant[],
  method: string,
  segments: readonly string[],
  service: string | null,
): Decision | undefined => {
  const last = segments.at(-1)

  let operation: GitOperation
  let head: readonly string[]
  if (last === 'refs' && segments.at(-2) === 'info') {
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return deny(404, 'the ref advertisement takes ?service=git-upload-pack or git-receive-pack')
    }
    if (method !== 'GET') return deny(405, `${method} is not how a ref advertisement is requested`)
    operation = service === 'git-upload-pack' ? 'ls-refs' : 'push-refs'
    head = segments.slice(0, -2)
  } else if (last === 'git-upload-pack' || last === 'git-receive-pack') {
    operation = last === 'git-upload-pack' ? 'fetch' : 'push'
    if (method !== 'POST') return deny(405, `${method} is not how a ${operation} is requested`)
    head = segments.slice(0, -1)
  } else {
    return undefined
  }
  const pushes = operation === 'push' || operation === 'push-refs'

  // Exactly host, owner and repository. Anything longer or shorter is not a
  // shape this broker serves, which is also what makes `..` unreachable.
  const [host, owner, repo] = head
  if (head.length !== 3 || host === undefined || owner === undefined || repo === undefined) {
    return deny(404, 'a brokered git URL is /<host>/<owner>/<repo>/…')
  }

  const wanted = normaliseRepo(`${owner}/${repo}`)
  const lowered = host.toLowerCase()
  const forHost = grants
    .filter(isGitGrant)
    .filter(grant => profiles[grant.profile].host === lowered)
  if (forHost.length === 0) return deny(403, `${host} is not brokered for this VM`, { host })

  for (const grant of forHost) {
    const writable = grantedAs(grant.write, wanted)
    const allowed = writable ?? grantedAs(grant.repos, wanted)
    if (allowed === undefined) continue
    // Refused at the advertisement as well as at the push, since the
    // advertisement is where git asks whether it may push at all: refusing only
    // the second would let a push start and fail late.
    if (pushes && writable === undefined) {
      return deny(403, 'this VM may fetch, not push', { scope: wanted })
    }
    // Built from the grant's spelling and a fixed template. The request decided
    // which grant applies and nothing else.
    const upstreamHost = profiles[grant.profile].host
    const path = withoutGit(allowed)
    return {
      _tag: 'Git',
      credential: grant.credential,
      host: upstreamHost,
      operation,
      profile: grant.profile,
      repo: path,
      upstream: `https://${upstreamHost}/${path}.git/${gitEndpoints[operation]}`,
    }
  }
  return deny(403, `${wanted} is not a repository this VM may ${pushes ? 'push to' : 'fetch'}`, {
    scope: wanted,
  })
}

/** Where each git request goes, under a repository's `.git`. */
const gitEndpoints: Readonly<Record<GitOperation, string>> = {
  fetch: 'git-upload-pack',
  'ls-refs': 'info/refs?service=git-upload-pack',
  push: 'git-receive-pack',
  'push-refs': 'info/refs?service=git-receive-pack',
}

/**
 * Route a request for a model server, or `undefined` if the path does not ask
 * for one. The path is `/local/<name>/` and an endpoint `modelServerEndpoints`
 * lists.
 *
 * The upstream is loopback, the grant's port and the table's key. A listing's
 * query is not carried: no endpoint here reads one.
 */
const routeModelServer = (
  grants: readonly Grant[],
  method: string,
  segments: readonly string[],
): Decision | undefined => {
  const [prefix, name, ...rest] = segments
  if (prefix !== modelServerPrefix) return undefined
  const grant = grants.filter(isModelServerGrant).find(candidate => candidate.name === name)
  if (name === undefined || grant === undefined) {
    return deny(
      403,
      `no model server${name === undefined ? '' : ` named ${name}`} is brokered for this VM`,
      name === undefined ? undefined : { server: name },
    )
  }

  const asked = rest.join('/')
  for (const [path, operation] of Object.entries(modelServerEndpoints)) {
    if (path !== asked) continue
    if (method !== methodOf(operation)) {
      return deny(405, `${method} is not how ${path} is requested`)
    }
    const host = `127.0.0.1:${String(grant.port)}`
    return {
      _tag: 'ModelServer',
      ...(grant.credential === undefined ? {} : { credential: grant.credential }),
      host,
      operation,
      server: grant.name,
      upstream: `http://${host}/${path}`,
    }
  }
  return deny(404, `${name} is brokered, but /${asked} is not an endpoint this VM may call`, {
    server: name,
  })
}

/**
 * Whether this request is one the grants permit, and if so what to send upstream.
 *
 * Pure. `target` is the request URL as received; nothing is taken from it except
 * the path, as a sequence of segments matched against a fixed shape or a
 * profile's rules, git's `service`, and the query of a forge's API request or
 * a profile's. A refusal is set to be written in JSON when the path's first segment, the host the request
 * is for, is one of `jsonNames`, whatever refused it.
 *
 * A profile grant's hosts are not routed here: they are answered by name
 * alone (`decideAddressed`).
 */
export const decide = (grants: readonly Grant[], method: string, target: string): Decision =>
  decideAt(grants, method, target, false)

/** `decide`, routing a profile grant's hosts too when the request was `addressed` to one by name. */
const decideAt = (
  grants: readonly Grant[],
  method: string,
  target: string,
  addressed: boolean,
): Decision => {
  // Parsed against a base, because a request target is not always a URL: a
  // client that sends no `Host` — anything speaking HTTP/1.0 — leaves the server
  // reporting the bare path, which is not one on its own. The base is inert
  // either way, since nothing below reads the authority; an absolute-form target
  // carrying an authority of the guest's choosing is therefore normalised away
  // rather than merely unused.
  let url: URL
  try {
    url = new URL(target, 'http://broker.invalid')
  } catch {
    return deny(400, 'unparseable request target')
  }
  return refusedAt(
    grants,
    url.pathname.split('/')[1]?.toLowerCase() ?? '',
    route(grants, method, url, addressed),
  )
}

/** `decideAt`, once the target is parsed. */
const route = (
  grants: readonly Grant[],
  method: string,
  url: URL,
  addressed: boolean,
): Decision => {
  if (grants.length === 0) return deny(403, 'this VM has no brokered credential')

  // Refused rather than decoded. A repository name never needs an escape, so the
  // only thing percent-encoding can express here is a segment that means one
  // thing to this matcher and another to whatever decodes it later.
  if (url.pathname.includes('%')) return deny(400, 'percent-encoding is not accepted in a path')

  // A host's root, `/<host>/`, is the host alone: the one place an empty
  // segment is the path's own rather than a gap in it.
  const segments = url.pathname
    .replace(/^(\/[^/]+)\/$/, '$1')
    .split('/')
    .slice(1)
  if (segments.some(segment => segment === '')) return deny(404, 'empty path segment')

  // A profile's host first, by its name, then a forge's API and its uploads,
  // by their hosts: their paths are the service's own, and one could end in
  // what reads as a git endpoint. Then git, and only then a model server: a
  // git endpoint has a shape of its own, so trying it first keeps every
  // refusal it makes — the push at the advertisement, the wrong method, the
  // path that is not three segments — rather than letting an unrecognised git
  // path fall through to a model server's "no such endpoint".
  const profile = addressed ? routeProfile(grants, method, segments, url.searchParams) : undefined
  if (profile !== undefined) return profile
  const api = routeApi(grants, method, segments, url.searchParams)
  if (api !== undefined) return api
  const upload = routeUploads(grants, method, segments, url.searchParams)
  if (upload !== undefined) return upload
  const git = routeGit(grants, method, segments, url.searchParams.get('service'))
  if (git !== undefined) return git
  const local = routeModelServer(grants, method, segments)
  if (local !== undefined) return local
  return deny(404, 'not an endpoint this broker serves')
}

/**
 * Whether a request the TLS listener received is one the grants permit.
 *
 * The listener is reached by a client that connected to a host by its own
 * name, so its paths carry no host: the name it was addressed to is read
 * instead, and stands where the path form puts one. Only a name the grants are
 * answered at is read as one, so a guest choosing the name chooses among those
 * and nothing else; the rest is `decide`'s, unchanged.
 *
 * A read that no grant serves is sent on without a credential if `reach`, the
 * tunnel's scope, takes in the name: the guest could have sent it through the
 * tunnel itself had the broker not answered the name, and nothing is added to
 * it. Its path and query go as the guest sent them, since no grant is being
 * matched against them. Anything else no grant serves is refused as `decide`
 * refuses it.
 *
 * `url` is the request URL as received, whose authority is the request's
 * `Host`.
 */
export const decideAddressed = (
  grants: readonly Grant[],
  method: string,
  url: string,
  reach: TunnelScope = [],
): Decision => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return deny(400, 'unparseable request target')
  }
  // One trailing dot is the same name, as it is to the tunnel.
  const host = parsed.hostname.toLowerCase()
  const name = host.endsWith('.') ? host.slice(0, -1) : host
  if (!tlsNames(grants).includes(name)) {
    return refusedAt(
      grants,
      name,
      deny(421, `${name} is not answered here for this VM`, { host: name }),
    )
  }
  const granted = decideAt(grants, method, `/${name}${parsed.pathname}${parsed.search}`, true)
  if (granted._tag !== 'Deny') return granted

  const operation = readOf(method, parsed)
  if (operation === undefined) return granted
  const reached = reach === 'any' || reach.some(each => each.toLowerCase() === name)
  if (!reached) {
    // A refusal that names a repository says enough. One that says only that
    // this is no git endpoint hides why a read was not sent on.
    return granted.status === 404
      ? refusedAt(
          grants,
          name,
          deny(
            403,
            `no grant covers this, and the tunnel does not reach ${name}, so it is not sent without one either`,
            { host: name },
          ),
        )
      : granted
  }
  return {
    _tag: 'Anonymous',
    host: name,
    operation,
    upstream: `https://${name}${parsed.pathname}${parsed.search}`,
  }
}

/**
 * What a request is, if it only reads: git's ref advertisement for a fetch,
 * its fetch, or anything else asked for with GET or HEAD. A push's ref
 * advertisement is a GET, and is the start of a write.
 */
const readOf = (method: string, url: URL): AnonymousOperation | undefined => {
  const service = url.searchParams.get('service')
  if (method === 'POST') return url.pathname.endsWith('/git-upload-pack') ? 'fetch' : undefined
  if (method !== 'GET' && method !== 'HEAD') return undefined
  if (service === 'git-receive-pack') return undefined
  return url.pathname.endsWith('/info/refs') && service === 'git-upload-pack' ? 'ls-refs' : 'read'
}

/**
 * Headers that describe one connection rather than the request or response it
 * carries, so they stop at this broker in either direction.
 */
const hopByHop = [
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
] as const

/** The guest's headers a request other than git's does not carry upstream. */
const unforwardedRequestHeaders: ReadonlySet<string> = new Set([
  // Credentials. The one that reaches the provider is the broker's.
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
  ...hopByHop,
  // About the connection to this broker, which is not the one to the provider.
  'expect',
  'host',
  // What a front end in the provider's path may act on in place of the
  // request's own method, path or origin. The grant was decided on the method
  // and path the request has, and the provider is reached from this host.
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-prefix',
  'x-forwarded-proto',
  'x-http-method',
  'x-http-method-override',
  'x-method-override',
  'x-original-url',
  'x-real-ip',
  'x-rewrite-url',
  // How the guest framed its body for this connection. `fetch` frames it again
  // from the bytes it sends, in chunks, so no length the guest stated can
  // disagree with what reaches the provider. An asset's upload is the one
  // exception, and `uploadLength` says how it is kept from disagreeing.
  'content-length',
  // Set here, for the reason `upstreamHeaders` gives.
  'accept-encoding',
])

/**
 * What describes a body besides its length: its type and its encoding. A body
 * goes upstream as it arrived, so these go with it as the guest sent them, and
 * a request that sends no body carries neither.
 */
const bodyHeaders = ['content-encoding', 'content-type'] as const

/**
 * The length an upload of a release's asset goes upstream with: the one its
 * `Content-Length` declares, a whole number with no `Transfer-Encoding` beside
 * it, or `undefined`, and then it goes in chunks as every other body does.
 *
 * GitHub takes an asset only with its length, and refuses one sent in chunks,
 * so it goes framed as the guest framed it. `fetch` sends a stated length
 * and then every byte of the body, however many there are, so bytes past it
 * would reach the upstream as the start of another request on the broker's
 * connection: `heldTo` keeps the body to the length it is sent with.
 */
const uploadLength = (
  decision: Exclude<Decision, { _tag: 'Deny' }>,
  guest: Headers,
): number | undefined => {
  if (decision._tag !== 'Api' || decision.operation !== 'upload') return undefined
  const length = guest.get('content-length')
  if (length === null || guest.has('transfer-encoding') || !/^[0-9]{1,15}$/.test(length)) {
    return undefined
  }
  return Number(length)
}

/**
 * A body held to `length`: passed on as it arrives, and failed once it runs
 * past `length` or ends short of it, which ends the upstream request and
 * closes its connection rather than completing it with more or less than was
 * stated.
 */
export const heldTo = (
  source: ReadableStream<Uint8Array>,
  length: number,
): ReadableStream<Uint8Array> => {
  const reader = source.getReader()
  let bytes = 0
  return new ReadableStream<Uint8Array>({
    cancel(reason) {
      return reader.cancel(reason)
    },
    async pull(controller) {
      const chunk = await reader.read()
      if (chunk.done && bytes !== length) {
        controller.error(new Error(`the body ended at ${String(bytes)} of ${String(length)} bytes`))
        return
      }
      if (chunk.done) {
        controller.close()
        return
      }
      bytes += chunk.value.byteLength
      if (bytes > length) {
        await reader.cancel()
        controller.error(new Error(`the body ran past its ${String(length)} bytes`))
        return
      }
      controller.enqueue(chunk.value)
    },
  })
}

/** The most of a GraphQL request's body that is read, in bytes. */
export const graphqlBodyLimit = 256 * 1024

/** The fields a GraphQL request is read with, as the GraphQL over HTTP spec names them. */
const graphqlFields: ReadonlySet<string> = new Set(['operationName', 'query', 'variables'])

/**
 * Whether a request sends a body upstream: a profile's by its method, and
 * any other by what it is.
 */
const carriesBody = (decision: Exclude<Decision, { _tag: 'Deny' }>): boolean =>
  decision._tag === 'Profile' ? decision.sendsBody : sendsBody(decision.operation)

/**
 * The fields a GraphQL request may not name, for a decision whose body is
 * read as one before it is sent, a rule's with GraphQL's reader, or
 * `undefined` for one whose body is not read.
 */
const withheldFrom = (
  decision: Exclude<Decision, { _tag: 'Deny' }>,
): ReadonlySet<string> | undefined =>
  decision._tag === 'Profile' && decision.graphql !== undefined
    ? new Set(decision.graphql.withheld)
    : undefined

/** A GraphQL token: a name, a punctuator, or a value whose content decides nothing, a string or a number. */
type GraphqlToken =
  | { readonly name: string }
  | { readonly punctuator: string }
  | { readonly value: true }

const GRAPHQL_NAME = /[_A-Za-z][_0-9A-Za-z]*/y
const GRAPHQL_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y

/**
 * A GraphQL document's tokens, read as the GraphQL spec's lexer reads them, or
 * `undefined` for text it would refuse.
 *
 * What matters is agreeing with the server on what is a name and what is
 * inside a string or a comment, so a word in either decides nothing here as it
 * decides nothing there. Where this reads more loosely than the spec, a `\`
 * before a line's end in a string, the server refuses the document whole, and
 * runs none of it.
 */
const graphqlTokens = (document: string): readonly GraphqlToken[] | undefined => {
  const tokens: GraphqlToken[] = []
  let at = 0
  while (at < document.length) {
    const char = document[at] ?? ''
    if (' \t\n\r,\uFEFF'.includes(char)) {
      at += 1
    } else if (char === '#') {
      while (at < document.length && document[at] !== '\n' && document[at] !== '\r') at += 1
    } else if (document.startsWith('"""', at)) {
      // A block string ends at the first `"""` that is not `\"""`; nothing
      // else in it is an escape.
      at += 3
      while (!document.startsWith('"""', at)) {
        if (at >= document.length) return undefined
        at += document.startsWith('\\"""', at) ? 4 : 1
      }
      at += 3
      tokens.push({ value: true })
    } else if (char === '"') {
      at += 1
      for (;;) {
        const inside = document[at]
        if (inside === undefined || inside === '\n' || inside === '\r') return undefined
        if (inside === '"') break
        at += inside === '\\' ? 2 : 1
      }
      at += 1
      tokens.push({ value: true })
    } else if (document.startsWith('...', at)) {
      at += 3
      tokens.push({ punctuator: '...' })
    } else if ('!$&():=@[]{}|'.includes(char)) {
      at += 1
      tokens.push({ punctuator: char })
    } else {
      GRAPHQL_NAME.lastIndex = at
      const name = GRAPHQL_NAME.exec(document)
      if (name !== null) {
        at = GRAPHQL_NAME.lastIndex
        tokens.push({ name: name[0] })
        continue
      }
      GRAPHQL_NUMBER.lastIndex = at
      if (GRAPHQL_NUMBER.exec(document) === null) return undefined
      at = GRAPHQL_NUMBER.lastIndex
      // A number run into a name or a `.` is one the spec refuses.
      if (/[_A-Za-z.]/.test(document[at] ?? '')) return undefined
      tokens.push({ value: true })
    }
  }
  return tokens
}

/** Why a GraphQL document that could not be read is refused. */
const unreadDocument = 'the GraphQL document could not be read as one'

/**
 * Why a GraphQL document is not sent, or `undefined` if it is: one whose every
 * operation is a query, and that names no field in `withheld`.
 *
 * A document is a run of definitions, each an operation or a fragment. An
 * operation begins with `query`, `mutation` or `subscription`, or is a bare
 * selection set, `{ … }`, which is a query; a fragment begins with `fragment`.
 * After that keyword, a definition's head, its name, variables and directives,
 * runs to its selection set, whose braces end the definition when they
 * balance. Braces in a head's parentheses are a default value's, and braces in
 * a selection set's arguments are balanced in any document a server accepts,
 * so counting them finds where each definition ends wherever the server would.
 * Anything else that begins a definition is refused.
 *
 * A fragment on the mutation type can be defined, but spread into a query the
 * server refuses it, so a fragment decides nothing either way.
 */
export const graphqlRefusal = (
  document: string,
  withheld: ReadonlySet<string>,
): string | undefined => {
  const tokens = graphqlTokens(document)
  if (tokens === undefined) return unreadDocument
  let place: 'between' | 'head' | 'selection' = 'between'
  let depth = 0
  let queries = 0
  for (const token of tokens) {
    if ('name' in token && withheld.has(token.name)) {
      return `the query names ${token.name}, which holds a credential, so it is not sent`
    }
    if (place === 'between') {
      if ('punctuator' in token && token.punctuator === '{') {
        place = 'selection'
        depth = 1
        queries += 1
      } else if ('name' in token && (token.name === 'query' || token.name === 'fragment')) {
        place = 'head'
        depth = 0
        if (token.name === 'query') queries += 1
      } else if ('name' in token && token.name === 'mutation') {
        return 'a mutation writes, and this VM may only read through GraphQL; write through the REST API instead'
      } else if ('name' in token && token.name === 'subscription') {
        return 'a subscription is not a query, and this VM may only query through GraphQL'
      } else {
        return 'a GraphQL request holds operations and fragments, and this one holds something else'
      }
      continue
    }
    if (!('punctuator' in token)) continue
    if (place === 'head') {
      if (token.punctuator === '(') depth += 1
      if (token.punctuator === ')') depth -= 1
      if (depth < 0 || (depth === 0 && token.punctuator === '}')) return unreadDocument
      if (depth === 0 && token.punctuator === '{') {
        place = 'selection'
        depth = 1
      }
    } else {
      if (token.punctuator === '{') depth += 1
      if (token.punctuator === '}') depth -= 1
      if (depth === 0) place = 'between'
    }
  }
  if (place !== 'between') return unreadDocument
  if (queries === 0) return 'the GraphQL document holds no query'
  return undefined
}

/**
 * A GraphQL request read from its body, and the body to send for it: the
 * object it was read as, written again as JSON, or why it is not sent.
 *
 * Read as the GraphQL over HTTP spec gives it: one JSON object, with `query`,
 * the document in full, and `variables` and `operationName` beside it if at
 * all. Anything else is refused rather than passed on: an array is a batch of
 * requests, and `extensions` can carry a persisted query, which runs a document
 * the server stored by its hash in place of the one sent.
 *
 * Written again rather than sent as it came, so the server reads the object
 * this read and nothing a second JSON parser could read differently: a key
 * given twice, an encoding. A number in its variables too large for a double
 * to hold exactly is sent rounded, as `JSON.parse` read it.
 */
export const graphqlQuery = (
  text: string,
  withheld: ReadonlySet<string>,
): { readonly body: string } | { readonly reason: string } => {
  let request: unknown
  try {
    request = JSON.parse(text)
  } catch {
    return { reason: 'a GraphQL request is sent as JSON, and this one is not' }
  }
  if (!isObject(request) || Array.isArray(request)) {
    return { reason: 'a GraphQL request is one JSON object, and a batch is not sent' }
  }
  if (Object.keys(request).some(key => !graphqlFields.has(key))) {
    return {
      reason:
        'a GraphQL request is sent with query, variables and operationName alone, and this one sets more',
    }
  }
  const { operationName, query, variables } = request
  if (typeof query !== 'string') {
    return { reason: 'a GraphQL request is sent with its query in full, and this one has none' }
  }
  if (
    variables !== undefined &&
    variables !== null &&
    (!isObject(variables) || Array.isArray(variables))
  ) {
    return { reason: 'a GraphQL request’s variables are an object' }
  }
  if (operationName !== undefined && operationName !== null && typeof operationName !== 'string') {
    return { reason: 'a GraphQL request’s operationName is a string' }
  }
  const refused = graphqlRefusal(query, withheld)
  if (refused !== undefined) return { reason: refused }
  return { body: JSON.stringify({ operationName, query, variables }) }
}

/**
 * A body read whole, if it is no longer than `limit` bytes, and `undefined`
 * as soon as it runs past it, which stops reading it.
 */
const readWhole = async (
  source: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array | undefined> => {
  if (source === null) return new Uint8Array()
  const reader = source.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    bytes += chunk.value.byteLength
    if (bytes > limit) {
      await reader.cancel()
      return undefined
    }
    chunks.push(chunk.value)
  }
  const whole = new Uint8Array(bytes)
  let at = 0
  for (const chunk of chunks) {
    whole.set(chunk, at)
    at += chunk.byteLength
  }
  return whole
}

/** What git calls the body it sends and the one it gets back, on a fetch and a push. */
const packTypes = {
  fetch: {
    request: 'application/x-git-upload-pack-request',
    result: 'application/x-git-upload-pack-result',
  },
  push: {
    request: 'application/x-git-receive-pack-request',
    result: 'application/x-git-receive-pack-result',
  },
} as const

/**
 * The headers sent upstream.
 *
 * `Accept-Encoding: identity` is deliberate. `fetch` decodes a compressed
 * response transparently but leaves `Content-Encoding` on the headers, so
 * forwarding those headers to the client would describe the body as something it
 * is no longer. Asking for no encoding costs almost nothing — a packfile is
 * already compressed and a token stream is read as it arrives — and removes the
 * mismatch instead of tracking it.
 *
 * A git request's headers are built, and carry of the guest's only what git
 * negotiates with the upstream, each checked first.
 *
 * A profile's request carries the guest's headers but those in
 * `unforwardedRequestHeaders`, so a harness reaches its provider as it would
 * from the host: its API version, its betas, its session and cache hints, its
 * own name. None of them can send the request elsewhere or attach a
 * credential, since the URL is built from the grant, the credential is set
 * after the guest's are dropped, replacing a header of the same name, and so
 * are dropped the headers a front end could take another method, path or
 * origin from. A model server's request is built the same way, as is one
 * through a forge's API, and so is an anonymous read, whose credentials are
 * dropped and none set. An asset's upload carries the length `uploadLength`
 * gives it, if any, and a GraphQL request the type of the body the broker
 * wrote for it.
 *
 * `token` is the value of the credential the decision names, and `undefined`
 * only for a model server that takes none and an anonymous read: `handle`
 * sends nothing for a credential it does not hold.
 */
export const upstreamHeaders = (
  decision: Exclude<Decision, { _tag: 'Deny' }>,
  token: string | undefined,
  guest: Headers,
): Headers => {
  if (decision._tag !== 'Git') {
    // A header the guest's `Connection` names is hop-by-hop too.
    const named = new Set(
      (guest.get('connection') ?? '').split(',').map(name => name.trim().toLowerCase()),
    )
    const headers = new Headers()
    for (const [name, value] of guest) {
      if (!unforwardedRequestHeaders.has(name) && !named.has(name)) headers.append(name, value)
    }
    if (!carriesBody(decision)) for (const name of bodyHeaders) headers.delete(name)
    // A GraphQL request's body is the one `graphqlQuery` wrote, so it is
    // described as that rather than as the guest's was.
    if (withheldFrom(decision) !== undefined) {
      headers.delete('content-encoding')
      headers.set('Content-Type', 'application/json')
    }
    const length = uploadLength(decision, guest)
    if (length !== undefined) headers.set('Content-Length', String(length))
    headers.set('Accept-Encoding', 'identity')
    if (token === undefined) return headers
    // Set, never appended: a header of the same name the guest sent is
    // replaced by the one holding the key.
    if (decision._tag === 'Profile') {
      const { send } = decision
      if (send === 'bearer') headers.set('Authorization', `Bearer ${token}`)
      else if ('header' in send) headers.set(send.header, token)
      else headers.set('Authorization', `Basic ${btoa(`${send.basic}:${token}`)}`)
    } else {
      headers.set('Authorization', `Bearer ${token}`)
    }
    return headers
  }

  const pack =
    decision.operation === 'fetch' || decision.operation === 'push'
      ? packTypes[decision.operation]
      : undefined
  const headers = new Headers({
    'Accept-Encoding': 'identity',
    // git's own name for what it is asking for. Constructed, so a guest cannot
    // use content negotiation to reach a different upstream behaviour.
    Accept: pack === undefined ? '*/*' : pack.result,
    'User-Agent': 'igloo-broker',
  })
  // A fine-grained personal access token or an App installation token, in the
  // username slot git itself uses for them.
  if (token !== undefined) headers.set('Authorization', `Basic ${btoa(`x-access-token:${token}`)}`)
  if (pack !== undefined) {
    headers.set('Content-Type', pack.request)
    // git may compress what it sends. The body is passed through unexamined,
    // so the encoding that describes it has to go with it.
    if (guest.get('Content-Encoding') === 'gzip') headers.set('Content-Encoding', 'gzip')
  }
  const protocol = guest.get('Git-Protocol')
  if (protocol !== null && GIT_PROTOCOL.test(protocol)) headers.set('Git-Protocol', protocol)
  return headers
}

/**
 * Whether an upstream's answer is one to pass on, or one that is the broker's
 * own failure to report.
 *
 * Two statuses are not the guest's business. A **401** means the broker's
 * credential was refused, which nothing in the guest can fix. Git reads a 401
 * as a request for credentials and prompts for a username inside the guest, for
 * a credential the guest does not have and must not be given; dropping
 * `WWW-Authenticate` does not prevent that, since the status alone is the
 * trigger. So git gets a 502, which it reports and does not retry. A model
 * client retries a 502 as an outage, for minutes, and stops at a 403 with the
 * reason shown, so every other request gets a 403. A **redirect** names a
 * destination this grant did not authorize, and following it would send the
 * credential there, so it is answered with a 502 — but for an API's, which is
 * to a signed URL that needs no credential, and goes back to the guest.
 *
 * `scope` is what the credential was expected to cover, a repository where
 * there is one, because "this token is wrong" and "this token does not reach
 * that" are the two things a 401 can mean and the message cannot tell them
 * apart. A model server's grant may hold no credential, and then a 401 is the
 * server asking for one it was never given.
 *
 * An anonymous read carries no credential, so its redirect goes back to the
 * guest as the upstream gave it, for the guest to follow or not: whatever it
 * reaches, it reaches with nothing the broker holds. Its 401 is the upstream
 * asking for a credential no grant gives, and comes back as a final 403, which
 * git reports rather than prompting for one.
 */
export const relay = (
  attempt: {
    readonly credential: string | undefined
    readonly host: string
    readonly kind: Exclude<Decision['_tag'], 'Deny'>
    readonly scope: string | undefined
  },
  upstreamStatus: number,
): { reason: string; status: number } | undefined => {
  if (attempt.kind === 'Anonymous') {
    return upstreamStatus === 401
      ? {
          reason: `${attempt.host} wants a credential for this, and no grant of this VM's covers it`,
          status: 403,
        }
      : undefined
  }
  if (upstreamStatus === 401) {
    return {
      reason:
        attempt.credential === undefined
          ? `${attempt.host} wants a credential, and this VM's grant for it holds none`
          : `${attempt.host} refused ${attempt.credential}; the credential the host holds is wrong, expired, or not scoped to ${attempt.scope ?? 'this request'}`,
      status: attempt.kind === 'Git' ? 502 : 403,
    }
  }
  // Everything in the 3xx range except 304, which redirects nowhere: it is an
  // answer about a cached response and a client acts on it locally.
  if (upstreamStatus >= 300 && upstreamStatus < 400 && upstreamStatus !== 304) {
    // An API's redirect is to a signed URL elsewhere, a log or an asset, which
    // needs no credential: the guest follows it, and the broker does not.
    if (attempt.kind === 'Api') return undefined
    return {
      reason:
        attempt.credential === undefined
          ? `${attempt.host} redirected, which is not followed`
          : `${attempt.host} redirected, which is not followed with a credential attached`,
      status: 502,
    }
  }
  return undefined
}

/*
 * ---------------------------------------------------------------------------
 * The tunnel.
 *
 * A separate listener from everything above, and separate on purpose. The code
 * above *constructs* each upstream request, so it can say what a guest is
 * allowed to do. A tunnel carries bytes it cannot read — the TLS inside is
 * opaque, there is no CA and nothing is injected — so the only thing it can
 * police is the destination. Two ports rather than one keeps that difference
 * visible from inside the guest: the weaker thing is somewhere else.
 *
 * It is a raw socket server rather than a route in the HTTP server because
 * `Bun.serve` cannot carry a tunnel: it hands the handler a CONNECT request but
 * never delivers the client's subsequent bytes, and it frames whatever the
 * handler returns instead of yielding the socket.
 * ---------------------------------------------------------------------------
 */

/** The only port tunnelled. A proxy for HTTPS is what this is. */
const TUNNEL_PORT = 443

/**
 * Every TCP port a broker holding `grants` connects to, which its launch makes
 * the only ones it can. Each profile's upstream is `https://` on its host, and
 * the tunnel carries `CONNECT` to `TUNNEL_PORT` alone: both 443. A resolver
 * whose answer over UDP comes back truncated asks again over TCP, on 53. A
 * model server is on the port its grant names.
 *
 * The launch allows a port on every address. That a model server's port is
 * reached on loopback alone is `routeModelServer`'s doing.
 */
export const connectPorts = (grants: readonly Grant[]): readonly number[] => [
  ...new Set([443, 53, ...grants.filter(isModelServerGrant).map(grant => grant.port)]),
]

/** One DNS label, and no more than a name is: letters, digits, hyphen. */
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/

/**
 * Whether this is a name, as distinct from an address.
 *
 * The label rule alone accepts `151.101.64.223`, because digits and dots
 * satisfy it — so the final label is additionally required not to be all
 * digits, which is what separates a hostname from an IPv4 literal. An address
 * getting through would not be a hole, since it would still have to appear in
 * an allowlist of names and would still be judged as an address afterwards. It
 * would be a pinned CDN address that stops working silently when the CDN moves.
 */
export const isHostname = (value: string): boolean =>
  HOSTNAME.test(value) && !/^\d+$/.test(value.split('.').at(-1) ?? '')

export type Tunnel =
  | { readonly _tag: 'Open'; readonly host: string; readonly port: number }
  | { readonly _tag: 'Refuse'; readonly reason: string; readonly status: number }

const refuseTunnel = (status: number, reason: string): Tunnel => ({
  _tag: 'Refuse',
  reason,
  status,
})

/**
 * Read a CONNECT request line, and say where it wants to go.
 *
 * **Parsed by its own rule, never by `URL`.** A CONNECT target is in authority
 * form — `host:port`, no scheme — and `new URL` reads that as a scheme: the
 * target `evil.com:443` parses with protocol `evil.com:`, an empty host and the
 * path `443`. Passing a base does not rescue it either, because a target
 * carrying a scheme ignores the base. Anything here that reached for a URL
 * parser would be allowlisting the empty string.
 *
 * `head` is the request line only. Headers are not read at all: there is no
 * header a tunnel needs, and `Proxy-Authorization` in particular is not an
 * input, because the guest is identified by the socket it arrived on.
 */
export const parseConnect = (head: string): Tunnel => {
  const parts = head.split(' ')
  const [method, target, version] = parts
  if (parts.length !== 3 || method === undefined || target === undefined) {
    return refuseTunnel(400, 'not a request line')
  }
  if (method !== 'CONNECT') {
    return refuseTunnel(
      405,
      `${method} is not tunnelled; this proxy carries CONNECT to port ${String(TUNNEL_PORT)} and nothing else`,
    )
  }
  if (version !== 'HTTP/1.1' && version !== 'HTTP/1.0') {
    return refuseTunnel(400, 'not an HTTP request line')
  }

  // Split on the *last* colon so an IPv6 literal fails as an address rather
  // than as a parse, and reject anything carrying more of a URL than an
  // authority: a scheme, a path, a query, or userinfo.
  if (/[/?#@\\]/.test(target))
    return refuseTunnel(400, 'a CONNECT target is host:port and nothing else')
  const colon = target.lastIndexOf(':')
  if (colon <= 0) return refuseTunnel(400, 'a CONNECT target needs a port')
  const host = target.slice(0, colon).toLowerCase()
  const port = Number(target.slice(colon + 1))

  if (!Number.isInteger(port) || port !== TUNNEL_PORT) {
    return refuseTunnel(403, `only port ${String(TUNNEL_PORT)} is tunnelled`)
  }
  // One trailing dot is the same name; more than that is not a name.
  const name = host.endsWith('.') ? host.slice(0, -1) : host
  if (!isHostname(name)) {
    return refuseTunnel(403, 'a CONNECT target must be a hostname, not an address or a pattern')
  }
  return { _tag: 'Open', host: name, port }
}

/**
 * Split what a tunnel client has sent into its request line and whatever came
 * after the head, or `undefined` while the head is still arriving.
 *
 * The head runs through the blank line that ends it, and all of it is consumed
 * here, because any of it left over would be forwarded to the destination.
 * What follows it is the client's first bytes for the destination — a TLS hello
 * sent without waiting for the 200 — and stays bytes, since decoding would
 * change them.
 */
export const splitHead = (
  received: Uint8Array,
): { readonly line: string; readonly rest: Uint8Array } | undefined => {
  const end = Buffer.from(received.buffer, received.byteOffset, received.byteLength).indexOf(
    '\r\n\r\n',
  )
  if (end === -1) return undefined
  const head = new TextDecoder().decode(received.subarray(0, end))
  return { line: head.split('\r\n', 1)[0] ?? '', rest: received.subarray(end + 4) }
}

/**
 * The most a ClientHello may take, its handshake header included. A client's
 * is a few kilobytes, a post-quantum key share and a handful of tickets
 * included; past this, it is held for nothing.
 */
export const maxClientHelloBytes = 32 * 1024

/** What a tunnel's first bytes say about the TLS session they begin. */
export type ClientHello =
  /** Not a whole ClientHello yet. */
  | { readonly _tag: 'More' }
  /** The first byte begins no TLS handshake record. */
  | { readonly _tag: 'NotTls' }
  | { readonly _tag: 'Malformed'; readonly reason: string }
  /** The `host_name` of its `server_name` extension, if it has one. */
  | { readonly _tag: 'Hello'; readonly serverName: string | undefined }

/**
 * Read the server name a TLS session asks for from the bytes a client sends
 * first, as a server would read it.
 *
 * The ClientHello is a handshake message carried in records of type 22, and
 * may span several of them, and several TCP segments; it is whole once its
 * handshake length has arrived. Each record is held to TLS's limit of 2^14
 * bytes, and the hello to `maxClientHelloBytes`. Every length is checked
 * against what holds it, and the extensions must fill theirs exactly. A type
 * of extension sent twice is malformed, as TLS has it, and so is a
 * `server_name` naming more than one host: a client sends neither, and a
 * server and this reading could take different ones.
 *
 * Only the first byte decides `NotTls`. What follows a whole hello, the next
 * records of the session, is not read.
 */
export const readClientHello = (bytes: Uint8Array): ClientHello => {
  if (bytes.byteLength === 0) return { _tag: 'More' }
  if (bytes[0] !== 22) return { _tag: 'NotTls' }

  // The handshake message, gathered from as many records as it spans.
  const message: number[] = []
  let wanted: number | undefined
  let at = 0
  while (wanted === undefined || message.length < wanted) {
    if (at + 5 > bytes.byteLength) return { _tag: 'More' }
    if (bytes[at] !== 22) {
      return { _tag: 'Malformed', reason: 'a record that is not a handshake came inside the hello' }
    }
    if (bytes[at + 1] !== 3) return { _tag: 'Malformed', reason: 'the record is not TLS' }
    const length = ((bytes[at + 3] ?? 0) << 8) | (bytes[at + 4] ?? 0)
    if (length === 0 || length > 16384) {
      return { _tag: 'Malformed', reason: 'a handshake record of a length TLS does not allow' }
    }
    if (at + 5 + length > bytes.byteLength) return { _tag: 'More' }
    for (const byte of bytes.subarray(at + 5, at + 5 + length)) message.push(byte)
    at += 5 + length
    if (wanted === undefined && message.length >= 4) {
      if (message[0] !== 1)
        return { _tag: 'Malformed', reason: 'the first handshake is not a ClientHello' }
      wanted = 4 + (((message[1] ?? 0) << 16) | ((message[2] ?? 0) << 8) | (message[3] ?? 0))
      if (wanted > maxClientHelloBytes) {
        return { _tag: 'Malformed', reason: 'the ClientHello is larger than any client sends' }
      }
    }
  }

  // The hello's body, each field skipped by its own length, none past the end.
  const end = wanted
  const u8 = (i: number): number => message[i] ?? 0
  const u16 = (i: number): number => (u8(i) << 8) | u8(i + 1)
  const truncated: ClientHello = { _tag: 'Malformed', reason: 'the ClientHello is truncated' }
  let p = 4 + 2 + 32
  if (p + 1 > end) return truncated
  p += 1 + u8(p)
  if (p + 2 > end) return truncated
  p += 2 + u16(p)
  if (p + 1 > end) return truncated
  p += 1 + u8(p)
  if (p === end) return { _tag: 'Hello', serverName: undefined }
  if (p + 2 > end) return truncated
  const extensionsEnd = p + 2 + u16(p)
  if (extensionsEnd !== end) {
    return { _tag: 'Malformed', reason: 'the extensions do not fill the ClientHello' }
  }
  p += 2

  const seen = new Set<number>()
  let serverName: string | undefined
  while (p < extensionsEnd) {
    if (p + 4 > extensionsEnd) return truncated
    const type = u16(p)
    const dataEnd = p + 4 + u16(p + 2)
    if (dataEnd > extensionsEnd) return truncated
    if (seen.has(type)) return { _tag: 'Malformed', reason: 'an extension is sent twice' }
    seen.add(type)
    if (type === 0) {
      // server_name: a list of (type, name), of which host_name is type 0.
      let q = p + 4
      if (q + 2 > dataEnd || q + 2 + u16(q) !== dataEnd) return truncated
      q += 2
      while (q < dataEnd) {
        if (q + 3 > dataEnd) return truncated
        const nameEnd = q + 3 + u16(q + 1)
        if (nameEnd > dataEnd) return truncated
        if (u8(q) === 0) {
          if (serverName !== undefined) {
            return { _tag: 'Malformed', reason: 'the server_name extension names two hosts' }
          }
          serverName = Buffer.from(message.slice(q + 3, nameEnd)).toString('latin1')
        }
        q = nameEnd
      }
    }
    p = dataEnd
  }
  return { _tag: 'Hello', serverName }
}

/**
 * Whether the server name a hello asks for is the host a `CONNECT` named: the
 * same name, whatever its case, a trailing dot aside.
 */
export const sameServerName = (serverName: string, host: string): boolean =>
  serverName.replace(/\.$/, '').toLowerCase() === host.replace(/\.$/, '').toLowerCase()

/**
 * Where the tunnel may go: exactly these names, or `'any'` public name.
 *
 * `'any'` widens the names and nothing else. Every address a name resolves to
 * is still judged as an address — not inside this host's networks, not one of
 * this host's own — so a guest that may name anything still reaches only the
 * public internet.
 */
export type TunnelScope = readonly string[] | 'any'

/** Whether a scope reaches anything at all. */
export const tunnels = (scope: TunnelScope): boolean => scope === 'any' || scope.length > 0

/**
 * Whether a broker holding `grants` runs the tunnel: when there is somewhere to
 * tunnel to, or a name the broker answers, which a client reaches through the
 * tunnel too.
 */
export const runsTunnel = (grants: readonly Grant[], scope: TunnelScope): boolean =>
  tunnels(scope) || tlsNames(grants).length > 0

/**
 * Whether the allowlist covers this destination.
 *
 * Exact names, no wildcards and no suffix matching. A suffix rule is how
 * `pypi.org.attacker.example` gets reached, and the cost of exactness is that a
 * registry's download host has to be listed beside its index host — which is
 * the honest form of the question anyway, since those are different operators
 * as often as not.
 */
export const allowTunnel = (hosts: TunnelScope, target: Tunnel): Tunnel => {
  if (target._tag === 'Refuse') return target
  if (hosts === 'any') return target
  if (hosts.length === 0) {
    return refuseTunnel(403, 'this VM has no tunnel destinations, so nothing is reachable this way')
  }
  const allowed = hosts.some(host => host.toLowerCase() === target.host)
  return allowed
    ? target
    : refuseTunnel(403, `${target.host} is not a destination this VM may reach`)
}

/**
 * Whether an address is one the guest may be connected to.
 *
 * The allowlist is of names, and a name resolves to whatever its operator says
 * — including, if someone is attacking, an address inside this host's own
 * networks. So the resolved address is checked too, and the connection is made
 * to the address that was checked rather than to the name again, which is what
 * closes the gap between the two lookups.
 *
 * **What this does not cover**: a name on the allowlist that resolves to a
 * routable address which is nonetheless private to a VPN this host is on. Such
 * an address is public by every test available here, and the name was listed
 * deliberately, so it is reachable. Rejecting RFC1918 is not a VPN boundary.
 *
 * An IPv6 address is read to its 128 bits rather than matched as text, because
 * one address has many spellings. Four prefixes carry an IPv4 address in their
 * last 32 bits — `::/96`, `::ffff:0:0/96`, `::ffff:0:0:0/96` and the NAT64
 * prefix `64:ff9b::/96` — and a connection to an address in one of them reaches
 * that IPv4 address, directly or through a translator, so it is judged as that
 * address. Of the rest only global unicast, `2000::/3`, is public;
 * everything else is loopback, link-local, unique local, multicast, the
 * local-use NAT64 prefix or not yet allocated. Within global unicast, 6to4 and
 * Teredo carry an IPv4 address too, where no rule here can find it.
 */
export const isReachableAddress = (address: string): boolean => {
  const v4 = ipv4Octets(address)
  if (v4 !== undefined) return isPublicIpv4(v4)
  if (!address.includes(':')) return false

  const groups = ipv6Groups(address.toLowerCase().split('%')[0] ?? '')
  if (groups === undefined) return false
  const [g0 = 0, g1 = 0, , , g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups
  const zeroFrom = (start: number, end: number): boolean =>
    groups.slice(start, end).every(group => group === 0)
  const carried = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff] as const
  if (zeroFrom(0, 6)) return isPublicIpv4(carried) // `::` and `::1` among them
  if (zeroFrom(0, 5) && g5 === 0xffff) return isPublicIpv4(carried)
  if (zeroFrom(0, 4) && g4 === 0xffff && g5 === 0) return isPublicIpv4(carried)
  if (g0 === 0x64 && g1 === 0xff9b && zeroFrom(2, 6)) return isPublicIpv4(carried)
  if ((g0 & 0xe000) !== 0x2000) return false
  if (g0 === 0x2001 && g1 === 0) return false // Teredo
  if (g0 === 0x2002) return false // 6to4
  return true
}

/** A dotted-quad IPv4 address's four octets, or `undefined` for anything else. */
const ipv4Octets = (address: string): readonly [number, number, number, number] | undefined => {
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address)
  if (quad === null) return undefined
  const octets = [Number(quad[1]), Number(quad[2]), Number(quad[3]), Number(quad[4])] as const
  return octets.some(octet => octet > 255) ? undefined : octets
}

const isPublicIpv4 = ([a, b]: readonly [number, number, number, number]): boolean => {
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 169 && b === 254) return false // link-local, and the cloud metadata address
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 100 && b >= 64 && b <= 127) return false // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return false // benchmarking
  if (a >= 224) return false // multicast, reserved, broadcast
  return true
}

/**
 * An IPv6 address's eight 16-bit groups, or `undefined` for anything that is
 * not one. A `::` stands for at least one group of zeros, and the last 32 bits
 * may be written as a dotted quad.
 */
const ipv6Groups = (address: string): readonly number[] | undefined => {
  const halves = address.split('::')
  if (halves.length > 2) return undefined
  const groupsOf = (part: string, last: boolean): number[] | undefined => {
    if (part === '') return []
    const pieces = part.split(':')
    const groups: number[] = []
    for (const [at, piece] of pieces.entries()) {
      const quad = last && at === pieces.length - 1 ? ipv4Octets(piece) : undefined
      if (quad !== undefined) groups.push((quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3])
      else if (/^[0-9a-f]{1,4}$/.test(piece)) groups.push(Number.parseInt(piece, 16))
      else return undefined
    }
    return groups
  }
  const [before = '', after] = halves
  const head = groupsOf(before, after === undefined)
  if (after === undefined) return head?.length === 8 ? head : undefined
  const tail = groupsOf(after, true)
  if (head === undefined || tail === undefined) return undefined
  const elided = 8 - head.length - tail.length
  return elided >= 1 ? [...head, ...Array.from({ length: elided }, () => 0), ...tail] : undefined
}

/**
 * The addresses a tunnel may try, in the order the resolver gave them.
 *
 * All of the acceptable ones rather than the first, because the first is not
 * necessarily reachable: a host holding an IPv6 address but no IPv6 route is
 * given the AAAA answers first and can connect to none of them, which is
 * indistinguishable from a destination that is down unless the rest are tried.
 */
export const reachableAddresses = (
  addresses: ReadonlyArray<{ readonly address: string }>,
): readonly string[] => addresses.map(entry => entry.address).filter(isReachableAddress)

/** Which family an address belongs to, by the only syntax that separates them. */
export const addressFamily = (address: string): 'v4' | 'v6' => (address.includes(':') ? 'v6' : 'v4')

/**
 * The same addresses, with the family that last worked first.
 *
 * Ordering only — every address is still tried. A host that holds IPv6
 * addresses but cannot reach anything over them otherwise pays one dead
 * attempt per AAAA record on every tunnel it opens, and the wait for a dropped
 * SYN is a second each. Stable within a family, so the resolver's own ordering
 * still decides between addresses of one kind.
 */
export const preferAddressFamily = (
  addresses: readonly string[],
  preferred: 'v4' | 'v6' | undefined,
): readonly string[] =>
  preferred === undefined
    ? addresses
    : [
        ...addresses.filter(address => addressFamily(address) === preferred),
        ...addresses.filter(address => addressFamily(address) !== preferred),
      ]

/**
 * Whether an address is one of this host's own.
 *
 * Asked of the kernel at the moment it matters rather than read from a list:
 * a socket can bind only to an address one of the host's interfaces holds, so
 * a bind to port 0 answers exactly this, for a temporary IPv6 address that
 * appeared a second ago as much as for a fixed one. Listing the interfaces
 * would take a netlink socket, which this process is not allowed.
 *
 * A connection to such an address never leaves the machine, and the host's
 * firewall does not see it, so it reaches every service bound to all
 * addresses. The public-range check above cannot catch it: a host's own
 * address is as public as anyone's.
 *
 * Fails closed. Only "not available here" means not this host; any other
 * error counts as this host's. With `ip_nonlocal_bind` set every bind succeeds,
 * so every address reads as local and nothing is tunnelled — loud, rather than
 * a quiet way in.
 */
export const isHostAddress = (address: string): Promise<boolean> =>
  new Promise(resolve => {
    const socket = createSocket(addressFamily(address) === 'v6' ? 'udp6' : 'udp4')
    socket.once('error', (error: NodeJS.ErrnoException) => {
      try {
        socket.close()
      } catch {
        /* never bound, so there is nothing to close */
      }
      resolve(error.code !== 'EADDRNOTAVAIL')
    })
    socket.bind({ address, port: 0 }, () => {
      socket.close()
      resolve(true)
    })
  })

/**
 * The addresses left once this host's own are removed, in the order given.
 *
 * `isHost` is a parameter so the filtering can be asserted without depending
 * on which addresses the machine running the tests holds.
 */
export const excludeHostAddresses = async (
  addresses: readonly string[],
  isHost: (address: string) => Promise<boolean> = isHostAddress,
): Promise<readonly string[]> => {
  const own = await Promise.all(addresses.map(isHost))
  return addresses.filter((_, at) => own[at] !== true)
}

/**
 * Read the destinations this broker may tunnel to.
 *
 * Fails closed and fails loudly, exactly as `parseGrants` does: a proxy that
 * started having dropped a destination it could not read would serve a narrower
 * policy than the one written down — and unlike a grant, the symptom would be a
 * package manager failing rather than anything naming the cause.
 *
 * A list of names, or the string `"any"`: two JSON types, so a host that
 * happened to be called `any` is a list of one and cannot be mistaken for it.
 */
export const parseTunnelHosts = (
  json: string,
): { hosts: string[] | 'any' } | { message: string } => {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return { message: '--tunnel is not JSON' }
  }
  if (raw === 'any') return { hosts: 'any' }
  if (!Array.isArray(raw)) return { message: '--tunnel must be a JSON array, or "any"' }
  const hosts: Array<string> = []
  for (const host of raw as unknown[]) {
    if (typeof host !== 'string' || !isHostname(host.toLowerCase())) {
      return { message: `${JSON.stringify(host)} is not a hostname` }
    }
    hosts.push(host.toLowerCase())
  }
  return { hosts }
}

/**
 * How long the destination has to accept a connection. Guards against a
 * destination that never answers, which a client would otherwise wait on with
 * no answer at all, where this gives it a 504 naming the destination.
 */
const tunnelConnectTimeoutMs = 10_000

/** How long a ClientHello that has begun may take to arrive whole. */
const tunnelHelloTimeoutMs = 10_000

/**
 * Where a tunnel to an allowed name may connect: the addresses to try in turn,
 * and the port, or a refusal saying why there are none.
 */
export type Destinations = (
  host: string,
  port: number,
) => Promise<
  | { readonly addresses: readonly string[]; readonly port: number }
  | Extract<Tunnel, { _tag: 'Refuse' }>
>

/**
 * Every address a name resolves to that is public and not this host's own.
 *
 * Connect to an address that was checked, not to the name again: resolving
 * twice is resolving to two different answers, which is the whole of a
 * rebinding attack.
 */
export const publicDestinations: Destinations = async (host, port) => {
  const { lookup } = await import('node:dns/promises')
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    return { _tag: 'Refuse', reason: `${host} does not resolve`, status: 502 }
  }
  const inRange = reachableAddresses(addresses)
  if (inRange.length === 0) {
    return {
      _tag: 'Refuse',
      reason: `${host} resolves only to addresses inside this machine's own networks`,
      status: 403,
    }
  }
  const candidates = await excludeHostAddresses(inRange)
  if (candidates.length === 0) {
    return {
      _tag: 'Refuse',
      reason: `${host} resolves only to this machine's own addresses`,
      status: 403,
    }
  }
  return { addresses: candidates, port }
}

/**
 * Reason phrases for the statuses a refused tunnel sends.
 *
 * A client reads the status, not the phrase, so this is for whoever is reading
 * a capture, to whom a gateway failure labelled `Forbidden` would read as a
 * refusal on policy.
 */
const tunnelReasonPhrase: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  405: 'Method Not Allowed',
  502: 'Bad Gateway',
  504: 'Gateway Timeout',
}

/** The upstream's headers a response other than git's does not carry back. */
const unforwardedResponseHeaders: ReadonlySet<string> = new Set([
  // A cookie or a challenge would be for the broker's origin inside the VM,
  // which holds no credential to answer one with.
  'proxy-authenticate',
  'set-cookie',
  'www-authenticate',
  ...hopByHop,
  // About the connection to the provider, which is not the one to the guest.
  'alt-svc',
  // `fetch` has decoded the body, and it is framed afresh as it streams back.
  'content-encoding',
  'content-length',
])

/**
 * The headers returned to the guest.
 *
 * For git, only what git reads, so an upstream cannot set a cookie or an
 * authentication challenge inside the VM. For every other request, the
 * upstream's headers but those in `unforwardedResponseHeaders`: a harness
 * reads its retry delay, its rate limits and the request id it reports from
 * them. A redirect `relay` passes on, an API's or an anonymous read's, keeps
 * its `Location`.
 */
export const responseHeaders = (
  kind: Exclude<Decision['_tag'], 'Deny'>,
  upstream: Headers,
): Headers => {
  if (kind !== 'Git') {
    const headers = new Headers()
    for (const [name, value] of upstream) {
      if (!unforwardedResponseHeaders.has(name)) headers.append(name, value)
    }
    return headers
  }
  const headers = new Headers({ 'Cache-Control': 'no-cache, max-age=0, must-revalidate' })
  const type = upstream.get('Content-Type')
  if (type !== null) headers.set('Content-Type', type)
  return headers
}

/**
 * A `Link` header whose pages a client can follow back to the broker for.
 *
 * GitHub names the next page of a repository's listing by the repository's
 * number, `repositories/<id>/…`, which says which repository it is only after
 * a lookup, and so matches no grant. On an answer for one repository, each such
 * link is put back in the form the request had, `repos/<owner>/<repo>/…`, with
 * the repository as the grant spells it. The rest of each link, its query
 * among it, is left as it is.
 */
export const pagesOf = (link: string, host: string, repo: string): string =>
  link.replaceAll(
    new RegExp(`<https://${host.replaceAll('.', '\\.')}/repositories/\\d+(?=[/?>])`, 'g'),
    `<https://${host}/repos/${repo}`,
  )

/** The headers returned for a decision: `responseHeaders`', and an API read's pages kept here. */
const returnedHeaders = (
  decision: Exclude<Decision, { _tag: 'Deny' }>,
  upstream: Headers,
): Headers => {
  const headers = responseHeaders(decision._tag, upstream)
  const link = headers.get('link')
  if (decision._tag === 'Api' && decision.repo !== undefined && link !== null) {
    headers.set('link', pagesOf(link, decision.host, decision.repo))
  }
  return headers
}

/**
 * How long the upstream has to answer with headers, by what is being asked of it.
 * Guards against an upstream that accepts a request and never answers it, which
 * would leave the guest's request waiting for as long as the guest does.
 *
 * Bounds the wait, not the transfer: a clone streams for as long as it takes, and
 * a byte budget on a packfile would be a size limit on repositories. The wait
 * includes sending the request's body, since an upstream answers once it has
 * it, so this also ends a body that never does. A git fetch's body is its
 * negotiation, kilobytes or a few megabytes, which takes seconds at most.
 *
 * A model call gets minutes rather than seconds because a **non-streaming**
 * request generates its whole answer before any header arrives, so the budget
 * has to cover generation rather than round-trip. A request that needs longer
 * than this is one that should be streaming, where the first byte arrives
 * immediately. A model server's call may wait on its model loading too.
 *
 * A push's body is its pack, as large as what is pushed, and the upstream
 * answers only once it has all of it and has applied it, so a push is given
 * the minutes a model call is. So is an asset's upload, whose body is the
 * asset, for the same reason.
 *
 * A profile's request is given the long wait whatever it is: one rule may
 * cover a model call, a write that waits on the capacity for what it creates
 * and a read alike, and a wait a rule chose would be one more thing a profile
 * could get wrong. The rest, git's fetch, its advertisements, a read through
 * the forge's API and an anonymous read, are given the short one: nothing is
 * generating their answer.
 */
const headerTimeoutMs = { long: 600_000, short: 30_000 } as const

/**
 * Pass a body through, counting it, and report when it ends however it ends.
 *
 * The count and the moment it ends are for the audit line, so both have to
 * survive a guest that disconnects mid-clone — which is why this is a wrapper
 * and not a `TransformStream`, whose `flush` a cancelled stream never reaches.
 */
const counted = (
  source: ReadableStream<Uint8Array>,
  done: (bytes: number) => void,
): ReadableStream<Uint8Array> => {
  const reader = source.getReader()
  let bytes = 0
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    done(bytes)
  }
  return new ReadableStream<Uint8Array>({
    cancel(reason) {
      finish()
      return reader.cancel(reason)
    },
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          controller.close()
          finish()
          return
        }
        bytes += chunk.value.byteLength
        controller.enqueue(chunk.value)
      } catch (error) {
        controller.error(error)
        finish()
      }
    },
  })
}

/** What an audit field holds: a named fact, or a list or record of them. */
type Fact = boolean | number | string | readonly Fact[] | { readonly [key: string]: Fact }

/**
 * One line of audit, as JSON.
 *
 * A fixed set of fields, never a header, a query string or a body. Redaction of
 * arbitrary content is not something this can promise: a guest-supplied header
 * can hold anything, including a credential of its own, so the answer is to
 * record named facts rather than to filter captured text.
 *
 * A field means the same on every line it is on: `credential` and `credentials`
 * name credentials, `host` is the host a request was for, `scope` and `repos`
 * are repositories, `server` is a model server's name, `target` and
 * `destinations` are tunnel destinations, `address` is the address a
 * destination resolved to, `answered` marks a tunnel the broker's TLS listener
 * took rather than a destination, and `names` are the names that listener
 * answers.
 */
const audit = (event: Readonly<Record<string, Fact>>): void => {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...event }))
}

/**
 * An answer of the broker's own, `broker: <message>`: as text, which git prints
 * as `remote: broker: …`, or with `json` as `{"message":"broker: <message>"}`,
 * the shape a forge's API writes its own errors in.
 */
const answer = (
  status: number,
  message: string,
  json: boolean,
  headers: Readonly<Record<string, string>>,
): Response =>
  json
    ? new Response(`${JSON.stringify({ message: `broker: ${message}` })}\n`, {
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
        status,
      })
    : new Response(`broker: ${message}\n`, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers },
        status,
      })

/**
 * A refusal of the broker's own, which asking again will not change.
 *
 * `x-should-retry: false` is for the clients that read it; the others decide by
 * status alone, and retry a 5xx for minutes. So a refusal the guest could see
 * end is a 4xx where one is true, and the 5xx left are the broker's own faults.
 */
const refusal = (status: number, message: string, json = false): Response =>
  answer(status, message, json, { 'x-should-retry': 'false' })

/** A failure that may not happen again, which a client is right to retry. */
const transient = (status: number, message: string, json: boolean): Response =>
  answer(status, message, json, {})

/** How a constructed request is sent: `fetch`, unless a test stands in for the provider. */
type Upstream = (url: string, init: RequestInit) => Promise<Response>

/**
 * Serve one request: decide, by its listener's rule, then construct.
 *
 * The decision is logged before the credential is read, so the audit point never
 * observes the injected value.
 */
const handle = async (
  request: Request,
  grants: readonly Grant[],
  decideFor: (request: Request) => Decision,
  credentials: ReadonlyMap<string, string>,
  id: number,
  send: Upstream,
): Promise<Response> => {
  const decision = decideFor(request)
  if (decision._tag === 'Deny') {
    audit({
      ...decision.asked,
      event: 'deny',
      id,
      reason: decision.reason,
      status: decision.status,
    })
    return refusal(decision.status, decision.reason, decision.json === true)
  }
  // The broker's own answers below are written as its refusals for the same
  // host are.
  const json = jsonNames(grants).includes(decision.host)

  // A GraphQL request is read whole and checked before it is allowed, and the
  // body sent is the one the check wrote.
  const withheld = withheldFrom(decision)
  let written: string | undefined
  if (withheld !== undefined) {
    const whole = await readWhole(request.body, graphqlBodyLimit)
    let text: string | undefined
    try {
      text =
        whole === undefined ? undefined : new TextDecoder('utf-8', { fatal: true }).decode(whole)
    } catch {
      text = undefined
    }
    const query =
      whole === undefined
        ? {
            reason: `a GraphQL request is at most ${String(graphqlBodyLimit)} bytes`,
            status: 413,
          }
        : text === undefined
          ? { reason: 'a GraphQL request is sent as JSON, and this one is not', status: 403 }
          : { ...graphqlQuery(text, withheld), status: 403 }
    if ('reason' in query) {
      audit({ event: 'deny', host: decision.host, id, reason: query.reason, status: query.status })
      return refusal(query.status, query.reason, json)
    }
    written = query.body
  }

  // Which credential pays and what it was expected to cover, both settled by
  // the path: a git request is for a repository, and a model call names its
  // model only in a body that is not parsed.
  const scope = decision._tag === 'Git' || decision._tag === 'Api' ? decision.repo : undefined
  // A model server's grant may hold none, and then the request is sent with
  // none, as the server was configured to take it. An anonymous read is sent
  // with none because no grant covers it.
  const credential = decision._tag === 'Anonymous' ? undefined : decision.credential

  audit({
    ...(credential === undefined ? {} : { credential }),
    event: 'allow',
    host: decision.host,
    id,
    ...(decision._tag === 'Profile'
      ? { profile: decision.profile, rule: decision.rule, set: decision.set }
      : { operation: decision.operation }),
    ...(scope === undefined ? {} : { scope }),
    ...(decision._tag === 'ModelServer' ? { server: decision.server } : {}),
  })

  const token = credential === undefined ? undefined : credentials.get(credential)
  if (credential !== undefined && token === undefined) {
    // Fail closed rather than forwarding without the credential: an authorized
    // request that quietly becomes an anonymous one has changed meaning.
    audit({ event: 'error', id, reason: 'credential not held' })
    return refusal(500, `${credential} was not delivered to this broker`, json)
  }

  const started = Date.now()
  const abort = new AbortController()
  const timer = setTimeout(
    () => {
      abort.abort()
    },
    decision._tag === 'Profile' ||
      decision._tag === 'ModelServer' ||
      decision.operation === 'push' ||
      decision.operation === 'upload'
      ? headerTimeoutMs.long
      : headerTimeoutMs.short,
  )

  const length = uploadLength(decision, request.headers)
  let upstream: Response
  try {
    upstream = await send(decision.upstream, {
      // Streamed as it arrives, never read, and held to its length where it is
      // sent with one — but for a GraphQL request's, read and written above.
      body: !carriesBody(decision)
        ? undefined
        : written !== undefined
          ? written
          : length === undefined || request.body === null
            ? request.body
            : heldTo(request.body, length),
      headers: upstreamHeaders(decision, token, request.headers),
      method: request.method,
      // Never followed. A redirect chosen by the upstream is a destination this
      // grant did not authorize, and following one would send the credential to
      // it.
      redirect: 'manual',
      // Ended by the guest leaving as well as by the timer: a call the guest has
      // given up on would otherwise hold its upstream connection until an answer
      // nobody will read. Bun aborts `request.signal` only for a guest that
      // leaves, so neither returning a response nor streaming one ends the call.
      signal: AbortSignal.any([abort.signal, request.signal]),
    })
  } catch {
    clearTimeout(timer)
    const ms = Date.now() - started
    if (request.signal.aborted) {
      // The guest closed its connection before the upstream answered, which
      // ends the call and a body still being sent. The upstream was not at
      // fault, and there is no one left to answer.
      audit({ event: 'error', id, ms, reason: 'guest disconnected' })
      return refusal(400, 'the request was abandoned', json)
    }
    audit({ event: 'error', id, ms, reason: 'upstream unreachable' })
    return transient(502, `${decision.host} did not answer`, json)
  }
  clearTimeout(timer)

  const ms = Date.now() - started
  const refused = relay(
    { credential, host: decision.host, kind: decision._tag, scope },
    upstream.status,
  )
  if (refused !== undefined) {
    // The upstream's own status is recorded, because what the guest is told and
    // what the upstream said are different facts and the log is where they meet.
    audit({ event: 'error', id, ms, reason: refused.reason, upstream: upstream.status })
    return refusal(refused.status, refused.reason, json)
  }

  if (upstream.body === null) {
    audit({ bytes: 0, event: 'response', id, ms, status: upstream.status })
    return new Response(null, {
      headers: returnedHeaders(decision, upstream.headers),
      status: upstream.status,
    })
  }
  return new Response(
    counted(upstream.body, bytes => {
      audit({ bytes, event: 'response', id, ms, status: upstream.status })
    }),
    { headers: returnedHeaders(decision, upstream.headers), status: upstream.status },
  )
}

/**
 * Make way for a listener at `socketPath`, removing a socket a previous broker
 * left there.
 *
 * A broker killed outright, which is what the kernel does when memory runs
 * out, leaves its socket file behind, and listening on a path that exists
 * fails. Without this, the restart its unit makes would fail the same way
 * every time until the start limit gave up. Only a socket is removed: anything
 * else at the path is not this program's.
 */
const clearStaleSocket = (socketPath: string): void => {
  try {
    if (lstatSync(socketPath).isSocket()) unlinkSync(socketPath)
  } catch {
    /* nothing there */
  }
}

/**
 * What one end of a tunnel has been sent and has not yet accepted, and whether
 * it is to be closed once it has: the other end closing ends this one only
 * after what that end sent is through.
 */
interface Side {
  ending: boolean
  pending: Uint8Array[]
}

/**
 * The request head this will read before giving up on finding one. Guards
 * against a client that never ends its head: a CONNECT head is a line and a
 * few headers, and a client still sending one this long is not sending one.
 */
const maxHeadBytes = 8 * 1024

interface TunnelState {
  bytesIn: number
  bytesOut: number
  client: Side
  /** What has arrived of the request head, until the blank line that ends it. */
  head: Uint8Array
  id: number
  /** Bytes the client sent before the destination was connected. */
  early: Uint8Array[]
  /**
   * The host the session's ClientHello has to name, for a tunnel whose hello
   * is checked, and the guest's bytes held while it is read.
   */
  hello:
    | { readonly host: string; held: Uint8Array; timer: ReturnType<typeof setTimeout> | undefined }
    | undefined
  opened: number
  /**
   * `hello` is a connected tunnel whose guest's bytes are held until the
   * ClientHello they begin is read; the destination's reach the guest
   * meanwhile.
   */
  phase: 'head' | 'opening' | 'hello' | 'piping' | 'done'
  /** `host:port`, once a CONNECT line has named one, and `-` until then. */
  target: string
  upstream: Side
  upstreamSocket: import('bun').Socket<unknown> | undefined
}

/**
 * Write to `socket` what it will take and hold the rest, and stop reading from
 * `source`, where the bytes came from, while anything is held.
 *
 * That is what bounds a tunnel whose two ends run at different speeds: the
 * faster sender meets the slower reader's pace as TCP's own backpressure,
 * rather than as a buffer here growing at the sender's pace. A few chunks may
 * still arrive after the pause, already read, and are held too.
 */
const push = (
  socket: import('bun').Socket<unknown>,
  side: Side,
  chunk: Uint8Array,
  source: import('bun').Socket<unknown>,
): void => {
  if (side.pending.length === 0) {
    const written = socket.write(chunk)
    if (written >= chunk.byteLength) return
    side.pending.push(chunk.subarray(Math.max(0, written)))
  } else {
    side.pending.push(chunk)
  }
  source.pause()
}

/**
 * Write what was held, once `socket` says it can take more, and read from
 * `source` again once nothing is — or close `socket`, if its other end has
 * closed.
 */
const flush = (
  socket: import('bun').Socket<unknown>,
  side: Side,
  source: import('bun').Socket<unknown> | undefined,
): void => {
  while (side.pending.length > 0) {
    const chunk = side.pending[0]
    if (chunk === undefined) break
    const written = socket.write(chunk)
    if (written < chunk.byteLength) {
      side.pending[0] = chunk.subarray(Math.max(0, written))
      return
    }
    side.pending.shift()
  }
  if (side.ending) socket.end()
  else source?.resume()
}

/** Close `socket` once what is held for it is written, or now if nothing is. */
const endWhenWritten = (socket: import('bun').Socket<unknown>, side: Side): void => {
  if (side.pending.length === 0) socket.end()
  else side.ending = true
}

/**
 * Serve the tunnel: one raw listener, CONNECT and nothing else.
 *
 * Every refusal is written as an HTTP response and the socket closed, because
 * that is what a proxy client understands — a dropped connection reads as a
 * broken proxy rather than as a policy decision, and the difference is the whole
 * point of telling someone their destination is not allowed.
 *
 * As many tunnels at once as the guest opens: a package manager downloading in
 * parallel opens dozens, and from the host would be bounded by nothing but the
 * machine. `destinations` is a parameter so that a tunnel can be asserted
 * against a destination a test runs.
 *
 * `answered` names the hosts the broker answers itself, and the socket of the
 * TLS listener that does: a CONNECT to one of them is joined to that listener
 * rather than to the host, whatever `hosts` says, so that what reaches the
 * host is a request the broker constructed.
 *
 * Under a list of names, the ClientHello of each session has to name the host
 * its `CONNECT` did (`readHello`), and one that has begun has `helloDeadlineMs`
 * to arrive whole, a parameter for the same reason as `destinations`.
 */
export const serveTunnel = (
  socketPath: string,
  hosts: TunnelScope,
  destinations: Destinations = publicDestinations,
  answered?: { readonly names: readonly string[]; readonly socket: string },
  helloDeadlineMs = tunnelHelloTimeoutMs,
): import('bun').UnixSocketListener<TunnelState> => {
  let opened = 0
  // Learned rather than configured: which families a host can actually use
  // differs per host, and can change under a broker that is already running.
  let preferredFamily: 'v4' | 'v6' | undefined

  const finish = (state: TunnelState, why: string): void => {
    if (state.phase === 'done') return
    state.phase = 'done'
    audit({
      bytesIn: state.bytesIn,
      bytesOut: state.bytesOut,
      event: 'tunnel-close',
      id: state.id,
      ms: Date.now() - state.opened,
      reason: why,
      target: state.target,
    })
  }

  const refuseClient = (
    client: import('bun').Socket<TunnelState>,
    status: number,
    reason: string,
  ): void => {
    audit({
      event: 'tunnel-deny',
      id: client.data.id,
      reason,
      status,
      ...(client.data.target === '-' ? {} : { target: client.data.target }),
    })
    client.write(
      `HTTP/1.1 ${String(status)} ${tunnelReasonPhrase[status] ?? 'Forbidden'}\r\n` +
        `Content-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\nbroker: ${reason}\n`,
    )
    client.data.phase = 'done'
    client.end()
  }

  /**
   * Close a tunnel that is open, for a session it will not carry: both ends,
   * with nothing of the guest's sent on. Past the 200 there is no response to
   * write, since the guest is speaking TLS by then.
   */
  const closeHello = (client: import('bun').Socket<TunnelState>, reason: string): void => {
    if (client.data.hello?.timer !== undefined) clearTimeout(client.data.hello.timer)
    audit({ event: 'tunnel-deny', id: client.data.id, reason, target: client.data.target })
    client.data.phase = 'done'
    client.data.upstreamSocket?.end()
    client.end()
  }

  /**
   * Add the guest's next bytes to the ClientHello being held, and decide once
   * it is whole: splice a session whose hello names the `CONNECT` host, or
   * that is not TLS, and close any other.
   *
   * A session that is not TLS is spliced because ssh is carried over port 443
   * (`ssh.github.com`), and refusing it would break that. It reaches only the
   * listed name's addresses, with whatever `Host` it sends, which is no more
   * than a TLS session can say inside the encryption, where nothing here
   * reads. Only a hello that has begun has a deadline: until the guest sends
   * a byte, a protocol whose server speaks first is waiting on the
   * destination, whose bytes reach the guest meanwhile.
   */
  const readHello = (client: import('bun').Socket<TunnelState>, chunk: Uint8Array): void => {
    const state = client.data
    const hello = state.hello
    const upstream = state.upstreamSocket
    if (state.phase !== 'hello' || hello === undefined || upstream === undefined) return
    const held = new Uint8Array(hello.held.byteLength + chunk.byteLength)
    held.set(hello.held)
    held.set(chunk, hello.held.byteLength)
    hello.held = held
    const read = readClientHello(held)
    if (read._tag === 'More') {
      if (held.byteLength > maxClientHelloBytes + 1024) {
        closeHello(client, 'the TLS ClientHello is larger than any client sends')
        return
      }
      hello.timer ??= setTimeout(() => {
        if (state.phase === 'hello') closeHello(client, 'no whole TLS ClientHello arrived')
      }, helloDeadlineMs)
      return
    }
    if (read._tag === 'Malformed') {
      closeHello(client, `the TLS ClientHello is malformed: ${read.reason}`)
      return
    }
    if (read._tag === 'Hello' && read.serverName === undefined) {
      closeHello(client, `the TLS ClientHello names no server, so it is not one for ${hello.host}`)
      return
    }
    if (read._tag === 'Hello' && !sameServerName(read.serverName ?? '', hello.host)) {
      closeHello(client, `the TLS ClientHello names another server than ${hello.host}`)
      return
    }
    if (hello.timer !== undefined) clearTimeout(hello.timer)
    hello.held = new Uint8Array()
    state.phase = 'piping'
    state.bytesOut += held.byteLength
    push(upstream, state.upstream, held, client)
  }

  const connectUpstream = async (
    client: import('bun').Socket<TunnelState>,
    decided: Extract<Tunnel, { _tag: 'Open' }>,
  ): Promise<void> => {
    // A name the broker answers is joined to its TLS listener, which nothing
    // has to resolve. Any other is connected to the addresses it resolves to.
    let candidates: ReadonlyArray<string | { readonly unix: string }>
    let port = decided.port
    if (answered?.names.includes(decided.host) === true) {
      candidates = [{ unix: answered.socket }]
    } else {
      const found = await destinations(decided.host, decided.port)
      if ('_tag' in found) {
        refuseClient(client, found.status, found.reason)
        return
      }
      candidates = preferAddressFamily(found.addresses, preferredFamily)
      port = found.port
    }

    // One deadline for the whole sequence below, not one per attempt: a name
    // with eight addresses must not get eight times the budget.
    const timer = setTimeout(() => {
      if (client.data.phase === 'opening')
        refuseClient(client, 504, `${decided.host} did not answer`)
    }, tunnelConnectTimeoutMs)

    const handlers: import('bun').SocketHandler = {
      close() {
        finish(client.data, 'destination closed')
        endWhenWritten(client, client.data.client)
      },
      data(socket, chunk) {
        // The guest has gone, so there is nowhere for it to go.
        if (client.data.phase === 'done') return
        client.data.bytesIn += chunk.byteLength
        push(client, client.data.client, chunk, socket)
      },
      drain(socket) {
        flush(socket, client.data.upstream, client)
      },
      error() {
        finish(client.data, 'destination error')
        client.end()
      },
      open() {
        /* nothing: the 200 is written below, once this resolves */
      },
    }

    // Each candidate in turn. The first address is not necessarily one this
    // host can reach — a host holding an IPv6 address but no IPv6 route is
    // given the AAAA answers first and can connect to none of them — so
    // stopping at the first failure reports a reachable destination as dead.
    for (const candidate of candidates) {
      if (client.data.phase !== 'opening') break
      try {
        const upstream = await (typeof candidate === 'string'
          ? Bun.connect({ hostname: candidate, port, socket: handlers })
          : Bun.connect({ socket: handlers, unix: candidate.unix }))
        clearTimeout(timer)
        if (client.data.phase !== 'opening') {
          upstream.end()
          return
        }
        if (typeof candidate === 'string') preferredFamily = addressFamily(candidate)
        client.data.upstreamSocket = upstream
        client.data.phase = client.data.hello === undefined ? 'piping' : 'hello'
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        audit({
          ...(typeof candidate === 'string' ? { address: candidate } : { answered: true }),
          event: 'tunnel-open',
          id: client.data.id,
          target: client.data.target,
        })
        // Whatever arrived after the head — a TLS hello sent without waiting
        // for the 200, with the head or while connecting — goes first, in order.
        const early = client.data.early
        client.data.early = []
        if (client.data.phase === 'hello') {
          for (const chunk of early) readHello(client, chunk)
          if (client.data.phase === 'hello') client.resume()
          return
        }
        for (const chunk of early) {
          client.data.bytesOut += chunk.byteLength
          push(upstream, client.data.upstream, chunk, client)
        }
        if (client.data.upstream.pending.length === 0) client.resume()
        return
      } catch {
        /* the next candidate, and a refusal below once none are left */
      }
    }

    clearTimeout(timer)
    if (client.data.phase === 'opening') {
      refuseClient(
        client,
        502,
        typeof candidates[0] === 'string'
          ? `${decided.host} refused a connection on every address it resolves to`
          : `the broker's own listener for ${decided.host} refused the connection`,
      )
    }
  }

  clearStaleSocket(socketPath)
  return Bun.listen<TunnelState>({
    socket: {
      close(client) {
        if (client.data.hello?.timer !== undefined) clearTimeout(client.data.hello.timer)
        finish(client.data, 'the guest closed')
        const { upstream, upstreamSocket } = client.data
        if (upstreamSocket !== undefined) endWhenWritten(upstreamSocket, upstream)
      },
      data(client, chunk) {
        const state = client.data
        if (state.phase === 'piping') {
          state.bytesOut += chunk.byteLength
          if (state.upstreamSocket !== undefined) {
            push(state.upstreamSocket, state.upstream, chunk, client)
          }
          return
        }
        if (state.phase === 'hello') {
          readHello(client, chunk)
          return
        }
        if (state.phase === 'opening') {
          state.early.push(chunk)
          return
        }
        if (state.phase !== 'head') return

        const received = new Uint8Array(state.head.byteLength + chunk.byteLength)
        received.set(state.head)
        received.set(chunk, state.head.byteLength)
        const split = splitHead(received)
        if (split === undefined) {
          state.head = received
          if (received.byteLength > maxHeadBytes)
            refuseClient(client, 400, 'no request head arrived')
          return
        }
        const asked = parseConnect(split.line)
        // Before it is judged, so that a refusal records which destination it
        // refused.
        if (asked._tag === 'Open') state.target = `${asked.host}:${String(asked.port)}`
        // A name the broker answers goes to its own listener whatever the
        // destinations are: what reaches that host is what a grant allows.
        const ownName = asked._tag === 'Open' && answered?.names.includes(asked.host) === true
        const decided = ownName ? asked : allowTunnel(hosts, asked)
        if (decided._tag === 'Refuse') {
          refuseClient(client, decided.status, decided.reason)
          return
        }
        // Under a list of names, the session has to be for the name listed:
        // a CDN serving many sites from the same addresses picks the site by
        // the hello's server name, so a listed name could otherwise carry
        // one that is not. With any public name allowed, a guest could as
        // well have named the other site here, so nothing is held for it; nor
        // for a name the broker answers, whose listener reads the name itself.
        if (hosts !== 'any' && !ownName) {
          state.hello = { held: new Uint8Array(), host: decided.host, timer: undefined }
        }
        state.phase = 'opening'
        // Nothing more is read until there is somewhere to send it.
        client.pause()
        if (split.rest.byteLength > 0) state.early.push(split.rest)
        void connectUpstream(client, decided)
      },
      drain(client) {
        flush(client, client.data.client, client.data.upstreamSocket)
      },
      error(client) {
        finish(client.data, 'guest error')
        client.data.upstreamSocket?.end()
      },
      open(client) {
        opened++
        client.data = {
          bytesIn: 0,
          bytesOut: 0,
          client: { ending: false, pending: [] },
          early: [],
          head: new Uint8Array(),
          hello: undefined,
          id: opened,
          opened: Date.now(),
          phase: 'head',
          target: '-',
          upstream: { ending: false, pending: [] },
          upstreamSocket: undefined,
        }
      },
    },
    unix: socketPath,
  })
}

/**
 * Numbers the requests a broker serves. One is shared by both of a broker's
 * listeners, so that an id in the log names one request.
 */
export const requestIds = (): (() => number) => {
  let last = 0
  return () => ++last
}

/** A TLS listener's certificate and key, as PEM. */
export interface TlsIdentity {
  readonly cert: string
  readonly key: string
}

/**
 * Serve brokered requests: one HTTP listener, deciding and constructing each
 * request in turn.
 *
 * As many at once as the guest sends: a harness running subagents or tools in
 * parallel sends that many requests, and from the host it would be bounded by
 * nothing but the machine.
 *
 * `send` is a parameter so that serving can be asserted without a provider to
 * send to.
 */
export const serveRequests = (
  socketPath: string,
  grants: readonly Grant[],
  credentials: ReadonlyMap<string, string>,
  send: Upstream = fetch,
  ids: () => number = requestIds(),
): import('bun').Server<undefined> =>
  listen(socketPath, request => decide(grants, request.method, request.url), {
    credentials,
    grants,
    ids,
    send,
  })

/**
 * Serve brokered requests over TLS, for the names `tlsNames` gives: the
 * listener the tunnel hands a connection to one of them to. Decided by
 * `decideAddressed`, and served as `serveRequests` serves.
 *
 * Nothing in the guest reaches it but through the tunnel, so it is the tunnel
 * that decides a connection gets here at all. `reach` is the tunnel's scope,
 * which decides whether a read no grant covers is sent on without a
 * credential.
 */
export const serveTls = (
  socketPath: string,
  grants: readonly Grant[],
  credentials: ReadonlyMap<string, string>,
  tls: TlsIdentity,
  reach: TunnelScope,
  send: Upstream = fetch,
  ids: () => number = requestIds(),
): import('bun').Server<undefined> =>
  listen(socketPath, request => decideAddressed(grants, request.method, request.url, reach), {
    credentials,
    grants,
    ids,
    send,
    tls,
  })

const listen = (
  socketPath: string,
  decideFor: (request: Request) => Decision,
  options: {
    readonly credentials: ReadonlyMap<string, string>
    readonly grants: readonly Grant[]
    readonly ids: () => number
    readonly send: Upstream
    readonly tls?: TlsIdentity
  },
): import('bun').Server<undefined> => {
  const { credentials, grants, ids, send, tls } = options
  clearStaleSocket(socketPath)

  // @ts-expect-error Bun's types declare `idleTimeout` only for a TCP listener.
  // It applies to a unix socket as well, which the tests of this function assert.
  return Bun.serve({
    fetch(request) {
      const id = ids()
      return handle(request, grants, decideFor, credentials, id, send).catch(error => {
        audit({ event: 'error', id, reason: String(error) })
        return refusal(500, 'the request could not be completed')
      })
    },
    // Off. Bun's default closes a connection that has had nothing written to
    // it for ten seconds. That ends a ref advertisement still waiting on its
    // upstream long before `headerTimeoutMs` would, and a token stream that
    // pauses while the model works, which nothing here means to bound.
    idleTimeout: 0,
    // Unbounded, so that the limit a body meets is its upstream's, as
    // `profiles` says. Bun's default would refuse a body past 128 MiB with a
    // bare 413, before any of this file runs.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    ...(tls === undefined ? {} : { tls }),
    unix: socketPath,
  })
}

/** A grant as the log records it, in the fields `audit` gives each fact. */
const grantFacts = (grant: Grant): Readonly<Record<string, Fact>> =>
  isModelServerGrant(grant)
    ? {
        ...(grant.credential === undefined ? {} : { credential: grant.credential }),
        port: grant.port,
        profile: grant.profile,
        server: grant.name,
      }
    : isGitGrant(grant)
      ? { credential: grant.credential, profile: grant.profile, repos: grant.repos }
      : {
          credential: grant.credential,
          hosts: Object.keys(grant.hosts).toSorted(),
          profile: grant.profile,
          sets: [
            ...new Set(Object.values(grant.hosts).flatMap(at => at.allow.map(rule => rule.set))),
          ].toSorted(),
        }

const main = (): void => {
  const argv = process.argv.slice(2)
  const socketPath = argv[0]
  if (socketPath === undefined || socketPath === '' || socketPath.startsWith('-')) {
    console.error(`broker: ${usage}`)
    process.exit(64)
  }

  let grants: readonly Grant[] = []
  let proxyPath: string | undefined
  let tlsPath: string | undefined
  let tunnelHosts: TunnelScope = []
  for (let at = 1; at < argv.length; at += 2) {
    const flag = argv[at]
    const value = argv[at + 1]
    if (value === undefined) {
      console.error(`broker: ${usage}`)
      process.exit(64)
    }
    if (flag === '--grants') {
      const parsed = parseGrants(value)
      if ('message' in parsed) {
        console.error(`broker: ${parsed.message}`)
        process.exit(78)
      }
      grants = parsed.grants
    } else if (flag === '--proxy') {
      proxyPath = value
    } else if (flag === '--tls') {
      tlsPath = value
    } else if (flag === '--tunnel') {
      const parsed = parseTunnelHosts(value)
      if ('message' in parsed) {
        console.error(`broker: ${parsed.message}`)
        process.exit(78)
      }
      tunnelHosts = parsed.hosts
    } else {
      console.error(`broker: ${usage}`)
      process.exit(64)
    }
  }

  /**
   * Held in memory for the process's lifetime and nowhere else. systemd put them
   * on a tmpfs it removes when the unit stops; this copy goes when the process
   * does.
   */
  const credentials = new Map<string, string>()
  const directory = process.env['CREDENTIALS_DIRECTORY']
  if (directory !== undefined && directory !== '') {
    for (const name of readdirSync(directory)) {
      credentials.set(name, readFileSync(`${directory}/${name}`, 'utf8'))
    }
  }

  // The TLS listener's own identity, out of the map the grants name
  // credentials from before anything is served.
  const cert = credentials.get(tlsCertificateCredential)
  const key = credentials.get(tlsKeyCredential)
  credentials.delete(tlsCertificateCredential)
  credentials.delete(tlsKeyCredential)
  if (tlsPath !== undefined && (cert === undefined || key === undefined)) {
    console.error(
      `broker: --tls needs ${tlsCertificateCredential} and ${tlsKeyCredential}, which were not loaded`,
    )
    process.exit(78)
  }

  for (const grant of grants) {
    if (grant.credential === undefined || credentials.has(grant.credential)) continue
    console.error(
      `broker: the ${isModelServerGrant(grant) ? `${grant.name} model-server` : grant.profile} grant needs ${grant.credential}, which was not loaded`,
    )
    process.exit(78)
  }

  const ids = requestIds()
  const server = serveRequests(socketPath, grants, credentials, fetch, ids)

  // Before the tunnel, which hands it connections.
  const answered =
    tlsPath === undefined || cert === undefined || key === undefined
      ? undefined
      : {
          names: tlsNames(grants),
          server: serveTls(tlsPath, grants, credentials, { cert, key }, tunnelHosts, fetch, ids),
          socket: tlsPath,
        }
  if (answered !== undefined) {
    audit({ event: 'tls-listening', names: answered.names, socket: answered.socket })
  }

  if (proxyPath !== undefined && proxyPath !== '') {
    serveTunnel(proxyPath, tunnelHosts, publicDestinations, answered)
    audit({ destinations: tunnelHosts, event: 'tunnel-listening', socket: proxyPath })
  }

  // The readiness line, and the one place every credential name appears.
  audit({
    credentials: [...credentials.keys()].toSorted(),
    event: 'listening',
    grants: grants.map(grantFacts),
    socket: socketPath,
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void server.stop(true)
      void answered?.server.stop(true)
      process.exit(0)
    })
  }
}

if (import.meta.main) main()
