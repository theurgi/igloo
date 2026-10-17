/**
 * The per-VM credential broker: one process, holding one project's credentials,
 * listening on a Unix socket that only its own VM can reach through a forward
 * the host opened.
 *
 * What it will do is a list of grants, passed as an argument. A broker with no
 * grants refuses everything, and that is a configuration rather than a stub: it
 * holds no upstream it is authorized to construct a request to.
 *
 * There are two kinds of profile. `github` fetches over git's smart HTTP
 * protocol from a fixed set of repositories; `anthropic-messages` and
 * `openrouter` call a provider's models. Beside them, a `model-server` grant
 * calls a model server on this host's loopback, at a port the grant names. In
 * each case the upstream request is *constructed* — from a fixed template and
 * the grant's own copy of what it permits — so nothing a guest sends reaches
 * the upstream URL, and the credential header, where there is one, is always
 * this file's. A git request's other headers are built here too; an inference
 * or model server request carries the guest's, less its credentials and what
 * describes its connection. That makes absolute-form
 * targets, a `Host` that disagrees with the URL and a colliding `Authorization`
 * into consequences of the shape rather than checks that could be forgotten.
 *
 * A request is authorized by its path alone, and on the TLS listener by the name
 * it was addressed to as well, which stands where the path form puts the host.
 * Its body is streamed upstream as it arrives and never read: what a provider
 * does with it, the tools it runs on a model's behalf included, is the
 * provider's.
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
 * The upstream each profile reaches, and what kind of policy applies there.
 *
 * The host is fixed by the profile rather than configured, so a grant cannot
 * name a destination: what a profile knows about an upstream — that it speaks
 * git's smart HTTP, that it takes a token in the username slot — is knowledge
 * about that one host, and pointing it somewhere else would carry the knowledge
 * without the host it was true of. A model server is the one upstream a grant
 * places, and it is placed no further than a port: see `ModelServerGrant`.
 *
 * The kind decides which half of this file answers a request: a `git` profile
 * fetches from the repositories a grant lists, and reads its forge's API, at
 * `api`, for them; an `inference` profile calls the endpoints
 * `inferenceEndpoints` lists.
 *
 * No profile limits a body's size. A body is streamed, so the broker holds
 * little of it at once however large it is, and the upstream's own limit is
 * the one that applies: an inference provider's refusal reaches the guest as
 * the provider gave it. A body that never ends is ended by `headerTimeoutMs`,
 * or by an upstream that answers before it has all of it.
 */
export const profiles = {
  // Anthropic's own, for the messages endpoint and for counting tokens.
  'anthropic-messages': { host: 'api.anthropic.com', kind: 'inference' },
  github: { api: 'api.github.com', host: 'github.com', kind: 'git' },
  openrouter: { host: 'openrouter.ai', kind: 'inference' },
} as const

export type ProfileName = keyof typeof profiles

export type InferenceProfile = {
  [K in ProfileName]: (typeof profiles)[K]['kind'] extends 'inference' ? K : never
}[ProfileName]

export const isProfileName = (value: unknown): value is ProfileName =>
  typeof value === 'string' && Object.hasOwn(profiles, value)

/**
 * Whether a profile is one that calls a model.
 *
 * A predicate rather than a comparison at each call site, because narrowing the
 * name is what lets a grant be built for it without an assertion — and an
 * assertion is exactly the thing that would keep compiling if a third kind of
 * profile were added.
 */
export const isInferenceProfile = (name: ProfileName): name is InferenceProfile =>
  profiles[name].kind === 'inference'

/** Every profile there is, for a message that has to list them. */
export const profileNames: readonly string[] = Object.keys(profiles)

/**
 * The names a git profile is answered at: its host and its API's. A guest's
 * client reaches each by its own name, through the tunnel, which hands the
 * connection to the broker's TLS listener rather than to the host. A remote
 * then reads as the repository's own URL, which is how a client that reads
 * remotes recognises one, and a URL the API gives in an answer leads back to
 * the broker, which is where a client that follows one goes.
 */
const answeredAt = (profile: GitGrant['profile']): readonly string[] => [
  profiles[profile].host,
  profiles[profile].api,
]

/** Every name a broker may answer TLS for, which its certificate covers. */
export const tlsNamesCovered: readonly string[] = [
  ...new Set(
    profileNames
      .filter(isProfileName)
      .filter((name): name is GitGrant['profile'] => profiles[name].kind === 'git')
      .flatMap(answeredAt),
  ),
]

/**
 * Fetch over git's smart HTTP, and read through the forge's API, for a fixed
 * set of repositories. At most one per profile: a request to the API may name
 * no repository, so nothing in it could choose between two.
 *
 * `repos` is the broker's own copy of what is permitted. It is compared against
 * a request, never built from one.
 */
export interface GitGrant {
  /** The credential to inject, under the name systemd loaded it as. */
  readonly credential: string
  readonly profile: 'github'
  /** `owner/repo`, the complete set this grant may fetch and read. */
  readonly repos: readonly string[]
}

/**
 * Call a model provider, whichever of its models a request names.
 *
 * Which models a key may call and what it may spend are limits the provider
 * sets on the key itself, where they bound the total rather than one request.
 * At most one per profile: a request names no credential, so nothing in it
 * could choose between two.
 */
export interface InferenceGrant {
  readonly credential: string
  readonly profile: InferenceProfile
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

export type Grant = GitGrant | InferenceGrant | ModelServerGrant

/** Anything whose fields can be read by name: a non-null object, an array included. */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const isModelServerGrant = (grant: Grant): grant is ModelServerGrant =>
  grant.profile === 'model-server'

export const isInferenceGrant = (grant: Grant): grant is InferenceGrant =>
  !isModelServerGrant(grant) && profiles[grant.profile].kind === 'inference'

export const isGitGrant = (grant: Grant): grant is GitGrant =>
  !isModelServerGrant(grant) && profiles[grant.profile].kind === 'git'

/** The names a broker holding `grants` answers TLS for: each git grant's, once. */
export const tlsNames = (grants: readonly Grant[]): readonly string[] => [
  ...new Set(grants.filter(isGitGrant).flatMap(grant => answeredAt(grant.profile))),
]

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

/**
 * The two requests git makes to fetch over HTTP, and the provider endpoints a
 * grant may reach.
 */
export type GitOperation = 'fetch' | 'ls-refs'

export type InferenceOperation =
  | 'chat-completions'
  | 'count-tokens'
  | 'list-models'
  | 'messages'
  | 'responses'

export type ModelServerOperation = Extract<
  InferenceOperation,
  'chat-completions' | 'list-models' | 'responses'
>

/**
 * A read on a name the broker answers that no grant covers: git's two fetch
 * requests, or anything else read with GET or HEAD.
 */
export type AnonymousOperation = GitOperation | 'read'

/** A request through a forge's API: a read under a repository, or a GraphQL query. */
export type ApiOperation = 'graphql' | 'read'

export type Operation = AnonymousOperation | ApiOperation | InferenceOperation

/**
 * Where a request is going, once it is known to be one this broker serves.
 *
 * Split by kind rather than carrying one `Allow` with optional fields, because
 * a git request is for one repository and an inference request names none, and
 * the headers each sends and returns are built differently. A model server's
 * request is built as an inference one is, and goes to a server the grant
 * names, with a credential only if the grant holds one. An anonymous one goes
 * to the host it was addressed to with no credential at all.
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
      readonly _tag: 'Inference'
      readonly credential: string
      readonly host: string
      readonly operation: InferenceOperation
      readonly profile: InferenceProfile
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
      /** The repository as the *grant* spells it, for a read under one. */
      readonly repo?: string
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

/**
 * The form two spellings of one repository are compared in. GitHub treats owner
 * and repository names case-insensitively, so a grant for `owner/repo` covers a
 * clone of `Owner/Repo` — but the *upstream* URL is built from the grant's
 * spelling, so this normalisation never decides what is requested.
 */
/** Whether `repo` names a repository a grant may hold: `owner/repo`, with or without `.git`. */
export const isRepo = (repo: string): boolean => REPO.test(withoutGit(repo))

export const normaliseRepo = (repo: string): string => withoutGit(repo).toLowerCase()

/** The fields a grant of each kind carries. */
const grantFields = {
  git: new Set(['credential', 'profile', 'repos']),
  inference: new Set(['credential', 'profile']),
  'model-server': new Set(['credential', 'name', 'port', 'profile']),
} as const

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
        message: `unknown profile ${JSON.stringify(profile)}; the profiles are ${profileNames.join(', ')}`,
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

    if (!isInferenceProfile(profile)) {
      if (!Array.isArray(repos) || repos.length === 0) {
        return { message: `the ${profile} grant names no repositories` }
      }
      const named: Array<string> = []
      for (const repo of repos as unknown[]) {
        if (typeof repo !== 'string' || !isRepo(repo)) {
          return { message: `${JSON.stringify(repo)} is not owner/repo` }
        }
        named.push(repo)
      }
      grants.push({ credential, profile, repos: named })
      continue
    }

    grants.push({ credential, profile })
  }
  return { grants }
}

/**
 * How a client inside the guest is pointed at this broker, per inference
 * profile: the variable holding the base URL, and the variable holding what the
 * client believes is its key.
 *
 * The base path is what each provider's own client appends its endpoint to, so
 * the two halves meet at the paths `inferenceEndpoints` lists — an Anthropic
 * client appends `v1/messages` to its base, an OpenAI-shaped one appends
 * `chat/completions` to a base that already ends in `api/v1`.
 *
 * `provider` is the name pi, omp and opencode give the provider in their own
 * configuration, which is where they take a base URL from: none of them reads
 * `urlVariable`. opencode's Anthropic client appends `messages` to a base that
 * ends in `v1`, so its base takes `opencodeSuffix`.
 */
const guestIngress: Readonly<
  Record<
    InferenceProfile,
    {
      readonly basePath: string
      readonly keyVariable: string
      readonly opencodeSuffix: string
      readonly provider: string
      readonly urlVariable: string
    }
  >
> = {
  'anthropic-messages': {
    basePath: 'api.anthropic.com',
    keyVariable: 'ANTHROPIC_API_KEY',
    opencodeSuffix: '/v1',
    provider: 'anthropic',
    urlVariable: 'ANTHROPIC_BASE_URL',
  },
  openrouter: {
    basePath: 'openrouter.ai/api/v1',
    keyVariable: 'OPENROUTER_API_KEY',
    opencodeSuffix: '',
    provider: 'openrouter',
    urlVariable: 'OPENROUTER_BASE_URL',
  },
}

/** The inference grants' ingress, each with the base URL a client is given. */
const ingressFor = (grants: readonly Grant[], port: number) =>
  grants.filter(isInferenceGrant).map(grant => {
    const ingress = guestIngress[grant.profile]
    return { ...ingress, base: `http://127.0.0.1:${String(port)}/${ingress.basePath}` }
  })

/**
 * What the guest is told, so that an unmodified client reaches the broker.
 *
 * The key variable is set to a **placeholder**, and that is load-bearing rather
 * than tidy: a provider client refuses to construct itself with no key at all,
 * so a VM that deliberately holds no key still needs something in the variable
 * for a request to be made — the broker replaces it with the real one, which
 * never leaves the host. Anything reading it inside the guest learns nothing.
 *
 * The base URL variables are read by Claude Code, and by anything configured by
 * hand from their value. opencode takes the same URLs from the file
 * `OPENCODE_CONFIG` names, which it merges over the user's own configuration.
 *
 * Every value is plain text with no `"` or `\`: NixOS writes these into a shell
 * script and a PAM file inside double quotes, unescaped, so a quote in a value
 * ends it. That is why opencode's configuration is a file and not a variable.
 *
 * This is content, not policy. A module that unsets these makes a client talk to
 * the provider directly, with a placeholder for a key, and fail. It cannot make
 * a credential reachable, which is the thing worth protecting.
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

export const guestEnvironment = (
  grants: readonly Grant[],
  port: number,
): Record<string, string> => {
  const environment: Record<string, string> = {}
  const ingress = ingressFor(grants, port)
  if (ingress.length > 0) environment['OPENCODE_CONFIG'] = `/etc/${opencodeConfig}`
  for (const each of ingress) {
    environment[each.urlVariable] = each.base
    environment[each.keyVariable] = guestPlaceholderKey
  }
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

/** Where under `/etc` the guest holds opencode's configuration. */
const opencodeConfig = 'igloo/opencode.json'

/**
 * Files the guest holds under `/etc`, by path relative to it: opencode's
 * configuration, naming the broker as each granted provider's base. Part of the
 * system, so rebuilt on every boot.
 */
export const guestEtcFiles = (grants: readonly Grant[], port: number): Record<string, string> => {
  const ingress = ingressFor(grants, port)
  if (ingress.length === 0) return {}
  return {
    [opencodeConfig]: `${JSON.stringify(
      {
        provider: Object.fromEntries(
          ingress.map(each => [
            each.provider,
            { options: { baseURL: each.base + each.opencodeSuffix } },
          ]),
        ),
      },
      undefined,
      2,
    )}\n`,
  }
}

/** A file written into the guest's home at boot, for a client installed there. */
export interface GuestClientFile {
  readonly content: string
  /** Relative to the home directory. */
  readonly path: string
  /** The client that reads it, by the name it is installed under. */
  readonly program: string
}

/**
 * Configuration for the clients that take a base URL from a file in the home
 * directory and nowhere else: pi's `models.json` and omp's `models.yml`, each
 * naming the broker as its providers' base. One text serves both, since JSON is
 * YAML too.
 *
 * Written only where no such file exists, so a user's own is never replaced;
 * the broker's address is fixed, so a file written once stays right.
 */
export const guestClientFiles = (grants: readonly Grant[], port: number): GuestClientFile[] => {
  const ingress = ingressFor(grants, port)
  if (ingress.length === 0) return []
  const content = `${JSON.stringify(
    { providers: Object.fromEntries(ingress.map(each => [each.provider, { baseUrl: each.base }])) },
    undefined,
    2,
  )}\n`
  return [
    { content, path: '.pi/agent/models.json', program: 'pi' },
    { content, path: '.omp/agent/models.yml', program: 'omp' },
  ]
}

/**
 * The endpoints each inference profile serves, and the operation each one is.
 *
 * The key is also what the upstream path is built from, so a request selects an
 * endpoint rather than describing one. Small on purpose: a provider's other
 * endpoints mint keys, start batches and upload files, and a token that may call
 * a model is not thereby a token that may do those.
 *
 * OpenRouter takes a model call in each of the three shapes harnesses speak:
 * chat completions, OpenAI's Responses and Anthropic's Messages. Its Responses
 * endpoint stores nothing, so there is no stored response for a later request
 * to read back. Its model listings are the catalogs a client reads at startup,
 * which OpenRouter publishes whatever the key; they spend nothing and carry no
 * body.
 */
const inferenceEndpoints: Readonly<
  Record<InferenceProfile, Readonly<Record<string, InferenceOperation>>>
> = {
  'anthropic-messages': {
    'v1/messages': 'messages',
    'v1/messages/count_tokens': 'count-tokens',
  },
  openrouter: {
    'api/v1/chat/completions': 'chat-completions',
    'api/v1/embeddings/models': 'list-models',
    'api/v1/images/models': 'list-models',
    'api/v1/messages': 'messages',
    'api/v1/models': 'list-models',
    'api/v1/responses': 'responses',
    'api/v1/videos/models': 'list-models',
  },
}

/**
 * The endpoints a model server serves, and the operation each one is: the
 * ones every OpenAI-compatible server shares, a model call in either shape and
 * the listing a client finds models by.
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
}

/**
 * Whether an operation sends a body: a model listing, a ref advertisement and
 * a read are read.
 */
const sendsBody = (operation: Operation): boolean =>
  operation !== 'list-models' && operation !== 'ls-refs' && operation !== 'read'

/** How each inference operation is requested: a listing is read, the rest are sent a body. */
const methodOf = (operation: InferenceOperation): 'GET' | 'POST' =>
  sendsBody(operation) ? 'POST' : 'GET'

/**
 * Route a request for a git grant's API, or `undefined` if the path's host is
 * no held grant's API.
 *
 * A read under `repos/<owner>/<repo>/` for a repository a grant lists is sent
 * with that grant's credential. The upstream path is the grant's spelling of
 * the repository, then the rest of the path as the request had it, segment by
 * segment: `decide` has already refused a percent-escape and an empty segment,
 * and the URL parser has resolved every `.` and `..`, so no segment can leave
 * the repository it follows. The query is carried, rebuilt so that each name
 * and value is encoded.
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
  if (method !== 'GET' && method !== 'HEAD') {
    return deny(403, `this VM may read through ${lowered}, not ${method} /${rest.join('/')}`, {
      host: lowered,
    })
  }
  const [area, owner, repo, ...tail] = rest
  if (area !== 'repos') {
    return deny(403, `/${rest.join('/')} is not something this VM may read through ${lowered}`, {
      host: lowered,
    })
  }
  if (owner === undefined || repo === undefined) {
    return deny(404, 'a repository is read at /repos/<owner>/<repo>')
  }

  const wanted = `${owner}/${repo}`.toLowerCase()
  for (const candidate of held) {
    const allowed = candidate.repos.find(spelled => normaliseRepo(spelled) === wanted)
    if (allowed === undefined) continue
    const path = withoutGit(allowed)
    const filter = new URLSearchParams(query).toString()
    return {
      _tag: 'Api',
      credential: candidate.credential,
      host: lowered,
      operation: 'read',
      profile: candidate.profile,
      repo: path,
      upstream: `https://${lowered}/repos/${[path, ...tail].join('/')}${filter === '' ? '' : `?${filter}`}`,
    }
  }
  return deny(403, `${wanted} is not a repository this VM may read`, { scope: wanted })
}

/**
 * Route a git request, or `undefined` if the path is not a git endpoint at all —
 * which is what lets an inference endpoint be tried against the same path
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
    if (service === 'git-receive-pack') return deny(403, 'this VM may fetch, not push')
    if (service !== 'git-upload-pack') {
      return deny(404, 'the ref advertisement takes ?service=git-upload-pack')
    }
    if (method !== 'GET') return deny(405, `${method} is not how a ref advertisement is requested`)
    operation = 'ls-refs'
    head = segments.slice(0, -2)
  } else if (last === 'git-upload-pack') {
    if (method !== 'POST') return deny(405, `${method} is not how a fetch is requested`)
    operation = 'fetch'
    head = segments.slice(0, -1)
  } else if (last === 'git-receive-pack') {
    return deny(403, 'this VM may fetch, not push')
  } else {
    return undefined
  }

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
    const allowed = grant.repos.find(candidate => normaliseRepo(candidate) === wanted)
    if (allowed === undefined) continue
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
      upstream:
        operation === 'ls-refs'
          ? `https://${upstreamHost}/${path}.git/info/refs?service=git-upload-pack`
          : `https://${upstreamHost}/${path}.git/git-upload-pack`,
    }
  }
  return deny(403, `${wanted} is not a repository this VM may fetch`, { scope: wanted })
}

/**
 * Route an inference request to the grant that pays for it: the one for the
 * host the path names, since `parseGrants` admits one per profile.
 */
const routeInference = (
  grants: readonly Grant[],
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
): Decision | undefined => {
  const [host, ...rest] = segments
  if (host === undefined) return undefined
  const lowered = host.toLowerCase()
  const grant = grants
    .filter(isInferenceGrant)
    .find(candidate => profiles[candidate.profile].host === lowered)
  if (grant === undefined) return undefined

  const asked = rest.join('/')
  const { profile } = grant
  // The upstream path is the table's key, not the request's — equal by the
  // lookup, and structurally so rather than by inspection.
  for (const [path, operation] of Object.entries(inferenceEndpoints[profile])) {
    if (path !== asked) continue
    if (method !== methodOf(operation)) {
      return deny(405, `${method} is not how ${path} is requested`)
    }
    // A listing's query is its filter, so it is carried, rebuilt so that every
    // name and value is encoded and none can reach past the query. Any other
    // endpoint's is dropped.
    const filter = operation === 'list-models' ? new URLSearchParams(query).toString() : ''
    return {
      _tag: 'Inference',
      credential: grant.credential,
      host: profiles[profile].host,
      operation,
      profile,
      upstream: `https://${profiles[profile].host}/${path}${filter === '' ? '' : `?${filter}`}`,
    }
  }
  return deny(404, `${host} is brokered, but /${asked} is not an endpoint this VM may call`)
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
 * the path, as a sequence of segments matched against a fixed shape, git's
 * `service`, a model listing's filter, and an API read's query.
 */
export const decide = (grants: readonly Grant[], method: string, target: string): Decision => {
  if (grants.length === 0) return deny(403, 'this VM has no brokered credential')

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

  // Refused rather than decoded. A repository name never needs an escape, so the
  // only thing percent-encoding can express here is a segment that means one
  // thing to this matcher and another to whatever decodes it later.
  if (url.pathname.includes('%')) return deny(400, 'percent-encoding is not accepted in a path')

  const segments = url.pathname.split('/').slice(1)
  if (segments.some(segment => segment === '')) return deny(404, 'empty path segment')

  // A forge's API first, by its host: its paths are the forge's own, and one of
  // them could end in what reads as a git endpoint. Then git, and only then
  // inference: a git endpoint has a shape of its own, so trying it first keeps
  // every refusal it makes — the push at the advertisement, the wrong method,
  // the path that is not three segments — rather than letting an unrecognised
  // git path fall through to a different profile's "no such endpoint".
  const api = routeApi(grants, method, segments, url.searchParams)
  if (api !== undefined) return api
  const git = routeGit(grants, method, segments, url.searchParams.get('service'))
  if (git !== undefined) return git
  const local = routeModelServer(grants, method, segments)
  if (local !== undefined) return local
  const inference = routeInference(grants, method, segments, url.searchParams)
  if (inference !== undefined) return inference
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
    return deny(421, `${name} is not answered here for this VM`, { host: name })
  }
  const granted = decide(grants, method, `/${name}${parsed.pathname}${parsed.search}`)
  if (granted._tag !== 'Deny') return granted

  const operation = readOf(method, parsed)
  if (operation === undefined) return granted
  const reached = reach === 'any' || reach.some(each => each.toLowerCase() === name)
  if (!reached) {
    // A refusal that names a repository says enough. One that says only that
    // this is no git endpoint hides why a read was not sent on.
    return granted.status === 404
      ? deny(
          403,
          `no grant covers this, and the tunnel does not reach ${name}, so it is not sent without one either`,
          { host: name },
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

/** The guest's headers an inference request does not carry upstream. */
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
  // How the guest framed its body for this connection. `fetch` frames it again
  // from the bytes it sends, in chunks, so no length the guest stated can
  // disagree with what reaches the provider.
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
 * An inference request carries the guest's headers but those in
 * `unforwardedRequestHeaders`, so a harness reaches its provider as it would
 * from the host: its API version, its betas, its session and cache hints, its
 * own name. None of them can send the request elsewhere or attach a
 * credential, since the URL is built from the grant and the credential is set
 * after the guest's are dropped. A model server's request is built the same
 * way, as is one through a forge's API, and so is an anonymous read, whose
 * credentials are dropped and none set.
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
    if (!sendsBody(decision.operation)) for (const name of bodyHeaders) headers.delete(name)
    headers.set('Accept-Encoding', 'identity')
    if (token === undefined) return headers
    if (decision._tag === 'Inference' && decision.profile === 'anthropic-messages') {
      headers.set('x-api-key', token)
    } else {
      headers.set('Authorization', `Bearer ${token}`)
    }
    return headers
  }

  const headers = new Headers({
    'Accept-Encoding': 'identity',
    // git's own name for what it is asking for. Constructed, so a guest cannot
    // use content negotiation to reach a different upstream behaviour.
    Accept: decision.operation === 'ls-refs' ? '*/*' : 'application/x-git-upload-pack-result',
    'User-Agent': 'igloo-broker',
  })
  // A fine-grained personal access token or an App installation token, in the
  // username slot git itself uses for them.
  if (token !== undefined) headers.set('Authorization', `Basic ${btoa(`x-access-token:${token}`)}`)
  if (decision.operation === 'fetch') {
    headers.set('Content-Type', 'application/x-git-upload-pack-request')
    // git compresses the negotiation body. The body is passed through
    // unexamined, so the encoding that describes it has to go with it.
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
 * reason shown, so an inference request gets a 403. A **redirect** names a
 * destination this grant did not authorize, and following it would send the
 * credential there.
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
 * **What this does not cover**, stated rather than left to be discovered: a
 * name on the allowlist that resolves to a routable address which is
 * nonetheless private to a VPN this host is on. Such an address is public by
 * every test available here, and the name was listed deliberately, so it is
 * reachable. Rejecting RFC1918 is not a VPN boundary.
 */
export const isReachableAddress = (address: string): boolean => {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address)
  if (v4 !== null) {
    const octets = v4.slice(1).map(Number)
    const [a = 0, b = 0] = octets
    if (octets.some(octet => octet > 255)) return false
    if (a === 0 || a === 10 || a === 127) return false
    if (a === 169 && b === 254) return false // link-local, and the cloud metadata address
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 100 && b >= 64 && b <= 127) return false // carrier-grade NAT
    if (a === 198 && (b === 18 || b === 19)) return false // benchmarking
    if (a >= 224) return false // multicast, reserved, broadcast
    return true
  }

  const lowered = address.toLowerCase().split('%')[0] ?? ''
  if (lowered === '' || !lowered.includes(':')) return false
  // A v4-mapped or v4-embedded address is a v4 address wearing a v6 spelling,
  // so it is judged as the address it really is rather than as unrecognised.
  const embedded = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lowered)
  if (embedded?.[1] !== undefined) return isReachableAddress(embedded[1])
  if (lowered === '::1' || lowered === '::') return false
  if (lowered.startsWith('fe8') || lowered.startsWith('fe9')) return false
  if (lowered.startsWith('fea') || lowered.startsWith('feb')) return false // link-local
  if (/^fe[c-f]/.test(lowered)) return false // site-local: deprecated, still handed out, never public
  if (/^f[cd]/.test(lowered)) return false // unique local
  if (lowered.startsWith('ff')) return false // multicast
  if (lowered.startsWith('2002:')) return false // 6to4, which embeds a v4 address
  return true
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

/** The upstream's headers an inference response does not carry back. */
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
 * authentication challenge inside the VM. For inference and a model server,
 * the upstream's headers but those in `unforwardedResponseHeaders`: a harness
 * reads its retry delay, its rate limits and the request id it reports from
 * them. A redirect never reaches either, since `relay` answers it. An
 * anonymous read's are passed the same way, a redirect's `Location` among
 * them.
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
 * Inference gets minutes rather than seconds because a **non-streaming** request
 * generates its whole answer before any header arrives, so the budget has to
 * cover generation rather than round-trip. A request that needs longer than this
 * is one that should be streaming, where the first byte arrives immediately. A
 * model server's call is a model call too, and may wait on its model loading.
 * An anonymous read is given git's: no model is generating its answer.
 */
const headerTimeoutMs = { git: 30_000, inference: 600_000 } as const

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
 * A refusal of the broker's own, which asking again will not change.
 *
 * `x-should-retry: false` is for the clients that read it; the others decide by
 * status alone, and retry a 5xx for minutes. So a refusal the guest could see
 * end is a 4xx where one is true, and the 5xx left are the broker's own faults.
 */
const text = (status: number, message: string): Response =>
  new Response(`broker: ${message}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'x-should-retry': 'false' },
    status,
  })

/** A failure that may not happen again, which a client is right to retry. */
const transient = (status: number, message: string): Response =>
  new Response(`broker: ${message}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    status,
  })

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
    return text(decision.status, decision.reason)
  }

  // Which credential pays and what it was expected to cover, both settled by
  // the path: a git request is for a repository, and an inference request
  // names its model only in a body that is not parsed.
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
    operation: decision.operation,
    ...(scope === undefined ? {} : { scope }),
    ...(decision._tag === 'ModelServer' ? { server: decision.server } : {}),
  })

  const token = credential === undefined ? undefined : credentials.get(credential)
  if (credential !== undefined && token === undefined) {
    // Fail closed rather than forwarding without the credential: an authorized
    // request that quietly becomes an anonymous one has changed meaning.
    audit({ event: 'error', id, reason: 'credential not held' })
    return text(500, `${credential} was not delivered to this broker`)
  }

  const started = Date.now()
  const abort = new AbortController()
  const timer = setTimeout(
    () => {
      abort.abort()
    },
    decision._tag === 'Inference' || decision._tag === 'ModelServer'
      ? headerTimeoutMs.inference
      : headerTimeoutMs.git,
  )

  let upstream: Response
  try {
    upstream = await send(decision.upstream, {
      // Streamed as it arrives, never read.
      body: sendsBody(decision.operation) ? request.body : undefined,
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
      return text(400, 'the request was abandoned')
    }
    audit({ event: 'error', id, ms, reason: 'upstream unreachable' })
    return transient(502, `${decision.host} did not answer`)
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
    return text(refused.status, refused.reason)
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
  opened: number
  phase: 'head' | 'opening' | 'piping' | 'done'
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
 */
export const serveTunnel = (
  socketPath: string,
  hosts: TunnelScope,
  destinations: Destinations = publicDestinations,
  answered?: { readonly names: readonly string[]; readonly socket: string },
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
        client.data.phase = 'piping'
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        audit({
          ...(typeof candidate === 'string' ? { address: candidate } : { answered: true }),
          event: 'tunnel-open',
          id: client.data.id,
          target: client.data.target,
        })
        // Whatever arrived after the head — a TLS hello sent without waiting
        // for the 200, with the head or while connecting — goes first, in order.
        for (const early of client.data.early) {
          client.data.bytesOut += early.byteLength
          push(upstream, client.data.upstream, early, client)
        }
        client.data.early = []
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
        const decided =
          asked._tag === 'Open' && answered?.names.includes(asked.host) === true
            ? asked
            : allowTunnel(hosts, asked)
        if (decided._tag === 'Refuse') {
          refuseClient(client, decided.status, decided.reason)
          return
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
    ids,
    send,
    tls,
  })

const listen = (
  socketPath: string,
  decideFor: (request: Request) => Decision,
  options: {
    readonly credentials: ReadonlyMap<string, string>
    readonly ids: () => number
    readonly send: Upstream
    readonly tls?: TlsIdentity
  },
): import('bun').Server<undefined> => {
  const { credentials, ids, send, tls } = options
  clearStaleSocket(socketPath)

  // @ts-expect-error Bun's types declare `idleTimeout` only for a TCP listener.
  // It applies to a unix socket as well, which the tests of this function assert.
  return Bun.serve({
    fetch(request) {
      const id = ids()
      return handle(request, decideFor, credentials, id, send).catch(error => {
        audit({ event: 'error', id, reason: String(error) })
        return text(500, 'the request could not be completed')
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
    : isInferenceGrant(grant)
      ? { credential: grant.credential, profile: grant.profile }
      : { credential: grant.credential, profile: grant.profile, repos: grant.repos }

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
