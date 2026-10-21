import { DateTime, Effect, FileSystem, Schema } from 'effect'
import * as path from 'node:path'

import * as Cid from './Cid.ts'

export class ProjectError extends Schema.TaggedError<ProjectError>()('ProjectError', {
  message: Schema.String,
}) {}

/** Relative to the project root. Its presence is what makes a directory a project. */
const MARKER = '.igloo/project.json'

/**
 * Deliberately without a `name`. A project's label is its directory's basename,
 * and nothing that has to be unique is derived from it — see `forRoot`. A `name`
 * field can be added later without any of that changing.
 */
export const Marker = Schema.Struct({
  createdAt: Schema.String,
  version: Schema.Literal(1),
})

const MarkerJson = Schema.fromJsonString(Marker, { space: 2 })

/**
 * A project and every path derived from it.
 *
 * Everything durable lives under `.igloo/`, inside the project, so it is unique
 * by containment rather than by a name anyone has to keep distinct. The one
 * exception is the units' working directory, which holds the vhost-user sockets
 * and belongs on a tmpfs; the caller supplies that, since it depends on the
 * process environment.
 */
export interface Project {
  /** `<root>/.igloo` — everything igloo keeps for this project. */
  readonly iglooDir: string
  /** Guest CID, a pure function of `root`. */
  readonly cid: number
  /** Backs the guest's `/root`. */
  readonly homeDir: string
  /** `<label>-<cid in hex>`. Names the slice and both units. */
  readonly id: string
  /** For display. Not unique; two projects may share one. */
  readonly label: string
  /**
   * What the VM that is running was launched from, a hash per input. Read to
   * tell that VM its configuration has moved on since it started.
   */
  readonly launchInputsFile: string
  readonly logDir: string
  /** Canonical root path: resolved through symlinks, no trailing slash. */
  readonly root: string
  /** Holds the generated flake that builds this project's runner. */
  readonly runnerDir: string
  /** gc-root symlink pinning this project's runner closure. */
  readonly runnerRootLink: string
  /** Holds the keypair the host connects to the guest with. */
  readonly sshDir: string
  /** Holds the broker's TLS certificate and key, and the authority the guest trusts. */
  readonly tlsDir: string
  /** Mounted into the guest at `/workspace`. */
  readonly workspaceDir: string
}

/**
 * Derive everything from a project root.
 *
 * **`root` must already be canonical.** `find` resolves it; a caller passing a
 * path with a symlink or a trailing slash in it gets a different CID and a
 * different slice for what is really the same project, which is the one failure
 * the path-as-identity choice exists to prevent.
 */
export const forRoot = (root: string, cid?: number): Project => {
  const vsockCid = cid ?? Cid.forIdentity(root)
  const label = path.basename(root)
  const iglooDir = path.join(root, '.igloo')
  return {
    iglooDir,
    cid: vsockCid,
    homeDir: path.join(iglooDir, 'home'),
    id: `${label}-${vsockCid.toString(16)}`,
    label,
    // Not in `runner/`, which is a flake directory: this records what a VM was
    // launched from, and is not itself an input to building one.
    launchInputsFile: path.join(iglooDir, 'launched-from.json'),
    logDir: path.join(iglooDir, 'logs'),
    root,
    runnerDir: path.join(iglooDir, 'runner'),
    // Not `result`: `nh clean` deletes indirect gc-roots whose path matches
    // `.*result.*` and then collects, which has taken the store paths out from
    // under a running VM. This name matches neither of its patterns.
    runnerRootLink: path.join(iglooDir, 'runners', 'current'),
    sshDir: path.join(iglooDir, 'ssh'),
    tlsDir: path.join(iglooDir, 'tls'),
    workspaceDir: path.join(root, 'workspace'),
  }
}

/**
 * Split an `id` back into the label and CID it was built from, or `undefined` if
 * it does not look like one.
 *
 * The suffix must parse as hex **and** land in the range derived CIDs occupy,
 * which is what keeps a project legitimately named `api-2c` from being read as
 * label `api` on CID 44. A hand-picked `--cid` below that floor is not
 * recognised here, and surfaces as the whole id in the label with no CID.
 */
export const parseId = (
  id: string,
): { readonly cid: number; readonly label: string } | undefined => {
  const cut = id.lastIndexOf('-')
  if (cut <= 0) return undefined
  const suffix = id.slice(cut + 1)
  if (!/^[0-9a-f]+$/.test(suffix)) return undefined
  const cid = Number.parseInt(suffix, 16)
  return cid < Cid.MIN || cid > Cid.MAX ? undefined : { cid, label: id.slice(0, cut) }
}

const readMarker = Effect.fnUntraced(function* (markerPath: string) {
  const fs = yield* FileSystem.FileSystem
  const raw = yield* fs
    .readFileString(markerPath)
    .pipe(Effect.mapError(() => new ProjectError({ message: `cannot read ${markerPath}` })))
  return yield* Schema.decodeEffect(MarkerJson)(raw).pipe(
    Effect.mapError(() => new ProjectError({ message: `${markerPath} is not a valid marker` })),
  )
})

const within = (dir: string, parent: string): boolean =>
  dir === parent || dir.startsWith(`${parent}${path.sep}`)

/**
 * Refuse a canonical root inside a directory another project's guest writes:
 * its `workspace/` or `.igloo/home/`. That guest could write the marker there
 * and the `igloo-policy.nix` beside it, and a root it made would hand the host
 * its policy, credential commands included.
 *
 * Every marker above is checked, not just the nearest, which the guest may have
 * planted too, placed so that its own workspace does not hold this root. A
 * marker's presence is enough: that is what makes a directory a project.
 */
const refuseNested = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  let previous = root
  let current = path.dirname(root)

  while (current !== previous) {
    if (yield* fs.exists(path.join(current, MARKER)).pipe(Effect.orElseSucceed(() => false))) {
      const outer = forRoot(current)
      const written = [outer.workspaceDir, outer.homeDir].find(dir => within(root, dir))
      if (written !== undefined) {
        return yield* new ProjectError({
          message: `refusing the project at ${root}: it is inside ${written}, which the VM of the project at ${outer.root} writes, so that VM could write its marker and its policy. A project cannot be inside another project's workspace or home.`,
        })
      }
    }
    previous = current
    current = path.dirname(current)
  }
})

/**
 * Walk up from `startDir` for the marker, so the commands work from any
 * subdirectory of a project the way `git` does.
 *
 * The starting point is resolved before the walk: the identity is the canonical
 * path, and a symlinked route into a project has to arrive at the same one.
 */
export const find = Effect.fnUntraced(function* (startDir: string) {
  const fs = yield* FileSystem.FileSystem
  let current = yield* fs
    .realPath(startDir)
    .pipe(Effect.orElseSucceed(() => path.resolve(startDir)))
  let previous = ''

  while (current !== previous) {
    const markerPath = path.join(current, MARKER)
    if (yield* fs.exists(markerPath).pipe(Effect.orElseSucceed(() => false))) {
      yield* refuseNested(current)
      yield* readMarker(markerPath)
      return forRoot(current)
    }
    previous = current
    current = path.dirname(current)
  }

  return yield* new ProjectError({
    message: `no igloo project at or above ${startDir} — no ${MARKER} found`,
  })
})

/**
 * Create the project skeleton. Idempotent: an existing marker is left alone, but
 * a missing `.gitignore` is backfilled so a project made by an older version
 * picks it up. Refused where `find` would refuse the result.
 *
 * `.igloo/.gitignore` is `*` because none of this belongs in the project's own
 * history — it is a keypair, a gc-root, logs, and a home directory an agent
 * writes to continuously.
 */
export const init = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeDirectory(dir, { recursive: true }).pipe(
    Effect.andThen(() => fs.realPath(dir)),
    Effect.mapError(() => new ProjectError({ message: `cannot create ${dir}` })),
  )
  yield* refuseNested(root)
  const project = forRoot(root)

  const make = (target: string) =>
    fs
      .makeDirectory(target, { recursive: true })
      .pipe(Effect.mapError(() => new ProjectError({ message: `cannot create ${target}` })))

  yield* make(project.iglooDir)
  yield* make(project.homeDir)
  yield* make(project.workspaceDir)

  const gitignore = path.join(project.iglooDir, '.gitignore')
  if (!(yield* fs.exists(gitignore).pipe(Effect.orElseSucceed(() => false)))) {
    yield* fs
      .writeFileString(gitignore, '*\n')
      .pipe(Effect.mapError(() => new ProjectError({ message: `cannot write ${gitignore}` })))
  }

  const markerPath = path.join(root, MARKER)
  if (!(yield* fs.exists(markerPath).pipe(Effect.orElseSucceed(() => false)))) {
    const marker = yield* Schema.encodeEffect(MarkerJson)({
      createdAt: DateTime.formatIso(yield* DateTime.now),
      version: 1,
    }).pipe(Effect.mapError(() => new ProjectError({ message: 'cannot encode the marker' })))
    yield* fs
      .writeFileString(markerPath, `${marker}\n`)
      .pipe(Effect.mapError(() => new ProjectError({ message: `cannot write ${markerPath}` })))
  }

  return project
})
