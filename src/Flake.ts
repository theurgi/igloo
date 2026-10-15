import { Effect, FileSystem, Schema } from 'effect'
import * as path from 'node:path'

export class FlakeError extends Schema.TaggedError<FlakeError>()('FlakeError', {
  message: Schema.String,
}) {}

/**
 * One virtio-fs share. `source` is a host path that must exist before virtiofsd
 * starts, and `tag` is what the readiness poll waits for, since virtiofsd names
 * its socket after it.
 */
export interface Share {
  readonly mountPoint: string
  readonly source: string
  readonly tag: string
}

/**
 * One credential to deliver, as the runner needs it: a name and the host file
 * QEMU reads it from. The value is never here — it is written to `hostPath` on
 * a tmpfs just before launch, and this file records only where to look.
 */
export interface Credential {
  readonly hostPath: string
  readonly name: string
}

export interface BrokerFile {
  readonly content: string
  readonly path: string
  readonly program: string
}

export interface RunnerSpec {
  /** Directory holding igloo's own `flake.nix`, taken as a `path:` input. */
  readonly iglooFlakePath: string
  /**
   * Environment the guest needs in order to reach the broker's inference
   * profiles — a base URL per provider, and a placeholder where each provider's
   * client expects a key. Empty for a VM with no such grant.
   *
   * Emitted even when empty, for the same reason `credentials` is: whether a VM
   * was pointed at a broker should be readable here rather than inferred from an
   * absence.
   */
  readonly brokerEnv: Readonly<Record<string, string>>
  /**
   * Files under the guest's `/etc` that point a client at the broker, by path
   * relative to it: configuration a variable in `brokerEnv` names. Empty for a
   * VM with no inference grant.
   */
  readonly brokerEtc: Readonly<Record<string, string>>
  /**
   * Files pointing a client at the broker where it reads a base URL from its
   * own configuration file alone: the path under root's home, the program
   * that reads it, and the text. The guest writes each at boot if that program
   * is installed and the file does not exist. Empty for a VM with no inference
   * grant.
   */
  readonly brokerFiles: readonly BrokerFile[]
  /**
   * Emitted even when empty, so that this file says whether a VM was launched
   * with credentials — which is the sort of thing that should not have to be
   * inferred from an absence.
   */
  readonly credentials: readonly Credential[]
  /**
   * Host paths of the content layers' NixOS modules, in composition order —
   * user first, then project. Imported from where they are rather than copied
   * in, so that a module's own relative imports still resolve — as far as the
   * build's confinement lets them, which is into the store and the workspace.
   */
  readonly contentModules: readonly string[]
  /**
   * The hosts whose git URLs the guest rewrites to the broker's loopback port,
   * or `undefined` for a VM with no git grant.
   *
   * The port is carried rather than agreed: the host opens the tether on it, so
   * the host is what knows it, and a guest configured against a different number
   * would fail as a connection refused inside the VM — a long way from the
   * decision that set it.
   */
  readonly gitBroker: { readonly hosts: readonly string[]; readonly port: number } | undefined
  readonly hostName: string
  readonly mem: number
  /** The store share is added by `mkRunner` and must not appear here. */
  readonly shares: readonly Share[]
  readonly sshAuthorizedKey: string
  readonly vcpu: number
  readonly vsockCid: number
}

/**
 * Escape a string for a Nix double-quoted literal. Every value this module emits
 * is a host path, so this is not decoration.
 *
 * `$` is escaped as well as the quote and the backslash: unescaped, a `${`
 * inside a path starts an interpolation, and the rest of the path is evaluated
 * as Nix rather than read as a name.
 */
export const nixString = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$')

/**
 * A guest hostname derived from a project's label.
 *
 * NixOS validates `networking.hostName` at evaluation time, so a project
 * directory named `my_app` or `Some.Thing` would fail the build rather than
 * boot with an odd prompt. Anything outside `[a-z0-9-]` becomes `-`.
 */
export const hostNameFrom = (label: string): string => {
  const sanitised = label
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 63)
  return sanitised === '' ? 'igloo' : sanitised
}

const renderShare = (share: Share): string =>
  `          { source = "${nixString(share.source)}"; mountPoint = "${nixString(
    share.mountPoint,
  )}"; tag = "${nixString(share.tag)}"; proto = "virtiofs"; }`

/**
 * The content layers, as a Nix list.
 *
 * Emitted even when empty, because "no content layer was found" is the answer to
 * the first question anyone asks when their configuration appears to do nothing,
 * and this file is where they will look for it.
 *
 * `import "<path>"` rather than a bare path literal: a path literal cannot hold a
 * space, and a project or home directory may.
 */
const renderCredentials = (credentials: readonly Credential[]): string =>
  credentials.length === 0
    ? '[ ];'
    : `[\n${credentials
        .map(
          credential =>
            `          { name = "${nixString(credential.name)}"; hostPath = "${nixString(
              credential.hostPath,
            )}"; }`,
        )
        .join('\n')}\n        ];`

const renderBrokerEnv = (env: Readonly<Record<string, string>>): string => {
  const names = Object.keys(env).toSorted()
  return names.length === 0
    ? '{ };'
    : `{\n${names
        .map(name => `          ${name} = "${nixString(env[name] ?? '')}";`)
        .join('\n')}\n        };`
}

const renderBrokerEtc = (files: Readonly<Record<string, string>>): string => {
  const paths = Object.keys(files).toSorted()
  return paths.length === 0
    ? '{ };'
    : `{\n${paths
        .map(file => `          "${nixString(file)}" = "${nixString(files[file] ?? '')}";`)
        .join('\n')}\n        };`
}

const renderBrokerFiles = (files: readonly BrokerFile[]): string =>
  files.length === 0
    ? '[ ];'
    : `[\n${files
        .map(
          file =>
            `          { path = "${nixString(file.path)}"; program = "${nixString(
              file.program,
            )}"; content = "${nixString(file.content)}"; }`,
        )
        .join('\n')}\n        ];`

const renderGitBroker = (gitBroker: RunnerSpec['gitBroker']): string =>
  gitBroker === undefined
    ? 'null;'
    : `{ hosts = [ ${gitBroker.hosts
        .map(host => `"${nixString(host)}"`)
        .join(' ')} ]; port = ${String(gitBroker.port)}; };`

const renderContent = (modules: readonly string[]): string =>
  modules.length === 0
    ? '[ ];'
    : `[\n${modules.map(file => `          (import "${nixString(file)}")`).join('\n')}\n        ];`

/**
 * The flake that builds one project's runner.
 *
 * The CID and the authorized key are **written into the text** rather than read
 * from the environment at evaluation time, which makes the runner a function of
 * this file plus the content modules it names — what a build cache would have
 * to hash. The content modules are referenced rather than inlined, so this
 * file's text does not change when one of them does.
 */
export const render = (spec: RunnerSpec): string =>
  `# Generated by igloo, and rewritten on every launch — edits here are lost.
{
  inputs.igloo.url = "path:${nixString(spec.iglooFlakePath)}";
  outputs =
    { igloo, ... }:
    {
      packages.x86_64-linux.default = igloo.lib.mkRunner {
        brokerEnv = ${renderBrokerEnv(spec.brokerEnv)}
        brokerEtc = ${renderBrokerEtc(spec.brokerEtc)}
        brokerFiles = ${renderBrokerFiles(spec.brokerFiles)}
        contentModules = ${renderContent(spec.contentModules)}
        credentials = ${renderCredentials(spec.credentials)}
        gitBroker = ${renderGitBroker(spec.gitBroker)}
        hostName = "${nixString(spec.hostName)}";
        mem = ${String(spec.mem)};
        shares = [
${spec.shares.map(renderShare).join('\n')}
        ];
        sshAuthorizedKey = "${nixString(spec.sshAuthorizedKey)}";
        vcpu = ${String(spec.vcpu)};
        vsockCid = ${String(spec.vsockCid)};
      };
    };
}
`

/**
 * `render`'s text with the paths it imports left out — igloo's own, and each
 * content layer's: what to compare with an earlier launch's, to tell whether
 * this one would build a different runner.
 *
 * Anything in the store moves when it changes: an upgrade moves igloo, and a
 * home-manager switch moves the user layer, whether or not anything this
 * runner is built from changed. So a caller comparing this must compare what
 * the runner reads from those paths on its own account — igloo's Nix files and
 * `flake.lock` (`LaunchInputs.ofIgloo`), and each layer's file. The layers'
 * number and order are kept.
 */
export const comparable = (spec: RunnerSpec): string =>
  render({
    ...spec,
    iglooFlakePath: '<igloo>',
    contentModules: spec.contentModules.map((_, index) => `<layer ${String(index + 1)}>`),
  })

/**
 * Write the flake, and return the flake reference to build.
 *
 * Rewritten on every launch rather than written once: every field in it is
 * derived, so a stale copy is a VM configured from a previous run's facts. No
 * `flake.lock` is ever written here — `up` builds with `--no-write-lock-file`,
 * because a lock would pin the `path:` input to a copy of igloo and leave the
 * next build using a version of the tool that is no longer installed.
 */
export const write = Effect.fnUntraced(function* (dir: string, spec: RunnerSpec) {
  const fs = yield* FileSystem.FileSystem
  yield* fs
    .makeDirectory(dir, { recursive: true })
    .pipe(Effect.mapError(() => new FlakeError({ message: `cannot create ${dir}` })))
  yield* fs
    .writeFileString(path.join(dir, 'flake.nix'), render(spec))
    .pipe(Effect.mapError(() => new FlakeError({ message: `cannot write ${dir}/flake.nix` })))
  return `path:${dir}`
})
