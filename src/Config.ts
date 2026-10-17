import type { Binaries } from './Binaries.ts'
import type { Grant as BrokerGrant, ModelServerGrant, TunnelScope } from './broker.ts'
import type { Publication } from './Vm.ts'

import { Array as Arr, Effect, FileSystem, Predicate, Result, Schema } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import * as path from 'node:path'

import {
  isHostname,
  isInferenceProfile,
  isModelServerName,
  isProfileName,
  isRepo,
  isTcpPort,
  normaliseRepo,
  profileNames,
  profiles,
  tlsCertificateCredential,
  tlsKeyCredential,
} from './broker.ts'
import * as Evaluation from './Evaluation.ts'
import { nixString } from './Flake.ts'
import * as Secrets from './Secrets.ts'

export class ConfigError extends Schema.TaggedError<ConfigError>()('ConfigError', {
  message: Schema.String,
}) {}

/** `igloo.nix` — a NixOS module, composed by the module system. */
const CONTENT = 'igloo.nix'

/** `igloo-policy.nix` — an attribute set of settings, read by the host. */
const POLICY = 'igloo-policy.nix'

/**
 * The two files one layer may hold.
 *
 * The split is the whole content/policy distinction as a user meets it: a
 * content file says what is *in* the VM and reaches the guest as a NixOS module;
 * a policy file says what the VM is *allowed to do* and never reaches the guest
 * at all — the host reads it and emits the result as `mkRunner` arguments.
 */
export interface LayerFiles {
  readonly content: string
  readonly policy: string
}

/**
 * The layer that applies to every VM this user runs, from the directory
 * `IGLOO_USER_LAYER` names — the store path home-manager builds from
 * `programs.igloo` and writes into the wrapper it installs.
 */
export const userLayer = (dir: string): LayerFiles => ({
  content: path.join(dir, CONTENT),
  policy: path.join(dir, POLICY),
})

/**
 * How a message names the user layer's two files.
 *
 * A layer in the store is one home-manager generated, and a file there is not
 * one to edit: a setting goes in the `programs.igloo` option that generated it,
 * which is also where it goes for a user who has no layer yet. A layer written
 * by hand is named by its files.
 */
export const userLayerNames = (dir: string | undefined): LayerFiles =>
  dir === undefined || dir.startsWith(`${Evaluation.STORE}/`)
    ? { content: 'programs.igloo.guest', policy: 'programs.igloo.policy' }
    : userLayer(dir)

/**
 * One project's layer, in the project directory rather than the workspace.
 *
 * The workspace is mounted read-write into the guest, so a file there is
 * editable by whatever the VM runs, and policy from it would let the sandbox
 * widen its own boundary — which is why `resolve` refuses to read one.
 *
 * Content from the workspace is allowed, imported from the project layer. Its
 * evaluation is confined — it reads the store, the layers and the workspace,
 * and nothing else — and the build that follows runs nothing that can reach
 * the network, so a source it names that no cache has is the developer's to
 * build. What it decides is still built on the host, in nix's sandbox, and it
 * includes the QEMU command line the runner starts there.
 */
export const projectLayer = (projectRoot: string): LayerFiles => ({
  content: path.join(projectRoot, CONTENT),
  policy: path.join(projectRoot, POLICY),
})

/**
 * How much the broker lets a guest reach. No guest has a network card, whatever
 * the mode: everything that leaves goes through the broker on the host, so the
 * modes differ only in what it allows.
 *
 * `none` — nothing: no tunnel, no brokered credential and no model server.
 * `restricted` — what a grant constructs, and the tunnel destinations listed.
 * `internet` — the tunnel to any public name, and whatever a grant constructs.
 * "Public" is the tunnel's address check: never this host, and never an address
 * inside its networks, so the LAN is out of reach too.
 */
export type NetworkMode = 'internet' | 'none' | 'restricted'

/**
 * What a brokered credential may be used for: an upstream profile, and for a git
 * profile the repositories it may reach. An inference profile reaches whichever
 * model a request names; the key's own limits at the provider bound that.
 *
 * The profile decides the upstream, so a grant names what is reachable there and
 * never where "there" is. This is the broker's own grant shape minus the
 * credential name, which composition adds once it knows which credential the
 * grant belongs to.
 *
 * Distributed over the union deliberately: a plain `Omit` of a union keeps only
 * the keys both members share, which would silently drop `repos` — the entire
 * content of a git grant. A model server's grant is not a credential's, so it
 * is not among them: `modelServers` declares those.
 */
export type Grant =
  Exclude<BrokerGrant, ModelServerGrant> extends infer T
    ? T extends T
      ? Omit<T, 'credential'>
      : never
    : never

/**
 * A model server on this machine's loopback that this project's broker may
 * call: one its own layer declared, or one the user layer declared and gave to
 * it. `key` is where the key it takes is read from, absent for a server that
 * takes none.
 */
export interface ModelServerDeclaration {
  readonly key?: Secrets.Source
  readonly layer: 'project' | 'user'
  readonly name: string
  readonly port: number
}

/**
 * The name a model server's key is held under, beside the credentials
 * `secrets` declares. A secret may not take it: a name holds one value.
 */
export const modelServerKeyName = (server: string): string => `model-server.${server}`

/**
 * A credential this project is to be given: one its own layer declared, or one
 * the user layer declared and gave to it.
 *
 * `layer` is which of the two declared it, which decides the directory a
 * command source runs in.
 *
 * `mode` is written out rather than defaulted because the two values differ in
 * what they expose: `deliver` puts a real credential inside a VM whose root the
 * agent has, while `broker` keeps it on the host and lets the guest make
 * requests against it. Which of those is happening should be something a reader
 * sees rather than infers.
 *
 * A union rather than an optional field, so that "a brokered credential has a
 * grant" is something the type says: a broker holding a credential it has no
 * grant for could only refuse every request made against it.
 */
export type SecretDeclaration =
  | {
      readonly grant: Grant
      readonly layer: 'project' | 'user'
      readonly mode: 'broker'
      readonly name: string
      readonly source: Secrets.Source
    }
  | {
      readonly layer: 'project' | 'user'
      readonly mode: 'deliver'
      readonly name: string
      readonly source: Secrets.Source
    }

/** The effective policy a VM is launched with, after composing the layers. */
export interface Policy {
  /**
   * The most memory the VM's broker may use, in MiB, or `undefined` for no
   * bound. Unbounded by default, as a harness on the host would be: the broker
   * holds what the guest's requests carry while it checks them, and a bound
   * that came out low would fail the requests that reached it. When the host
   * runs out instead, the kernel kills the broker first.
   */
  readonly brokerMem: number | undefined
  readonly mem: number
  /** The project's own, and the user layer's that list this project. */
  readonly modelServers: readonly ModelServerDeclaration[]
  readonly network: NetworkMode
  /**
   * Guest ports published on the host's loopback, and the host port each gets.
   * The project's alone: what a project serves is a property of the project,
   * and the exposure is to the same person who wrote the file.
   */
  readonly ports: readonly Publication[]
  /** The project's own, and the user layer's that list this project. */
  readonly secrets: readonly SecretDeclaration[]
  /**
   * Where the guest may open a tunnel to. Under `restricted`, the hosts the
   * project asked for, bounded by the user layer's `tunnelCeiling`, so always a
   * subset of what that file listed; under `internet`, any public name; under
   * `none`, nothing.
   */
  readonly tunnel: TunnelScope
  readonly vcpu: number
}

/**
 * What a VM gets with no configuration at all.
 *
 * `network` is `"internet"` because the audience runs coding agents, for which
 * "cannot reach an API" is the wrong default and `"none"` is one line away. The
 * rest match `mkRunner`'s own defaults; they are repeated here because the host
 * emits every one of them explicitly, so that the generated flake is a complete
 * record of what a VM was launched with.
 */
const coreDefaults = {
  brokerMem: undefined,
  mem: 4096,
  modelServers: [],
  network: 'internet',
  ports: [],
  secrets: [],
  tunnel: [],
  vcpu: 4,
} as const satisfies Policy

/**
 * Which layer may set what, and the only place that decides it.
 *
 * `mem`, `vcpu` and `brokerMem` are machine-local: how much a VM and its broker
 * get is a property of the machine they run on, not of the repository, so a
 * project cannot set them.
 * `network` is the one setting that composes — a user default, an optional user
 * ceiling, and a project request checked against it.
 */
const settings = new Map<string, 'both' | 'project' | 'user'>([
  ['brokerMem', 'user'],
  ['mem', 'user'],
  ['modelServers', 'both'],
  ['network', 'both'],
  ['networkCeiling', 'user'],
  ['ports', 'project'],
  ['secrets', 'both'],
  ['tunnel', 'project'],
  ['tunnelCeiling', 'user'],
  ['vcpu', 'user'],
])

/**
 * Settings that existed once, and why they are gone — so a file still carrying
 * one is told what happened rather than that it named something unknown.
 */
const removed = new Map<string, string>([
  [
    'dnsServer',
    'a VM has no network card and looks up no names itself; the broker resolves each destination on this machine. Delete the line.',
  ],
])

const allowedIn = (layer: 'project' | 'user'): string =>
  [...settings]
    .filter(([, scope]) => scope === 'both' || scope === layer)
    .map(([key]) => key)
    .join(', ')

/** A policy file that exists, and what it said. */
export interface PolicyLayer {
  readonly path: string
  readonly values: Record<string, unknown>
}

export interface Layers {
  readonly project: PolicyLayer | undefined
  /**
   * Other spellings of `projectRoot` that the user layer's `projects` lists
   * use — the same directory reached through a symlink, say. Composition cannot
   * look at the filesystem, so `resolve` finds them.
   */
  readonly projectAliases: readonly string[]
  /**
   * The project's canonical root, which is its identity — and so what a
   * credential's `projects` entry has to name. `undefined` outside a project.
   */
  readonly projectRoot: string | undefined
  readonly user: PolicyLayer | undefined
  /**
   * Where the user layer's policy belongs, as `userLayerNames` says it, whether
   * or not the layer exists: a project that sets a machine-local setting is told
   * where to move it.
   */
  readonly userPolicyName: string
}

/**
 * What composing the layers produced: the policy, and anything the reader
 * should be told that is not an error. Notes travel out rather than being
 * printed where they arise, so composition stays pure and each one is asserted.
 */
export interface Composed {
  readonly notes: readonly string[]
  readonly policy: Policy
}

const bad = (message: string): Result.Result<never, ConfigError> =>
  Result.fail(new ConfigError({ message }))

const readInt = (where: string, key: string, raw: unknown): Result.Result<number, ConfigError> =>
  typeof raw === 'number' && Number.isInteger(raw) && raw > 0
    ? Result.succeed(raw)
    : bad(`${where}: \`${key}\` must be a positive whole number, not ${JSON.stringify(raw)}.`)

const readString = (
  where: string,
  key: string,
  raw: unknown,
): Result.Result<string, ConfigError> =>
  typeof raw === 'string' && raw !== ''
    ? Result.succeed(raw)
    : bad(`${where}: \`${key}\` must be a non-empty string, not ${JSON.stringify(raw)}.`)

const readMode = (
  where: string,
  key: string,
  raw: unknown,
): Result.Result<NetworkMode, ConfigError> =>
  raw === 'none' || raw === 'restricted' || raw === 'internet'
    ? Result.succeed(raw)
    : bad(
        `${where}: \`${key}\` must be "none", "restricted" or "internet", not ${JSON.stringify(raw)}.`,
      )

/**
 * How much of the network a mode reaches, so a project can narrow a ceiling and
 * not widen it.
 *
 * `restricted` sits between the two because it reaches only what a grant or a
 * listed destination allows — strictly more than nothing, strictly less than
 * any public name. Someone whose ceiling is `restricted` has said "these
 * destinations or nothing", and `internet` would be a different answer to that.
 */
const rank = (mode: NetworkMode): number => (mode === 'none' ? 0 : mode === 'restricted' ? 1 : 2)

/**
 * What a credential may be called.
 *
 * Two consumers, and the stricter one wins. systemd wants a name it can use as
 * a filename under `/run/credentials/@system/`, and QEMU takes the name inside a
 * comma-separated `-fw_cfg` parameter — so a comma would not be a bad name, it
 * would be a second option.
 */
const CREDENTIAL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

const readStringList = (
  where: string,
  key: string,
  raw: unknown,
): Result.Result<readonly string[], ConfigError> =>
  Array.isArray(raw) && raw.every(item => typeof item === 'string' && item !== '')
    ? Result.succeed(raw as readonly string[])
    : bad(`${where}: \`${key}\` must be a list of non-empty strings, not ${JSON.stringify(raw)}.`)

/**
 * A list of tunnel destinations.
 *
 * Names only, and exactly the rule the broker applies, imported rather than
 * restated: the two are in different files and a drift between them would
 * present as a destination accepted here and refused at the moment it is used.
 *
 * No scheme, no port and no wildcard — a destination is a host. A registry's
 * downloads usually come from a different name than its index, and both have to
 * be listed, which is the honest form of the question rather than an omission.
 */
const readHosts = (
  where: string,
  key: string,
  raw: unknown,
): Result.Result<readonly string[], ConfigError> =>
  Result.flatMap(readStringList(where, key, raw), hosts => {
    for (const host of hosts) {
      if (isHostname(host.toLowerCase())) continue
      return bad(
        `${where}: \`${host}\` in \`${key}\` is not a hostname. Write the host alone — no scheme, no port, no wildcard — as in "files.pythonhosted.org". Only port 443 is tunnelled, and a name matches exactly, so a registry's download host has to be listed beside its index.`,
      )
    }
    return Result.succeed(hosts)
  })

/**
 * A published port, in either of the two forms a project may write.
 *
 * A bare number publishes a guest port on the same host port, which is what
 * anyone means most of the time and the form that keeps a URL predictable. The
 * pair exists for the case that forces it: two projects whose servers listen on
 * the same port, where the second one has to land somewhere else on the host.
 */
const readPublication = (
  where: string,
  key: string,
  raw: unknown,
): Result.Result<Publication, ConfigError> => {
  if (isTcpPort(raw)) return Result.succeed({ guest: raw, host: raw })
  const entry = asRecord(raw)
  if (entry !== undefined && isTcpPort(entry['guest']) && isTcpPort(entry['host'])) {
    return Result.succeed({ guest: entry['guest'], host: entry['host'] })
  }
  return bad(
    `${where}: ${JSON.stringify(raw)} in \`${key}\` is not a port. Write the number alone to publish it on the same port of the host, or \`{ guest = 5173; host = 5174; }\` to publish it on a different one. Ports are 1 to 65535.`,
  )
}

/**
 * The published ports, with the one conflict this file can decide by itself.
 *
 * Two entries on one host port cannot both be bound, and ssh would fail the
 * second — so it is refused here, where the message can name the file and both
 * guest ports. The conflict it cannot see is another *project* holding the
 * port, which is the launch's to report.
 */
const readPorts = (
  where: string,
  key: string,
  raw: unknown,
): Result.Result<readonly Publication[], ConfigError> =>
  Result.gen(function* () {
    if (!Array.isArray(raw)) {
      return yield* bad(
        `${where}: \`${key}\` must be a list of ports, not ${JSON.stringify(raw)}. As in \`ports = [ 3000 ];\`.`,
      )
    }
    const published: Publication[] = []
    for (const entry of raw) {
      const publication = yield* readPublication(where, key, entry)
      const clash = published.find(other => other.host === publication.host)
      if (clash !== undefined) {
        return yield* bad(
          `${where}: \`${key}\` publishes guest ${String(clash.guest)} and guest ${String(publication.guest)} on the same host port ${String(publication.host)}. One host port reaches one guest port; give one of them another.`,
        )
      }
      published.push(publication)
    }
    return published
  })

/** An attribute set, or `undefined` for anything else — including a list. */
const asRecord = (raw: unknown): Record<string, unknown> | undefined =>
  Predicate.isObject(raw) ? raw : undefined

const HOME_RELATIVE = 'in a home-manager configuration, write "${config.home.homeDirectory}/…"'

const readSource = (
  where: string,
  setting: string,
  raw: unknown,
): Result.Result<Secrets.Source, ConfigError> => {
  const source = asRecord(raw)
  if (source === undefined) {
    return bad(
      `${where}: \`${setting}\` must be \`{ file = "…"; }\` or \`{ command = [ "…" ]; }\`.`,
    )
  }
  const keys = Object.keys(source)
  if (keys.length !== 1 || (keys[0] !== 'file' && keys[0] !== 'command')) {
    return bad(
      `${where}: \`${setting}\` takes exactly one of \`file\` or \`command\`, not ${JSON.stringify(keys)}.`,
    )
  }
  if (keys[0] === 'file') {
    const key = `${setting}.file`
    return Result.flatMap(readString(where, key, source['file']), file => {
      // A relative path would be read from wherever `igloo up` was typed, which
      // can be inside the workspace — the one directory the guest can write.
      if (!path.isAbsolute(file)) {
        return bad(
          `${where}: \`${key}\` must be an absolute path, not ${JSON.stringify(file)}. A relative one would be read from whichever directory \`igloo up\` runs in, which can be the workspace the guest writes.${file.startsWith('~') ? ` Nothing expands \`~\` in it; ${HOME_RELATIVE}.` : ''}`,
        )
      }
      // Nix copies a path value such as `./token` into the store when it is
      // serialised, so this is usually a credential written as a path literal —
      // and already readable by every user on the machine.
      if (file.startsWith(`${Evaluation.STORE}/`)) {
        return bad(
          `${where}: \`${key}\` is ${file}, in the Nix store, which every user on this machine can read — so the credential is exposed already. A path written as \`./token\` is copied there when the configuration is evaluated; name it as a string instead, so it is read where it is: ${HOME_RELATIVE}.`,
        )
      }
      return Result.succeed({ _tag: 'File', path: file } as const)
    })
  }
  // An argument vector, never a shell string. There is nothing for a shell to
  // add here except a way to get quoting wrong.
  return Result.flatMap(readStringList(where, `${setting}.command`, source['command']), argv =>
    Arr.isReadonlyArrayNonEmpty(argv)
      ? Result.succeed({ _tag: 'Command', argv } as const)
      : bad(`${where}: \`${setting}.command\` is empty.`),
  )
}

/** Where the limits on a model key are set, for a message refusing one here. */
const KEY_LIMITS =
  'Which models a key may call and what it may spend are set on the key, at the provider: OpenRouter has a credit limit and guardrails per key, Anthropic a spend limit per workspace.'

/**
 * A brokered credential's grant: which profile, and what it may reach.
 *
 * Required on a brokered credential rather than defaulted to something empty,
 * because the default a reader would assume is "it works" and the default that
 * is safe is "it refuses everything". Asking for the profile by name is how
 * those two stop being confusable.
 */
const readGrant = (
  where: string,
  name: string,
  entry: Record<string, unknown>,
): Result.Result<Grant, ConfigError> =>
  Result.gen(function* () {
    const profile = entry['profile']
    if (!isProfileName(profile)) {
      return yield* bad(
        `${where}: \`secrets.${name}.profile\` must name a broker profile. Built: ${profileNames
          .map(known => `"${known}"`)
          .join(
            ', ',
          )}. A brokered credential without a profile has no upstream the broker is allowed to construct a request to, so it could only refuse everything asked of it.`,
      )
    }

    // Refused rather than ignored: `repos` on a model grant is someone believing
    // they narrowed something.
    if (isInferenceProfile(profile)) {
      for (const key of ['repos', 'write']) {
        if (key in entry) {
          return yield* bad(
            `${where}: \`secrets.${name}.${key}\` does not apply to the ${profile} profile, which calls whichever model a request names. ${KEY_LIMITS}`,
          )
        }
      }
      return { profile }
    }

    const listed = (key: 'repos' | 'write') =>
      entry[key] === undefined
        ? Result.succeed([])
        : readStringList(where, `secrets.${name}.${key}`, entry[key])
    const repos = yield* listed('repos')
    const write = yield* listed('write')
    if (repos.length + write.length === 0) {
      return yield* bad(
        `${where}: \`secrets.${name}\` lists no repositories in \`repos\` or \`write\`, so the grant reaches nothing. List those this credential may fetch in \`repos\`, and those it may push to as well in \`write\`, as \`owner/repo\`.`,
      )
    }
    for (const repo of [...repos, ...write]) {
      if (!isRepo(repo)) {
        return yield* bad(
          `${where}: \`${repo}\` is not a repository. Write \`owner/repo\` — ${profiles[profile].host} is decided by the profile, so it is not part of the name.`,
        )
      }
    }
    // Refused rather than merged: listed in `repos` as well, a repository in
    // `write` reads as one someone meant to keep from being pushed to.
    const twice = write.find(repo =>
      repos.some(read => normaliseRepo(read) === normaliseRepo(repo)),
    )
    if (twice !== undefined) {
      return yield* bad(
        `${where}: \`${twice}\` is in both \`secrets.${name}.repos\` and \`secrets.${name}.write\`. One in \`write\` is fetched and read as well as pushed to, so list it there alone, or in \`repos\` alone to keep it from being pushed to.`,
      )
    }
    return { profile, repos, ...(write.length === 0 ? {} : { write }) }
  })

/** What either layer says about one credential: where its value comes from, and what it is for. */
type Body =
  | { readonly grant: Grant; readonly mode: 'broker'; readonly source: Secrets.Source }
  | { readonly mode: 'deliver'; readonly source: Secrets.Source }

/** One entry of the user layer's `secrets`: a credential, and the projects it goes to. */
interface Shared {
  readonly body: Body
  readonly projects: readonly string[]
}

const BODY_KEYS = new Set(['mode', 'profile', 'repos', 'source', 'write'])

const BODY_SHAPE =
  'plus `profile` when the mode is "broker", and `repos` or `write` for a git profile'

/** A declaration's fields that are gone, and what to do instead. */
const removedFromBody = new Map<string, string>([
  [
    'models',
    `the broker sends a request for whichever model it names. ${KEY_LIMITS} Delete the line.`,
  ],
  [
    'maxOutputTokens',
    `the broker sends a request with its own \`max_tokens\`. ${KEY_LIMITS} Delete the line.`,
  ],
])

/**
 * A declaration's name and attribute set, before anything in it is read — but
 * not one still setting a field that is gone, which is refused with what to do
 * instead.
 */
const readEntry = (
  where: string,
  name: string,
  raw: unknown,
): Result.Result<Record<string, unknown>, ConfigError> => {
  if (!CREDENTIAL_NAME.test(name)) {
    return bad(
      `${where}: \`${name}\` is not a usable credential name. Use letters, digits, \`_\`, \`.\` and \`-\`, starting with a letter, digit or underscore.`,
    )
  }
  const entry = asRecord(raw)
  if (entry === undefined) return bad(`${where}: \`secrets.${name}\` must be an attribute set.`)
  for (const key of Object.keys(entry)) {
    const gone = removedFromBody.get(key)
    if (gone !== undefined) {
      return bad(`${where}: \`secrets.${name}.${key}\` is no longer a setting: ${gone}`)
    }
  }
  return Result.succeed(entry)
}

const readBody = (
  where: string,
  name: string,
  entry: Record<string, unknown>,
): Result.Result<Body, ConfigError> =>
  Result.gen(function* () {
    const mode = entry['mode']
    if (mode !== 'broker' && mode !== 'deliver') {
      return yield* bad(
        `${where}: \`secrets.${name}.mode\` must be "broker" or "deliver", not ${JSON.stringify(mode)}. It is written out rather than defaulted because the two differ in what they expose: "broker" keeps the credential on the host, "deliver" puts it inside a VM that an agent has root on.`,
      )
    }

    const source = yield* readSource(where, `secrets.${name}.source`, entry['source'])
    if (mode === 'deliver') {
      for (const key of ['profile', 'repos', 'write']) {
        if (key in entry) {
          return yield* bad(
            `${where}: \`secrets.${name}.${key}\` only means something for a brokered credential. A delivered one is handed to the guest whole, so there is nothing left to scope — set \`mode = "broker"\` to have the host hold it and make the requests.`,
          )
        }
      }
      return { mode, source }
    }
    return { grant: yield* readGrant(where, name, entry), mode, source }
  })

/**
 * The projects a user layer's declaration goes to, by their roots, which have
 * to be absolute: a relative one would match nothing, and the declaration would
 * silently reach no VM.
 */
const readProjects = (
  where: string,
  setting: string,
  raw: unknown,
): Result.Result<readonly string[], ConfigError> =>
  Result.flatMap(readStringList(where, `${setting}.projects`, raw), projects => {
    for (const root of projects) {
      if (!path.isAbsolute(root)) {
        return bad(
          `${where}: ${JSON.stringify(root)} in \`${setting}.projects\` is not a project's root. Name each project by the absolute path of its directory, as \`igloo init\` printed it; ${HOME_RELATIVE}.`,
        )
      }
    }
    return Result.succeed(projects)
  })

/** The user layer's credentials, each with the projects it goes to. */
const readShared = (
  where: string,
  raw: unknown,
): Result.Result<ReadonlyMap<string, Shared>, ConfigError> =>
  Result.gen(function* () {
    const entries = asRecord(raw)
    if (entries === undefined) {
      return yield* bad(
        `${where}: \`secrets\` in the user layer declares credentials, so it is an attribute set — \`secrets.NAME = { source = …; mode = "deliver"; projects = [ … ]; };\`.`,
      )
    }
    const shared = new Map<string, Shared>()
    for (const name of Object.keys(entries)) {
      const entry = yield* readEntry(where, name, entries[name])
      for (const key of Object.keys(entry)) {
        if (!BODY_KEYS.has(key) && key !== 'projects') {
          return yield* bad(
            `${where}: \`secrets.${name}.${key}\` is not a setting. A declaration takes \`source\`, \`mode\` and \`projects\`, ${BODY_SHAPE}.`,
          )
        }
      }
      const body = yield* readBody(where, name, entry)
      const projects = yield* readProjects(where, `secrets.${name}`, entry['projects'])
      shared.set(name, { body, projects })
    }
    return shared
  })

/** A project's own credentials, which go to that project and nowhere else. */
const readOwn = (
  where: string,
  raw: unknown,
): Result.Result<ReadonlyMap<string, Body>, ConfigError> =>
  Result.gen(function* () {
    const entries = asRecord(raw)
    if (entries === undefined) {
      return yield* bad(
        `${where}: \`secrets\` declares this project's own credentials, so it is an attribute set — \`secrets.NAME = { source = …; mode = "deliver"; };\`. A credential the user layer declares reaches every project its \`projects\` lists, and is not named here.`,
      )
    }
    const own = new Map<string, Body>()
    for (const name of Object.keys(entries)) {
      const entry = yield* readEntry(where, name, entries[name])
      for (const key of Object.keys(entry)) {
        if (key === 'projects') {
          return yield* bad(
            `${where}: \`secrets.${name}.projects\` is for a credential the user layer shares between projects. One declared here goes to this project alone, so leave it out.`,
          )
        }
        if (!BODY_KEYS.has(key)) {
          return yield* bad(
            `${where}: \`secrets.${name}.${key}\` is not a setting. A declaration takes \`source\` and \`mode\`, ${BODY_SHAPE}.`,
          )
        }
      }
      own.set(name, yield* readBody(where, name, entry))
    }
    return own
  })

/** A project's policy file, with what composition needs to know of the project. */
interface ProjectPolicy {
  readonly aliases: readonly string[]
  readonly path: string
  readonly root: string
  readonly values: Record<string, unknown>
}

/** Whether a root in a user layer's `projects` names this project, by any spelling of it. */
const listing = (project: ProjectPolicy): ((root: string) => boolean) => {
  const names = new Set([project.root, ...project.aliases])
  return root => names.has(root) || names.has(path.resolve(root))
}

const declaration = (name: string, layer: 'project' | 'user', body: Body): SecretDeclaration =>
  body.mode === 'broker'
    ? { grant: body.grant, layer, mode: 'broker', name, source: body.source }
    : { layer, mode: 'deliver', name, source: body.source }

/**
 * Which credentials this project gets: the ones its own layer declares, and the
 * ones the user layer declares and lists this project in.
 *
 * Only the user layer shares a credential between projects, which is what keeps
 * one project from taking another's: a project's file can declare a source of
 * its own, but it has no way to name a declaration that does not list it.
 */
const composeSecrets = (
  userValues: Record<string, unknown>,
  userPath: string,
  project: ProjectPolicy | undefined,
): Result.Result<readonly SecretDeclaration[], ConfigError> =>
  Result.gen(function* () {
    const fromUser =
      'secrets' in userValues
        ? yield* readShared(userPath, userValues['secrets'])
        : new Map<string, Shared>()
    if (project === undefined) return []

    const own =
      'secrets' in project.values
        ? yield* readOwn(project.path, project.values['secrets'])
        : new Map<string, Body>()

    const listsThis = listing(project)

    const secrets: Array<SecretDeclaration> = []
    for (const [name, shared] of fromUser) {
      if (!shared.projects.some(listsThis)) continue
      // Refused rather than letting one layer win: either answer would leave the
      // other file saying something about this VM that is not true.
      if (own.has(name)) {
        return yield* bad(
          `${project.path}: \`${name}\` is declared here, and ${userPath} gives this project a \`${name}\` too. A name holds one value in the guest, so keep one: remove this project from \`secrets.${name}.projects\` there, or the declaration here.`,
        )
      }
      secrets.push(declaration(name, 'user', shared.body))
    }
    for (const [name, body] of own) secrets.push(declaration(name, 'project', body))

    // One credential per profile: a request names no credential, and one to a
    // forge's API may name no repository either, so the broker would have
    // nothing to choose between two by.
    const fileOf = (secret: SecretDeclaration) =>
      secret.layer === 'user' ? userPath : project.path
    const calling = new Map<string, SecretDeclaration>()
    for (const secret of secrets) {
      if (secret.mode !== 'broker') continue
      const first = calling.get(secret.grant.profile)
      if (first !== undefined) {
        const elsewhere = fileOf(first) === fileOf(secret) ? '' : ` (in ${fileOf(first)})`
        return yield* bad(
          `${fileOf(secret)}: \`${secret.name}\` and \`${first.name}\`${elsewhere} are both brokered for the ${secret.grant.profile} profile. ${isInferenceProfile(secret.grant.profile) ? 'A request names no credential' : 'A request to its API may name no repository'}, so the broker could not tell which one pays: keep one${isInferenceProfile(secret.grant.profile) ? '' : ', and list every repository in it'}.`,
        )
      }
      calling.set(secret.grant.profile, secret)
    }

    // The broker holds its TLS certificate and key beside the credentials,
    // under names of their own that a secret could also take.
    for (const secret of secrets) {
      if (secret.name !== tlsCertificateCredential && secret.name !== tlsKeyCredential) continue
      return yield* bad(
        `${fileOf(secret)}: \`secrets.${secret.name}\` takes a name the broker holds its TLS ${secret.name === tlsKeyCredential ? 'key' : 'certificate'} under, and a name holds one value. Rename the secret.`,
      )
    }
    return secrets
  })

/** What either layer says about one model server, and the projects the user layer gives it to. */
interface ServerEntry {
  readonly body: Omit<ModelServerDeclaration, 'layer' | 'name'>
  readonly projects: readonly string[]
}

/**
 * One layer's `modelServers`: a port on this machine's loopback each, and
 * where the key is read from for a server that wants one. The address is not a
 * setting, so nothing written here can send a request off this machine.
 */
const readServers = (
  where: string,
  layer: 'project' | 'user',
  raw: unknown,
): Result.Result<ReadonlyMap<string, ServerEntry>, ConfigError> =>
  Result.gen(function* () {
    const entries = asRecord(raw)
    if (entries === undefined) {
      return yield* bad(
        `${where}: \`modelServers\` names the model servers on this machine, so it is an attribute set — \`modelServers.NAME = { port = 8080; };\`.`,
      )
    }
    const servers = new Map<string, ServerEntry>()
    for (const name of Object.keys(entries)) {
      const setting = `modelServers.${name}`
      if (!isModelServerName(name)) {
        return yield* bad(
          `${where}: \`${name}\` is not a usable model server name. Use lowercase letters, digits and \`-\`, starting with a letter or digit: the guest reaches the server at a URL with its name in it.`,
        )
      }
      const entry = asRecord(entries[name])
      if (entry === undefined) {
        return yield* bad(
          `${where}: \`${setting}\` must be an attribute set, as in \`{ port = 8080; }\`.`,
        )
      }
      for (const key of Object.keys(entry)) {
        if (key === 'port' || key === 'key' || (key === 'projects' && layer === 'user')) continue
        return yield* bad(
          key === 'projects'
            ? `${where}: \`${setting}.projects\` is for a model server the user layer gives to several projects. One declared here is this project's alone, so leave it out.`
            : `${where}: \`${setting}.${key}\` is not a setting. A model server takes \`port\`${layer === 'user' ? ', `projects`' : ''} and, for one that wants a key, \`key\`. It is always reached on this machine's loopback, so there is no address to set.`,
        )
      }
      const port = entry['port']
      if (!isTcpPort(port)) {
        return yield* bad(
          `${where}: \`${setting}.port\` must be the port the server listens on at 127.0.0.1, from 1 to 65535, not ${JSON.stringify(port)}.`,
        )
      }
      const key =
        'key' in entry ? yield* readSource(where, `${setting}.key`, entry['key']) : undefined
      servers.set(name, {
        body: { ...(key === undefined ? {} : { key }), port },
        projects: layer === 'user' ? yield* readProjects(where, setting, entry['projects']) : [],
      })
    }
    return servers
  })

/**
 * Which model servers this project's broker may call: the ones its own layer
 * declares, and the ones the user layer declares and lists this project in.
 */
const composeModelServers = (
  userValues: Record<string, unknown>,
  userPath: string,
  project: ProjectPolicy | undefined,
): Result.Result<readonly ModelServerDeclaration[], ConfigError> =>
  Result.gen(function* () {
    const fromUser =
      'modelServers' in userValues
        ? yield* readServers(userPath, 'user', userValues['modelServers'])
        : new Map<string, ServerEntry>()
    if (project === undefined) return []

    const own =
      'modelServers' in project.values
        ? yield* readServers(project.path, 'project', project.values['modelServers'])
        : new Map<string, ServerEntry>()

    const listsThis = listing(project)
    const servers: Array<ModelServerDeclaration> = []
    for (const [name, { body, projects }] of fromUser) {
      if (!projects.some(listsThis)) continue
      if (own.has(name)) {
        return yield* bad(
          `${project.path}: \`modelServers.${name}\` is declared here, and ${userPath} gives this project a \`${name}\` too. A name reaches one server, so keep one: remove this project from \`modelServers.${name}.projects\` there, or the declaration here.`,
        )
      }
      servers.push({ ...body, layer: 'user', name })
    }
    for (const [name, { body }] of own) servers.push({ ...body, layer: 'project', name })
    return servers
  })

const checkKeys = (
  layer: 'project' | 'user',
  source: PolicyLayer,
  userPolicyName: string,
): Result.Result<void, ConfigError> => {
  for (const key of Object.keys(source.values)) {
    const gone = removed.get(key)
    if (gone !== undefined) {
      return bad(`${source.path}: \`${key}\` is no longer a setting: ${gone}`)
    }
    const scope = settings.get(key)
    if (scope === undefined) {
      return bad(
        `${source.path}: unknown policy setting \`${key}\`. This layer may set: ${allowedIn(layer)}.`,
      )
    }
    if (scope === 'project' && layer === 'user') {
      return bad(
        `${source.path}: \`${key}\` is a project's own request, so it belongs in that project's \`${POLICY}\`. The user layer sets \`tunnelCeiling\`, the destinations a project is *allowed* to ask for; each project then lists the ones it uses. A project reaches nothing it did not list.`,
      )
    }
    if (scope === 'user' && layer === 'project') {
      return bad(
        key === 'tunnelCeiling'
          ? `${source.path}: \`tunnelCeiling\` is the bound on what this project may reach, so it belongs in ${userPolicyName} rather than in the project it bounds — a project raising its own ceiling is not a ceiling. List what this project uses in \`tunnel\`.`
          : `${source.path}: \`${key}\` is machine-local, so it belongs in the user layer at ${userPolicyName} rather than in a project — how much memory and how many CPUs a VM and its broker get are properties of this machine, not of the repository.`,
      )
    }
  }
  return Result.succeed(undefined)
}

/**
 * Compose the layers into the policy a VM is launched with, or say why they
 * cannot be composed.
 *
 * Pure, so every diagnostic is asserted rather than eyeballed — which matters
 * more here than anywhere else in the tool, because a policy that composed to
 * something other than what was written is the failure this whole split exists
 * to prevent, and the only evidence a user gets is the message.
 *
 * Policy is composed on the host, not in Nix, for two reasons. The diagnostics
 * are the feature: a ceiling violation has to name both files and say which way
 * to resolve it, and a Nix `throw` from inside a module evaluation cannot. And
 * the host needs the effective policy anyway — it decides what the broker
 * allows, and the generated flake records what was launched.
 */
export const compose = (layers: Layers): Result.Result<Composed, ConfigError> =>
  Result.gen(function* () {
    const user = layers.user
    const project = layers.project
    if (user !== undefined) yield* checkKeys('user', user, layers.userPolicyName)
    if (project !== undefined) yield* checkKeys('project', project, layers.userPolicyName)

    const userValues = user?.values ?? {}
    const userPath = user?.path ?? layers.userPolicyName

    const vcpu =
      'vcpu' in userValues
        ? yield* readInt(userPath, 'vcpu', userValues['vcpu'])
        : coreDefaults.vcpu
    const mem =
      'mem' in userValues ? yield* readInt(userPath, 'mem', userValues['mem']) : coreDefaults.mem
    const brokerMem =
      'brokerMem' in userValues
        ? yield* readInt(userPath, 'brokerMem', userValues['brokerMem'])
        : coreDefaults.brokerMem
    // QEMU hangs at exactly 2 GiB with no output and no exit, so the symptom is a
    // boot that never completes. `mkRunner` asserts this too; failing here gets
    // the reader a sentence instead of a Nix evaluation trace.
    if (mem === 2048) {
      return yield* bad(
        `${userPath}: \`mem = 2048\` hangs QEMU — a VM built with it never finishes booting and never exits. Use 2047 or 4096.`,
      )
    }

    const ceiling =
      'networkCeiling' in userValues
        ? yield* readMode(userPath, 'networkCeiling', userValues['networkCeiling'])
        : undefined
    const preferred =
      'network' in userValues
        ? yield* readMode(userPath, 'network', userValues['network'])
        : undefined
    const requested =
      project === undefined || !('network' in project.values)
        ? undefined
        : yield* readMode(project.path, 'network', project.values['network'])

    if (ceiling !== undefined && preferred !== undefined && rank(preferred) > rank(ceiling)) {
      return yield* bad(
        `${userPath}: \`network = "${preferred}"\` is above the same layer's own \`networkCeiling = "${ceiling}"\`. Raise the ceiling or lower the default.`,
      )
    }
    if (
      project !== undefined &&
      requested !== undefined &&
      ceiling !== undefined &&
      rank(requested) > rank(ceiling)
    ) {
      return yield* bad(
        `${project.path}: \`network = "${requested}"\` exceeds the ceiling \`networkCeiling = "${ceiling}"\` set in ${userPath}. A project may narrow the ceiling, not widen it — raise the ceiling or lower the request.`,
      )
    }

    // A ceiling with no default beside it *is* the default: reading "my ceiling
    // is none" as "default to internet until a project asks otherwise" would be the
    // one surprise a ceiling exists to rule out. An explicit request still
    // decides, because that is what the ceiling bounds.
    const base =
      preferred ??
      (ceiling !== undefined && rank(coreDefaults.network) > rank(ceiling)
        ? ceiling
        : coreDefaults.network)

    const network = requested ?? base

    // Deny by default, and the ceiling is the whole of what may be asked for: a
    // project reaches exactly what it lists, an absent ceiling is an empty one,
    // and listing nothing is no tunnel at all. That is the opposite default from
    // `network`, deliberately — a posture has a sensible default and an
    // authorization does not.
    const ceilingHosts =
      'tunnelCeiling' in userValues
        ? yield* readHosts(userPath, 'tunnelCeiling', userValues['tunnelCeiling'])
        : []
    const asked =
      project === undefined || !('tunnel' in project.values)
        ? []
        : yield* readHosts(project.path, 'tunnel', project.values['tunnel'])

    for (const host of asked) {
      if (ceilingHosts.some(allowed => allowed.toLowerCase() === host.toLowerCase())) continue
      return yield* bad(
        ceilingHosts.length === 0
          ? `${project?.path ?? userPath}: \`tunnel\` asks for ${host}, but ${userPath} sets no \`tunnelCeiling\`, so no destination is allowed. Add it there first:\n\n  tunnelCeiling = [ "${host}" ];`
          : `${project?.path ?? userPath}: \`tunnel\` asks for ${host}, which is not in the \`tunnelCeiling\` set in ${userPath} (${ceilingHosts.join(', ')}). A project may narrow the ceiling, not widen it — add it there, or drop it here.`,
      )
    }

    const projectPolicy =
      project === undefined || layers.projectRoot === undefined
        ? undefined
        : {
            aliases: layers.projectAliases,
            path: project.path,
            root: layers.projectRoot,
            values: project.values,
          }
    const secrets = yield* composeSecrets(userValues, userPath, projectPolicy)
    const modelServers = yield* composeModelServers(userValues, userPath, projectPolicy)

    // A model server's key is held beside the brokered credentials, under a
    // name of its own that a secret could also take.
    for (const server of modelServers) {
      if (server.key === undefined) continue
      const held = modelServerKeyName(server.name)
      if (secrets.some(secret => secret.name === held)) {
        return yield* bad(
          `${projectPolicy?.path ?? userPath}: \`secrets.${held}\` takes the name that \`modelServers.${server.name}.key\` is held under, and a name holds one value. Rename the secret.`,
        )
      }
    }

    // `none` is the broker offering nothing, so anything that would make it
    // offer something is a contradiction rather than a detail. Refused rather
    // than dropped: dropping it is how someone believes a VM can reach a
    // destination, or holds a credential, that it cannot.
    const where = project?.path ?? userPath
    if (network === 'none' && asked.length > 0) {
      return yield* bad(
        `${where}: \`tunnel\` lists destinations, but \`network = "none"\` reaches nothing. Use \`network = "restricted"\` to reach only those.`,
      )
    }
    const brokeredUnderNone = secrets.find(secret => secret.mode === 'broker')
    if (network === 'none' && brokeredUnderNone !== undefined) {
      return yield* bad(
        `${where}: ${brokeredUnderNone.name} is brokered, which reaches its upstream on this VM's behalf, but \`network = "none"\` reaches nothing. Use \`network = "restricted"\` to reach only what its grant allows.`,
      )
    }
    const servedUnderNone = modelServers[0]
    if (network === 'none' && servedUnderNone !== undefined) {
      return yield* bad(
        `${where}: \`modelServers.${servedUnderNone.name}\` is reached through the broker, but \`network = "none"\` reaches nothing. Use \`network = "restricted"\` with no \`tunnel\` to reach the model server and nothing else.`,
      )
    }

    // A VM with no grant and no destination is `none` wearing another word, and
    // the way someone finds that out otherwise is a build that works and an
    // agent that cannot reach anything.
    const quiet =
      network === 'restricted' &&
      asked.length === 0 &&
      secrets.every(secret => secret.mode !== 'broker') &&
      modelServers.length === 0
        ? [
            `${where}: \`network = "restricted"\` with no \`tunnel\` destinations, no brokered credential and no model server reaches nothing at all, which is what \`"none"\` says more plainly`,
          ]
        : []

    // Harmless, since `internet` reaches any public name already — but a list
    // that decides nothing is one someone will read as deciding something.
    const unused =
      network === 'internet' && asked.length > 0
        ? [
            `${where}: \`tunnel\` has no effect under \`network = "internet"\`, which reaches any public name; it applies only under \`"restricted"\``,
          ]
        : []

    // The project's alone, and nothing bounds it: the file that declares a port
    // is already outside the workspace, so it is written by the same person the
    // port is published to. A ceiling over it would bound nobody — unlike
    // `tunnelCeiling`, which bounds what the *guest* can reach.
    const ports =
      project === undefined || !('ports' in project.values)
        ? []
        : yield* readPorts(project.path, 'ports', project.values['ports'])

    return {
      notes: [...quiet, ...unused],
      policy: {
        brokerMem,
        mem,
        modelServers,
        network,
        ports,
        secrets,
        tunnel: network === 'internet' ? 'any' : network === 'restricted' ? asked : [],
        vcpu,
      },
    }
  })

/**
 * What `nix eval --json` prints for the expression below: one entry per policy
 * file that exists. Nothing is known about a layer's own keys here — validating
 * them is `checkKeys`' job, which can say where a setting belongs rather than only
 * that it does not fit.
 */
const Evaluated = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

/**
 * One layer's settings, or `undefined` if it is not an attribute set. Rebuilt
 * entry by entry rather than asserted into shape, so that an array or a string
 * from a mistyped policy file is caught here and not by a reader further on.
 */
const asValues = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const values: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    values[key] = Reflect.get(value, key)
  }
  return values
}

/**
 * Evaluate the policy files that exist, in one `nix eval`.
 *
 * nix's stderr is inherited rather than captured: a syntax error in a policy file
 * is already the best available message, and reprinting a captured copy of it
 * would only bury it. Nothing is evaluated when neither file exists, so a project
 * with no configuration pays nothing for this.
 */
const readPolicyFiles = Effect.fnUntraced(function* (
  nix: string,
  files: { readonly project: string | undefined; readonly user: string | undefined },
) {
  // Only the files that exist are named: naming an absent one fails the whole
  // evaluation, which would take the layer that does exist with it.
  const parts: Array<string> = []
  if (files.user !== undefined) parts.push(`user = import "${nixString(files.user)}";`)
  if (files.project !== undefined) parts.push(`project = import "${nixString(files.project)}";`)
  if (parts.length === 0) return { project: undefined, user: undefined }

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const existing = [files.user, files.project].filter(file => file !== undefined)
  const named = existing.join(' and ')
  // A project's policy file is Nix too, and may be one someone handed over, so
  // it is read under the same confinement as the content layers: the files
  // themselves and the store, and nothing fetched.
  const allowance = { paths: yield* Evaluation.readable(existing), uris: [] }
  const raw = yield* spawner
    .string(
      ChildProcess.make(
        nix,
        ['eval', ...Evaluation.args(allowance), '--json', '--expr', `{ ${parts.join(' ')} }`],
        {
          extendEnv: true,
          stderr: 'inherit',
          stdin: 'ignore',
        },
      ),
    )
    .pipe(Effect.orElseSucceed(() => ''))

  const parsed = yield* Schema.decodeEffect(Evaluated)(raw).pipe(
    Effect.mapError(
      () =>
        new ConfigError({
          message: `cannot read ${named}: \`nix eval\` returned nothing usable — its own error is above. A policy file must evaluate to an attribute set of settings, not to a function or a NixOS module, and may read nothing on the host but itself and the store.`,
        }),
    ),
  )

  const layer = Effect.fnUntraced(function* (name: 'project' | 'user', file: string | undefined) {
    if (file === undefined) return undefined
    const values = asValues(parsed[name])
    if (values === undefined) {
      return yield* new ConfigError({
        message: `${file}: a policy file must be an attribute set of settings, e.g. \`{ network = "none"; }\`.`,
      })
    }
    return { path: file, values }
  })

  return { project: yield* layer('project', files.project), user: yield* layer('user', files.user) }
})

/**
 * The entries in the user layer's `projects` lists that name `root` by another
 * path — the same directory reached through a symlink, most likely.
 *
 * A project is identified by its canonical root, but a configuration names it
 * however its author reaches it. Nothing on the project's side asks for a
 * credential the user layer gives it, so a spelling that missed would deliver
 * nothing and say nothing.
 */
const aliasesOf = Effect.fnUntraced(function* (
  userValues: Record<string, unknown> | undefined,
  root: string | undefined,
) {
  if (userValues === undefined || root === undefined) return []
  const fs = yield* FileSystem.FileSystem
  const listed = new Set<string>()
  for (const entry of Object.values(asRecord(userValues['secrets']) ?? {})) {
    const projects: unknown = asRecord(entry)?.['projects']
    if (!Array.isArray(projects)) continue
    for (const project of projects as readonly unknown[]) {
      if (typeof project === 'string' && project !== root && path.isAbsolute(project)) {
        listed.add(project)
      }
    }
  }
  const aliases: Array<string> = []
  for (const project of listed) {
    const real = yield* fs.realPath(project).pipe(Effect.orElseSucceed(() => undefined))
    if (real === root) aliases.push(project)
  }
  return aliases
})

const note = (message: string): Effect.Effect<void> =>
  Effect.sync(() => process.stderr.write(`igloo: ${message}\n`))

/**
 * What the workspace may and may not hold, checked before anything is read.
 *
 * A policy file there is **refused**: honouring it would let the sandbox widen its
 * own boundary, and ignoring it is the trap the split creates — a network mode
 * written in the wrong file, nothing happening, and the author believing it took.
 *
 * A content file there is only noted, because content from the workspace is
 * legitimate; it just has to be imported from the project layer rather than picked
 * up automatically, or the VM's contents would be decided by a file the VM itself
 * can edit.
 */
const auditWorkspace = Effect.fnUntraced(function* (
  workspaceDir: string,
  projectFiles: LayerFiles,
) {
  const fs = yield* FileSystem.FileSystem
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false))

  const stray = path.join(workspaceDir, POLICY)
  if (yield* exists(stray)) {
    return yield* new ConfigError({
      message: `${stray} is in the workspace, which the guest can write, so policy may not come from there. Move it to ${projectFiles.policy}.`,
    })
  }
  const unread = path.join(workspaceDir, CONTENT)
  if (yield* exists(unread)) {
    yield* note(
      `${unread} is not read; import it from ${projectFiles.content} if you meant to use it`,
    )
  }
})

/**
 * Find the layers, read them, and compose them.
 *
 * `userLayerDir` is `undefined` for no user layer, and `project` for a command
 * that runs outside a project.
 *
 * Each content module comes back with the name a message gives it, beside the
 * file the build imports.
 */
export const resolve = Effect.fn('Config.resolve')(function* (
  bins: Binaries,
  input: {
    readonly project: { readonly root: string; readonly workspaceDir: string } | undefined
    readonly userLayerDir: string | undefined
  },
) {
  const fs = yield* FileSystem.FileSystem
  const present = (file: string) =>
    fs.exists(file).pipe(
      Effect.orElseSucceed(() => false),
      Effect.map(yes => (yes ? file : undefined)),
    )

  // Named explicitly, so a directory that is not there is a mistake rather than
  // a user with no layer: every VM would start without the agents it declares.
  if (input.userLayerDir !== undefined && (yield* present(input.userLayerDir)) === undefined) {
    return yield* new ConfigError({
      message: `IGLOO_USER_LAYER names ${input.userLayerDir}, which does not exist. Run the \`igloo\` that home-manager installs, which sets it, or unset it for no user layer.`,
    })
  }
  const userFiles = input.userLayerDir === undefined ? undefined : userLayer(input.userLayerDir)
  const userNames = userLayerNames(input.userLayerDir)
  const projectFiles = input.project === undefined ? undefined : projectLayer(input.project.root)
  if (input.project !== undefined && projectFiles !== undefined) {
    yield* auditWorkspace(input.project.workspaceDir, projectFiles)
  }

  const policyFiles = {
    project: projectFiles === undefined ? undefined : yield* present(projectFiles.policy),
    user: userFiles === undefined ? undefined : yield* present(userFiles.policy),
  }
  const layers = yield* readPolicyFiles(bins.nix, policyFiles)
  const { notes, policy } = yield* Effect.fromResult(
    compose({
      project: layers.project,
      projectAliases: yield* aliasesOf(layers.user?.values, input.project?.root),
      projectRoot: input.project?.root,
      user: layers.user === undefined ? undefined : { ...layers.user, path: userNames.policy },
      userPolicyName: userNames.policy,
    }),
  )
  for (const message of notes) yield* note(message)

  // User first, so a project's module overrides it by ordinary module semantics
  // rather than by anything igloo invented.
  const content: Array<{ readonly file: string; readonly name: string }> = []
  const candidates = [
    ...(userFiles === undefined ? [] : [{ file: userFiles.content, name: userNames.content }]),
    ...(projectFiles === undefined
      ? []
      : [{ file: projectFiles.content, name: projectFiles.content }]),
  ]
  for (const candidate of candidates) {
    if ((yield* present(candidate.file)) !== undefined) content.push(candidate)
  }

  return { content, policy }
})
