import { Effect, FileSystem, Option, Schema } from 'effect'
import * as path from 'node:path'

/**
 * How igloo evaluates Nix that someone other than igloo wrote: the content
 * layers, when the runner is built, and the policy files, when they are read.
 *
 * Both run as the developer, on the host, before any VM exists — so without
 * this, a module could read any file the developer can and fetch it out. The
 * evaluation runs in nix's restricted mode instead: it may read the store, the
 * paths named here and the flake's own inputs, may fetch only the URIs named
 * here, and nothing else on the host is reachable.
 *
 * Restricted rather than pure. Pure evaluation reads only flake inputs, so every
 * store path a layer imports — each module a home-manager configuration hands
 * over — would have to become an input of the generated flake, and a layer's
 * relative imports would stop resolving. The allow-list keeps both.
 */
export interface Allowance {
  /** Files and directories evaluation may read, besides the flake's inputs. */
  readonly paths: readonly string[]
  /** URI prefixes evaluation may fetch. The flake's own inputs are fetches too. */
  readonly uris: readonly string[]
}

/**
 * Always readable. The store is world-readable on the host already, and it is
 * where a layer declared through home-manager lives, along with every module
 * and package it names.
 */
export const STORE = '/nix/store'

/**
 * The arguments that confine one evaluation: the runner's, or the policy files'.
 *
 * `--impure` is part of the confinement rather than an exception to it: pure
 * mode ignores `-I`, so it could not be told which layer files to read.
 *
 * Every entry is named. An unnamed `-I /nix/store` also answers `<name>`
 * lookups, and nixpkgs looks up `<nixpkgs-overlays>`, which then resolves to a
 * store path that is not one and fails the evaluation. `nix-path` is emptied so
 * that nothing from the caller's `NIX_PATH` or configuration is readable, and
 * `builtins.exec` is switched off, since a host that enables it would otherwise
 * let a module run commands whatever else is allowed.
 *
 * Import from derivation is off, because it builds during evaluation, before
 * anything has checked what the build runs: a fixed-output derivation imported
 * that way would reach the network first. A layer that needs one is refused
 * by nix, naming the option.
 */
export const args = (allowance: Allowance): Array<string> => [
  '--impure',
  '--option',
  'restrict-eval',
  'true',
  '--option',
  'allowed-uris',
  allowance.uris.join(' '),
  '--option',
  'nix-path',
  '',
  '--option',
  'allow-unsafe-native-code-during-evaluation',
  'false',
  '--option',
  'allow-import-from-derivation',
  'false',
  ...allowance.paths.flatMap((allowed, index) => [
    '-I',
    `igloo-allowed-${String(index)}=${allowed}`,
  ]),
]

/**
 * The store, and each path with the file it resolves to.
 *
 * nix checks both the path it was given and the file that path resolves to, so
 * a layer that is a symlink needs both. A path that resolves into the store is
 * covered by the store already, which is where home-manager puts a layer.
 */
export const readable = Effect.fnUntraced(function* (paths: readonly string[]) {
  const fs = yield* FileSystem.FileSystem
  const allowed = new Set([STORE])
  for (const given of paths) {
    const real = yield* fs.realPath(given).pipe(Effect.orElseSucceed(() => given))
    for (const candidate of [given, real]) {
      if (!candidate.startsWith(`${STORE}/`)) allowed.add(candidate)
    }
  }
  return [...allowed]
})

const Lock = Schema.fromJsonString(
  Schema.Struct({
    nodes: Schema.Record(
      Schema.String,
      Schema.Struct({
        locked: Schema.optionalKey(
          Schema.Struct({
            narHash: Schema.optionalKey(Schema.String),
            owner: Schema.optionalKey(Schema.String),
            repo: Schema.optionalKey(Schema.String),
            rev: Schema.optionalKey(Schema.String),
            type: Schema.String,
          }),
        ),
      }),
    ),
  }),
)

/**
 * A query value as nix writes it in the URI it checks: percent-encoded but for
 * the unreserved characters and `/`, so a hash's `+` and `=` are `%2B` and
 * `%3D`.
 */
const queryValue = (value: string): string => encodeURIComponent(value).replaceAll('%2F', '/')

/**
 * What a flake's lock file lets it fetch, as URI prefixes.
 *
 * Restricted mode checks a flake's own inputs against the list as well, even
 * locked and already in the store, so the runner cannot be evaluated without
 * them. A GitHub input is allowed at its locked revision and hash, the URI nix
 * checks when it fetches that input. Its repository alone would allow any
 * revision, and a `host` attribute with it, which sends the fetch to a server
 * the evaluated Nix names. An input of any other type, or one locked without a
 * revision and hash, is left out, and if evaluation ever needs one, nix's
 * refusal names its URI. An unreadable lock allows nothing, which fails the
 * same way.
 */
export const lockedUris = (lock: string): Array<string> =>
  Option.match(Schema.decodeOption(Lock)(lock), {
    onNone: () => [],
    onSome: ({ nodes }) => [
      ...new Set(
        Object.values(nodes).flatMap(({ locked }) =>
          locked?.type === 'github' &&
          locked.owner !== undefined &&
          locked.repo !== undefined &&
          locked.rev !== undefined &&
          locked.narHash !== undefined
            ? [
                `github:${locked.owner}/${locked.repo}/${locked.rev}?narHash=${queryValue(locked.narHash)}`,
              ]
            : [],
        ),
      ),
    ],
  })

/**
 * What evaluating one project's runner may read and fetch: its content layers,
 * its workspace, and the inputs igloo's own flake is locked to.
 *
 * The workspace is readable because content may come from it — a project layer
 * importing a module the repository carries. Nothing there is hidden from the
 * guest, which mounts it. The rest of the project directory is not readable,
 * and that is where the VM's private key is.
 */
export const forRunner = Effect.fnUntraced(function* (input: {
  readonly iglooFlakePath: string
  readonly contentModules: readonly string[]
  readonly workspaceDir: string
}) {
  const fs = yield* FileSystem.FileSystem
  const lock = yield* fs
    .readFileString(path.join(input.iglooFlakePath, 'flake.lock'))
    .pipe(Effect.orElseSucceed(() => ''))
  return {
    paths: yield* readable([...input.contentModules, input.workspaceDir]),
    uris: lockedUris(lock),
  } satisfies Allowance
})
