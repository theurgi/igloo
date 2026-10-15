import { Effect } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

/**
 * The host store, which is also the path the restricted view is mounted at and
 * the `source` of the share that carries it. A caller compares a share's source
 * against this to decide which daemon needs the view at all.
 */
export const storeDir = '/nix/store'

/**
 * The store paths the guest may see: the runner's closure, which is the guest
 * system plus the host-side launch tooling that references it. `nix path-info
 * -r` is a store-database query rather than a build, so this costs well under
 * a second.
 *
 * An empty result is returned as-is. The caller then builds a store view with
 * no paths and the boot fails immediately, which is the right outcome — the
 * alternative would be silently serving the entire host store.
 */
export const closure = Effect.fnUntraced(function* (nix: string, outPath: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const lines = yield* spawner
    .lines(ChildProcess.make(nix, ['path-info', '-r', outPath], { extendEnv: true }))
    .pipe(Effect.orElseSucceed(() => [] as Array<string>))
  return lines.map(s => s.trim()).filter(s => s.startsWith(`${storeDir}/`))
})

/** Whether `path` is inside one of the closure's store paths. */
export const covers = (closurePaths: readonly string[], path: string): boolean =>
  closurePaths.some(member => path === member || path.startsWith(`${member}/`))

/**
 * The store path `path` is inside — `/nix/store/<name>` — or `undefined` for a
 * path outside the store.
 */
export const storePathOf = (path: string): string | undefined => {
  const name = path.startsWith(`${storeDir}/`) ? path.slice(storeDir.length + 1).split('/')[0] : ''
  return name === undefined || name === '' ? undefined : `${storeDir}/${name}`
}

/**
 * The file `igloo-store-view` reads the paths from: one per line. A file rather
 * than arguments, because a closure runs to thousands of paths.
 */
export const pathsFile = (closurePaths: readonly string[]): string =>
  closurePaths.map(member => `${member}\n`).join('')

/**
 * Run `argv` under `igloo-store-view`, in a namespace whose `/nix/store` is a
 * read-only tmpfs holding only the paths `paths` lists, bound at their real
 * names.
 *
 * virtiofsd serves `--shared-dir=/nix/store`, so restricting what it can see
 * restricts what the guest can see, without touching the share's `source` or
 * any of microvm.nix's guest-side store logic. Two things come out of it: the
 * guest gets least privilege over the host store, and virtiofsd's inode set is
 * bounded, which is what keeps it from accumulating file descriptors to
 * `ENFILE` across a long session.
 *
 * Everything runs unprivileged. `argv[0]` has to be inside one of the listed
 * paths, since it is executed from inside the view.
 */
export const argv = (options: {
  readonly argv: readonly [string, ...string[]]
  readonly helper: string
  readonly paths: string
}): [string, ...string[]] => [options.helper, options.paths, ...options.argv]
