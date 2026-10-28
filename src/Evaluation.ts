import type { Binaries } from './Binaries.ts'

import { Effect, FileSystem, Option, Schema } from 'effect'
import { ChildProcess } from 'effect/unstable/process'
import * as path from 'node:path'

/**
 * How igloo evaluates Nix that someone other than igloo wrote: the content
 * layers, when the runner is built, and the policy files, when they are read.
 *
 * Both run as the developer, on the host, before any VM exists — so without
 * this, a module could read any file the developer can and fetch it out. The
 * evaluation runs in nix's restricted mode instead, and nix under Landlock
 * (`command`): it may read the store and the paths and flakes named here, may
 * fetch only the URIs named here, and nothing else on the host is reachable.
 *
 * Restricted rather than pure. Pure evaluation reads only flake inputs, so every
 * store path a layer imports — each module a home-manager configuration hands
 * over — would have to become an input of the generated flake, and a layer's
 * relative imports would stop resolving. The allow-list keeps both.
 */
export interface Allowance {
  /** Files and directories evaluation may read, besides the flakes. */
  readonly paths: readonly string[]
  /**
   * The flakes evaluated: the runner's and igloo's. nix reads a flake for the
   * evaluation rather than as a file the evaluation names, so restricted mode
   * does not check them, and Landlock has to be told.
   */
  readonly flakes: readonly string[]
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
 * nix's options that confine one evaluation: the runner's, or the policy files'.
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
 * What nix's garbage collector reads, and warns on every evaluation without:
 * its process's memory map, for the main thread's stack, and the processor
 * count. `igloo-landlock` opens `/proc/self/maps` before it becomes nix, so the
 * rule is on nix's own. The one file rather than `/proc/self`, which holds
 * nix's environment, and so the developer's.
 */
const NIX_OWN = ['/proc/self/maps', '/proc/stat']

/**
 * `igloo-landlock`'s arguments for one evaluation, through the `--` that ends
 * them. `cache` is the only place it may write.
 */
export const confinement = (allowance: Allowance, cache: string): Array<string> => [
  '--connect-tcp',
  '443',
  '--connect-tcp',
  '53',
  ...[...new Set([STORE, ...allowance.paths, ...allowance.flakes, ...NIX_OWN])].flatMap(
    readable => ['--read', readable],
  ),
  '--write',
  cache,
  '--',
]

/**
 * `nix` with `nixArgs`, confined to the allowance twice: by `args`, and by the
 * kernel, under `igloo-landlock`.
 *
 * Restricted mode checks what the evaluation reads, and nix reads some of it
 * without asking: `builtins.getFlake "path:<directory>"` copies any directory
 * the developer can read into the store, where the evaluation may read it, and
 * the copy stays there. Under Landlock nix may read only the store, the paths
 * and flakes the allowance names, and what its garbage collector reads; may
 * write only a cache of its own, `NIX_CACHE_HOME`, fresh for this evaluation,
 * in place of the developer's, which holds a copy of everything nix has fetched
 * for them; and may connect over TCP only to 443, the port of every URI it may
 * fetch, and to 53, for a resolver that retries over TCP. It reaches the daemon
 * through a Unix socket with a path, which Landlock does not see.
 *
 * A fresh cache costs no download: nix takes an input a lock file names from
 * the store when it is there, without asking the cache. A `nix.conf` outside
 * the store is not readable, and nix goes on without it; NixOS and home-manager
 * keep theirs in the store.
 */
export const command = Effect.fnUntraced(function* (
  programs: Pick<Binaries, 'landlock' | 'nix'>,
  allowance: Allowance,
  nixArgs: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem
  const cache = yield* fs.makeTempDirectoryScoped({ prefix: 'igloo-nix-cache-' })
  return ChildProcess.make(
    programs.landlock,
    [...confinement(allowance, cache), programs.nix, ...nixArgs, ...args(allowance)],
    { env: { NIX_CACHE_HOME: cache }, extendEnv: true, stderr: 'inherit', stdin: 'ignore' },
  )
})

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
 * its workspace, the runner's flake and igloo's, and the inputs igloo's own
 * flake is locked to.
 *
 * The workspace is readable because content may come from it — a project layer
 * importing a module the repository carries. Nothing there is hidden from the
 * guest, which mounts it. Of the rest of the project directory only the
 * runner's flake is readable, which igloo writes, and the rest is where the
 * VM's private key is.
 */
export const forRunner = Effect.fnUntraced(function* (input: {
  readonly iglooFlakePath: string
  readonly runnerDir: string
  readonly contentModules: readonly string[]
  readonly workspaceDir: string
}) {
  const fs = yield* FileSystem.FileSystem
  const lock = yield* fs
    .readFileString(path.join(input.iglooFlakePath, 'flake.lock'))
    .pipe(Effect.orElseSucceed(() => ''))
  return {
    paths: yield* readable([...input.contentModules, input.workspaceDir]),
    flakes: [input.runnerDir, input.iglooFlakePath],
    uris: lockedUris(lock),
  } satisfies Allowance
})
