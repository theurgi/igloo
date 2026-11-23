import { BunServices } from '@effect/platform-bun'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Result, Scope } from 'effect'
import { ChildProcessSpawner } from 'effect/unstable/process'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

import * as Binaries from './Binaries.ts'
import * as Config from './Config.ts'
import * as Profiles from './Profiles.ts'

const provided = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Scope.Scope
  >,
) => effect.pipe(Effect.scoped, Effect.provide(BunServices.layer))

const userPolicyName = 'programs.igloo.policy'
const projectRoot = '/home/you/projects/api'
const projectPolicyPath = `${projectRoot}/igloo-policy.nix`

/**
 * The profiles igloo ships, read as the CLI reads them, from the JSON the
 * package carries: `IGLOO_PROFILES`, which the devshell sets.
 */
const shipped = ((): ReadonlyMap<string, Profiles.Profile> => {
  const file = process.env['IGLOO_PROFILES']
  if (file === undefined || file === '')
    throw new Error('IGLOO_PROFILES is not set: run the tests in `nix develop`')
  return Result.getOrThrow(Profiles.read(file, JSON.parse(readFileSync(file, 'utf8'))))
})()

const layers = (input: {
  readonly aliases?: readonly string[]
  readonly project?: Record<string, unknown>
  readonly user?: Record<string, unknown>
}): Config.Layers => ({
  igloo: shipped,
  project:
    input.project === undefined ? undefined : { path: projectPolicyPath, values: input.project },
  projectAliases: input.aliases ?? [],
  projectRoot: input.project === undefined ? undefined : projectRoot,
  user: input.user === undefined ? undefined : { path: userPolicyName, values: input.user },
  userPolicyName,
})

type Input = Parameters<typeof layers>[0]

const composed = (input: Input): Config.Policy =>
  Result.getOrThrow(Config.compose(layers(input))).policy

const notes = (input: Input): readonly string[] =>
  Result.getOrThrow(Config.compose(layers(input))).notes

/** The diagnostic these layers produce, and a failure if they compose after all. */
const refused = (input: Input): string => {
  const result = Config.compose(layers(input))
  if (Result.isFailure(result)) return result.failure.message
  throw new Error(`expected a diagnostic, got ${JSON.stringify(result.success)}`)
}

/**
 * A `nix` that answers `eval` from a file the test wrote, so the policy files are
 * read the way a real launch reads them — by evaluating Nix — without needing a
 * nix in the sandbox this suite runs in.
 *
 * It echoes the expression it was given into a log, because the one thing an
 * argument-shape assertion cannot check is that the expression names the files
 * that exist and no others.
 *
 * Beside it, a stand-in for `igloo-landlock`, which records its rules and the
 * cache nix is pointed at, and runs nix unrestricted.
 */
const fakeNix = Effect.fnUntraced(function* (dir: string, json: string) {
  const fs = yield* FileSystem.FileSystem
  const file = path.join(dir, 'fake-nix')
  const log = path.join(dir, 'nix-args')
  const rules = path.join(dir, 'landlock-rules')
  yield* fs.writeFileString(
    file,
    `#!/usr/bin/env bash
printf '%s\\n' "$@" > '${log}'
if [ "$1" = "eval" ]; then cat <<'EOJ'
${json}
EOJ
fi
`,
  )
  yield* fs.writeFileString(
    landlockBeside(file),
    `#!/usr/bin/env bash
: > '${rules}'
while [ $# -gt 1 ] && [ "$1" != -- ]; do printf '%s %s\\n' "$1" "$2" >> '${rules}'; shift 2; done
[ "$1" = -- ] || { echo "fake-landlock: no -- before the command" >&2; exit 1; }
shift
printf 'NIX_CACHE_HOME %s\\n' "$NIX_CACHE_HOME" >> '${rules}'
exec "$@"
`,
  )
  yield* fs.chmod(file, 0o755)
  yield* fs.chmod(landlockBeside(file), 0o755)
  return { log, nix: file, rules }
})

const landlockBeside = (nix: string): string => path.join(path.dirname(nix), 'fake-landlock')

const binaries = (nix: string): Binaries.Binaries =>
  Binaries.fromEnv({ IGLOO_LANDLOCK: landlockBeside(nix), IGLOO_NIX: nix })

describe('Config layer paths', () => {
  it('reads the user layer from its directory and the project layer from the project root', () => {
    assert.deepStrictEqual(
      Config.userLayer('/nix/store/1ypxl6n5mj3n2qq0cq4c0s8m7ad2mxk9-igloo-user-layer'),
      {
        content: '/nix/store/1ypxl6n5mj3n2qq0cq4c0s8m7ad2mxk9-igloo-user-layer/igloo.nix',
        policy: '/nix/store/1ypxl6n5mj3n2qq0cq4c0s8m7ad2mxk9-igloo-user-layer/igloo-policy.nix',
      },
    )
    // The project root, never the workspace: the workspace is mounted
    // read-write into the guest.
    assert.deepStrictEqual(Config.projectLayer('/home/you/projects/api'), {
      content: '/home/you/projects/api/igloo.nix',
      policy: projectPolicyPath,
    })
  })
})

describe('Config.compose', () => {
  it('gives a VM with no configuration the settled defaults', () => {
    assert.deepStrictEqual(composed({}), {
      brokerMem: undefined,
      disk: undefined,
      mem: 4096,
      modelServers: [],
      network: 'internet',
      ports: [],
      secrets: [],
      tunnel: 'any',
      vcpu: 4,
    })
  })

  it('lets the user layer set the sizes', () => {
    assert.deepStrictEqual(
      composed({ user: { brokerMem: 512, disk: 20480, mem: 8192, vcpu: 8 } }),
      {
        brokerMem: 512,
        disk: 20480,
        mem: 8192,
        modelServers: [],
        network: 'internet',
        ports: [],
        secrets: [],
        tunnel: 'any',
        vcpu: 8,
      },
    )
  })

  it("lets a project replace the user's network default", () => {
    assert.strictEqual(
      composed({ project: { network: 'none' }, user: { network: 'internet' } }).network,
      'none',
    )
  })

  it('refuses a project request that exceeds the ceiling, naming both files', () => {
    const message = refused({ project: { network: 'internet' }, user: { networkCeiling: 'none' } })
    assert.include(message, projectPolicyPath)
    assert.include(message, userPolicyName)
    assert.include(message, 'narrow the ceiling, not widen it')
  })

  it('lets a project narrow the ceiling', () => {
    assert.strictEqual(
      composed({ project: { network: 'none' }, user: { networkCeiling: 'none' } }).network,
      'none',
    )
  })

  it('takes a ceiling with no default beside it as the default', () => {
    // Reading "my ceiling is none" as "default to internet until a project says
    // otherwise" would be the one surprise a ceiling exists to rule out.
    assert.strictEqual(composed({ user: { networkCeiling: 'none' } }).network, 'none')
  })

  it('refuses a user default above the same file’s ceiling', () => {
    assert.include(
      refused({ user: { network: 'internet', networkCeiling: 'none' } }),
      "the same layer's own",
    )
  })

  it('accepts restricted, as a mode and as a ceiling', () => {
    assert.strictEqual(composed({ user: { network: 'restricted' } }).network, 'restricted')
    assert.strictEqual(composed({ user: { networkCeiling: 'restricted' } }).network, 'restricted')
    assert.strictEqual(composed({ project: { network: 'restricted' } }).network, 'restricted')
  })

  it('ranks restricted between none and internet', () => {
    // "These destinations or nothing" is a different answer from "any public
    // name", so a ceiling of restricted has to refuse internet — and it has to
    // permit none, which reaches strictly less.
    assert.include(
      refused({ project: { network: 'internet' }, user: { networkCeiling: 'restricted' } }),
      'narrow the ceiling, not widen it',
    )
    assert.strictEqual(
      composed({ project: { network: 'none' }, user: { networkCeiling: 'restricted' } }).network,
      'none',
    )
    assert.strictEqual(
      composed({ project: { network: 'restricted' }, user: { networkCeiling: 'internet' } })
        .network,
      'restricted',
    )
  })

  it('says so when restricted reaches nothing at all', () => {
    // No NIC, no destination and no grant is `none` wearing another word, and
    // the way someone finds that out otherwise is an agent that cannot reach
    // anything.
    const said = notes({ project: { network: 'restricted' }, user: {} })
    assert.isTrue(said.some(note => note.includes('reaches nothing at all')))
    assert.deepStrictEqual(
      notes({
        project: { network: 'restricted', tunnel: ['pypi.org'] },
        user: { tunnelCeiling: ['pypi.org'] },
      }),
      [],
    )
  })

  it("lets a project replace the user layer's sizes, and keeps the ones it leaves", () => {
    const user = { brokerMem: 512, mem: 8192, vcpu: 8 }
    assert.deepInclude(composed({ project: { mem: 16384, vcpu: 2 }, user }), {
      brokerMem: 512,
      mem: 16384,
      vcpu: 2,
    })
    assert.deepInclude(composed({ project: { brokerMem: 1024 }, user }), {
      brokerMem: 1024,
      mem: 8192,
      vcpu: 8,
    })
    assert.strictEqual(composed({ project: { disk: 40960 }, user: { disk: 20480 } }).disk, 40960)
    assert.strictEqual(composed({ user: { disk: 20480 } }).disk, 20480)
    // Larger than the user layer's, too: nothing bounds a project's size.
    assert.strictEqual(composed({ project: { mem: 65536 } }).mem, 65536)
  })

  it('checks a user size that a project replaces', () => {
    // Otherwise a bad default would surface only in the projects that keep it.
    const message = refused({ project: { mem: 8192 }, user: { mem: 0 } })
    assert.include(message, userPolicyName)
    assert.include(message, 'positive whole number')
  })

  it('names the file whose mem hangs QEMU', () => {
    const message = refused({ project: { mem: 2048 }, user: { mem: 8192 } })
    assert.include(message, projectPolicyPath)
    assert.include(message, 'hangs QEMU')
    assert.include(refused({ project: { mem: 8192 }, user: { mem: 2048 } }), userPolicyName)
  })

  it('tells a project that a ceiling belongs in the user layer', () => {
    for (const values of [{ networkCeiling: 'none' }, { tunnelCeiling: ['pypi.org'] }]) {
      const message = refused({ project: values })
      assert.include(message, projectPolicyPath)
      assert.include(message, `it belongs in ${userPolicyName}`)
      assert.include(message, 'a project raising its own ceiling is not a ceiling')
    }
  })

  it('names what a layer may set when it sees a setting it does not know', () => {
    const message = refused({ project: { netowrk: 'none' } })
    assert.include(message, 'unknown policy setting `netowrk`')
    assert.include(message, 'network')
    // The user layer's extra settings are not offered to a project.
    assert.notInclude(message, 'networkCeiling')
  })

  it('says a removed setting is gone, rather than that it is unknown', () => {
    // A file written before the setting went away is the likeliest place to
    // meet it, and "unknown" would read as a typo.
    const message = refused({ user: { dnsServer: '1.1.1.1#one.one.one.one' } })
    assert.include(message, 'is no longer a setting')
    assert.include(message, 'Delete the line')
  })

  it('rejects a mem that hangs QEMU, and values of the wrong shape', () => {
    assert.include(refused({ user: { mem: 2048 } }), 'hangs QEMU')
    for (const values of [
      { mem: 0 },
      { mem: 4096.5 },
      { vcpu: '4' },
      { brokerMem: 0 },
      { brokerMem: '512M' },
      { disk: 0 },
      { disk: '20G' },
    ]) {
      assert.isString(refused({ user: values }))
      assert.include(refused({ project: values }), projectPolicyPath)
    }
  })
})

describe('Config.userLayerNames', () => {
  it('names the option for a layer home-manager generated, since its file is not one to edit', () => {
    assert.deepStrictEqual(
      Config.userLayerNames('/nix/store/1ypxl6n5mj3n2qq0cq4c0s8m7ad2mxk9-igloo-user-layer'),
      { content: 'programs.igloo.guest', policy: 'programs.igloo.policy' },
    )
  })

  it('names the option for a user with no layer, since that is where one goes', () => {
    assert.strictEqual(Config.userLayerNames(undefined).policy, 'programs.igloo.policy')
  })

  it('names the file for a layer written by hand', () => {
    assert.deepStrictEqual(
      Config.userLayerNames('/home/you/igloo-layer'),
      Config.userLayer('/home/you/igloo-layer'),
    )
  })
})

describe('Config.resolve', () => {
  it.effect('reads nothing and spawns nothing when no layer file exists', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const { log, nix } = yield* fakeNix(dir, '{}')
        const root = path.join(dir, 'project')
        yield* fs.makeDirectory(path.join(root, 'workspace'), { recursive: true })

        const config = yield* Config.resolve(binaries(nix), {
          igloo: shipped,
          project: { root, workspaceDir: path.join(root, 'workspace') },
          userLayerDir: undefined,
        })

        assert.deepStrictEqual(config.content, [])
        assert.deepStrictEqual(config.policy.network, 'internet')
        // A project with no configuration pays no `nix eval` for it.
        assert.isFalse(yield* fs.exists(log))
      }),
    ),
  )

  it.effect('evaluates both layers in one call and composes them', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const { log, nix, rules } = yield* fakeNix(
          dir,
          '{"project":{"network":"none"},"user":{"mem":2047}}',
        )
        const userLayerDir = path.join(dir, 'layer')
        const root = path.join(dir, 'project')
        const user = Config.userLayer(userLayerDir)
        const project = Config.projectLayer(root)
        yield* fs.makeDirectory(userLayerDir, { recursive: true })
        yield* fs.makeDirectory(path.join(root, 'workspace'), { recursive: true })
        yield* fs.writeFileString(user.policy, '{ mem = 2047; }')
        yield* fs.writeFileString(user.content, '{ }')
        yield* fs.writeFileString(project.policy, '{ network = "none"; }')
        yield* fs.writeFileString(project.content, '{ }')

        const config = yield* Config.resolve(binaries(nix), {
          igloo: shipped,
          project: { root, workspaceDir: path.join(root, 'workspace') },
          userLayerDir,
        })

        assert.deepStrictEqual(config.policy, {
          brokerMem: undefined,
          disk: undefined,
          mem: 2047,
          modelServers: [],
          network: 'none',
          ports: [],
          secrets: [],
          tunnel: [],
          vcpu: 4,
        })
        // User first, so a project's module overrides it by module semantics.
        assert.deepStrictEqual(
          config.content.map(({ file }) => file),
          [user.content, project.content],
        )
        // Written by hand, so named by its file wherever a message names it.
        assert.deepStrictEqual(
          config.content.map(({ name }) => name),
          [user.content, project.content],
        )

        const args = yield* fs.readFileString(log)
        assert.include(args, 'eval')
        assert.include(args, `user = import "${user.policy}"`)
        assert.include(args, `project = import "${project.policy}"`)
        // A policy file is Nix as well, so it is read under the same confinement
        // as content: the two policy files may be read, and the content files
        // beside them may not.
        assert.include(args, 'restrict-eval\ntrue\n')
        assert.include(args, `=${user.policy}\n`)
        assert.include(args, `=${project.policy}\n`)
        assert.notInclude(args, `=${user.content}\n`)
        assert.notInclude(args, `=${project.content}\n`)

        // And so is nix itself, by the kernel, to the same files; it writes only
        // a cache of its own, gone once the evaluation is.
        const given = (yield* fs.readFileString(rules)).trim().split('\n')
        assert.include(given, `--read ${user.policy}`)
        assert.include(given, `--read ${project.policy}`)
        assert.notInclude(given, `--read ${user.content}`)
        assert.notInclude(given, `--read ${project.content}`)
        const writes = given.filter(rule => rule.startsWith('--write '))
        assert.strictEqual(writes.length, 1)
        const cache = writes[0]?.slice('--write '.length) ?? ''
        assert.include(given, `NIX_CACHE_HOME ${cache}`)
        assert.isFalse(yield* fs.exists(cache))
      }),
    ),
  )

  it.effect('names only the layer whose file exists', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const { log, nix } = yield* fakeNix(dir, '{"project":{"network":"none"}}')
        const root = path.join(dir, 'project')
        const project = Config.projectLayer(root)
        const userLayerDir = path.join(dir, 'layer')
        yield* fs.makeDirectory(userLayerDir)
        yield* fs.makeDirectory(path.join(root, 'workspace'), { recursive: true })
        yield* fs.writeFileString(project.policy, '{ network = "none"; }')

        yield* Config.resolve(binaries(nix), {
          igloo: shipped,
          project: { root, workspaceDir: path.join(root, 'workspace') },
          userLayerDir,
        })

        // An absent file named in the expression would fail the whole evaluation,
        // taking the layer that does exist with it.
        assert.notInclude(yield* fs.readFileString(log), 'user = import')
      }),
    ),
  )

  it.effect('refuses a policy file in the workspace instead of ignoring it', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const { nix } = yield* fakeNix(dir, '{}')
        const root = path.join(dir, 'project')
        const workspaceDir = path.join(root, 'workspace')
        yield* fs.makeDirectory(workspaceDir, { recursive: true })
        const stray = path.join(workspaceDir, 'igloo-policy.nix')
        yield* fs.writeFileString(stray, '{ network = "internet"; }')

        const result = yield* Effect.result(
          Config.resolve(binaries(nix), {
            igloo: shipped,
            project: { root, workspaceDir },
            userLayerDir: undefined,
          }),
        )

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.include(result.failure.message, stray)
          assert.include(result.failure.message, Config.projectLayer(root).policy)
        }
      }),
    ),
  )

  it.effect('composes the user layer alone outside a project', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const { log, nix } = yield* fakeNix(dir, '{"user":{"mem":8192}}')
        const userLayerDir = path.join(dir, 'layer')
        const user = Config.userLayer(userLayerDir)
        yield* fs.makeDirectory(userLayerDir)
        yield* fs.writeFileString(user.policy, '{ mem = 8192; }')

        const config = yield* Config.resolve(binaries(nix), {
          igloo: shipped,
          project: undefined,
          userLayerDir,
        })

        assert.strictEqual(config.policy.mem, 8192)
        assert.notInclude(yield* fs.readFileString(log), 'project = import')
      }),
    ),
  )

  it.effect('refuses a user layer directory that does not exist', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const { nix } = yield* fakeNix(dir, '{}')
        const missing = path.join(dir, 'gone')

        const result = yield* Effect.result(
          Config.resolve(binaries(nix), {
            igloo: shipped,
            project: undefined,
            userLayerDir: missing,
          }),
        )

        // Named explicitly and absent is a mistake, not a user with no layer:
        // every VM would start without the agents it declares.
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.include(result.failure.message, missing)
          assert.include(result.failure.message, 'IGLOO_USER_LAYER')
        }
      }),
    ),
  )

  it.effect('reports a policy file that does not evaluate to an attribute set', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        // What a file written as a NixOS module produces: nix cannot serialise a
        // function, so it fails and prints nothing on stdout.
        const { nix } = yield* fakeNix(dir, '')
        const userLayerDir = path.join(dir, 'layer')
        const user = Config.userLayer(userLayerDir)
        yield* fs.makeDirectory(userLayerDir)
        yield* fs.writeFileString(user.policy, '{ pkgs, ... }: { }')

        const result = yield* Effect.result(
          Config.resolve(binaries(nix), { igloo: shipped, project: undefined, userLayerDir }),
        )

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.include(result.failure.message, user.policy)
          assert.include(result.failure.message, 'attribute set')
        }
      }),
    ),
  )
})

/** A project's policy declaring a credential of its own. */
const own = (over: Record<string, unknown> = {}) => ({
  secrets: {
    OWN: { mode: 'deliver', source: { file: '/home/you/keys/own' }, ...over },
  },
})

/**
 * Delivery puts a real credential inside a VM whose root belongs to whatever is
 * running in it, so what may and may not reach one is exactly the kind of claim
 * that should be checked rather than read.
 */
describe('Config.compose: secrets', () => {
  const declared = (over: Record<string, unknown> = {}) => ({
    secrets: {
      TOKEN: {
        mode: 'deliver',
        projects: [projectRoot],
        source: { command: ['pass', 'show', 'gh'] },
        ...over,
      },
    },
  })

  it('gives a project a credential the user layer lists it in', () => {
    assert.deepStrictEqual(composed({ project: {}, user: declared() }).secrets, [
      {
        layer: 'user',
        mode: 'deliver',
        name: 'TOKEN',
        source: { _tag: 'Command', argv: ['pass', 'show', 'gh'] },
      },
    ])
  })

  it('gives nothing to a project the user layer does not list', () => {
    // Only the user layer shares a credential, so this is what keeps one
    // project from taking another's.
    assert.isEmpty(
      composed({ project: {}, user: declared({ projects: ['/home/you/projects/other'] }) }).secrets,
    )
  })

  it('matches a listed root however its trailing slash is written', () => {
    assert.lengthOf(
      composed({ project: {}, user: declared({ projects: [`${projectRoot}/`] }) }).secrets,
      1,
    )
  })

  it('matches a root listed by another path to the same directory', () => {
    // With nothing on the project's side asking for it, a spelling that missed
    // would deliver nothing and say nothing.
    const link = '/home/you/link/api'
    assert.lengthOf(
      composed({ aliases: [link], project: {}, user: declared({ projects: [link] }) }).secrets,
      1,
    )
  })

  it('refuses a project root that is not absolute', () => {
    const message = refused({ project: {}, user: declared({ projects: ['projects/api'] }) })
    assert.include(message, '"projects/api"')
    assert.include(message, 'absolute path')
    assert.include(message, 'config.home.homeDirectory')
  })

  it('gives a project its own credential, with or without a user layer', () => {
    const expected: readonly Config.SecretDeclaration[] = [
      {
        layer: 'project',
        mode: 'deliver',
        name: 'OWN',
        source: { _tag: 'File', path: '/home/you/keys/own' },
      },
    ]
    assert.deepStrictEqual(composed({ project: own() }).secrets, expected)
    assert.deepStrictEqual(composed({ project: own(), user: {} }).secrets, expected)
  })

  it('lets a project use a name the user layer gives only to others', () => {
    const policy = composed({
      project: { secrets: { TOKEN: { mode: 'deliver', source: { file: '/home/you/keys/api' } } } },
      user: declared({ projects: ['/home/you/projects/other'] }),
    })
    assert.deepStrictEqual(
      policy.secrets.map(secret => [secret.name, secret.layer]),
      [['TOKEN', 'project']],
    )
  })

  it('refuses one name from both layers for the same project, naming both files', () => {
    // Letting either win would leave the other file saying something about
    // this VM that is not true.
    const message = refused({
      project: { secrets: { TOKEN: { mode: 'deliver', source: { file: '/home/you/keys/api' } } } },
      user: declared(),
    })
    assert.include(message, projectPolicyPath)
    assert.include(message, userPolicyName)
    assert.include(message, '`secrets.TOKEN.projects`')
  })

  it('refuses `projects` on a project’s own credential', () => {
    const message = refused({ project: own({ projects: [projectRoot] }) })
    assert.include(message, '`secrets.OWN.projects`')
    assert.include(message, 'this project alone')
  })

  it('reads a project’s own declaration by the same rules as the user layer’s', () => {
    assert.include(
      refused({ project: own({ mode: undefined }) }),
      '`secrets.OWN.mode` must be "broker" or "deliver"',
    )
    assert.include(refused({ project: own({ source: { file: 'keys/own' } }) }), 'absolute')
  })

  it('tells each layer which shape of `secrets` it takes', () => {
    assert.include(refused({ user: { secrets: ['TOKEN'] } }), 'attribute set')
    // The list a project once wrote to ask for a user-layer credential: the
    // message says where such a credential comes from now.
    const message = refused({ project: { secrets: ['TOKEN'] }, user: declared() })
    assert.include(message, 'attribute set')
    assert.include(message, '`projects` lists')
  })

  it('carries the mode through, because it decides where the credential ends up', () => {
    // The two modes differ in what they expose — brokered stays on the host,
    // delivered goes inside a VM the agent has root on — so the launch path
    // reads this to decide which of the two mechanisms a credential gets.
    const policy = composed({
      project: {},
      user: declared({ mode: 'broker', profile: 'github', repos: { read: ['you/api'] } }),
    })
    assert.deepStrictEqual(
      policy.secrets.map(secret => secret.mode),
      ['broker'],
    )
  })

  it('will not let either mode be the unstated default', () => {
    const message = refused({ project: {}, user: declared({ mode: undefined }) })
    assert.include(message, '`secrets.TOKEN.mode` must be "broker" or "deliver"')
  })

  it('refuses a source that is both a file and a command', () => {
    const message = refused({
      project: {},
      user: declared({ source: { command: ['pass'], file: '/tmp/x' } }),
    })
    assert.include(message, 'exactly one')
  })

  it('refuses a command source written as a shell string', () => {
    // An argument vector, never a line for a shell to re-split — there is
    // nothing a shell adds here but a way to get quoting wrong.
    const message = refused({
      project: {},
      user: declared({ source: { command: 'pass show gh' } }),
    })
    assert.include(message, 'list of non-empty strings')
  })

  it('carries a file source through as the path it names', () => {
    assert.deepStrictEqual(
      composed({
        project: {},
        user: declared({ source: { file: '/run/agenix/gh' } }),
      }).secrets.map(secret => secret.source),
      [{ _tag: 'File', path: '/run/agenix/gh' }],
    )
  })

  it('refuses a relative file source rather than reading it from wherever `up` ran', () => {
    // The directory `igloo up` is typed in can be inside the workspace, which
    // the guest writes — so the same declaration would read a different file
    // depending on where someone happened to be standing.
    const message = refused({ project: {}, user: declared({ source: { file: 'secrets/gh' } }) })
    assert.include(message, '`secrets.TOKEN.source.file`')
    assert.include(message, 'absolute')
    assert.include(message, '"secrets/gh"')
  })

  it('says `~` is not expanded, since it is the likeliest relative path to be written', () => {
    const message = refused({
      project: {},
      user: declared({ source: { file: '~/.config/gh/token' } }),
    })
    assert.include(message, '`~`')
    assert.include(message, 'config.home.homeDirectory')
  })

  it('refuses a file source in the store, where a path literal like `./token` lands', () => {
    // Serialising the policy copies a Nix path value into the store, which
    // every user on the machine can read, and hands back an absolute path — so
    // the absolute-path rule alone would accept it.
    const message = refused({
      project: {},
      user: declared({ source: { file: '/nix/store/ahq5jrbr3cfjlvmiz8977jqvf8k1iw62-token' } }),
    })
    assert.include(message, '`secrets.TOKEN.source.file`')
    assert.include(message, 'every user on this machine can read')
    assert.include(message, 'config.home.homeDirectory')
  })

  it('refuses a name QEMU or systemd could not carry', () => {
    const message = refused({
      project: {},
      user: { secrets: { 'A,B': { mode: 'deliver', projects: [], source: { file: '/x' } } } },
    })
    assert.include(message, 'not a usable credential name')
  })
})

/**
 * A grant is the whole of what a brokered credential is permitted to do, so the
 * ways of writing one that would leave the broker holding a credential with no
 * policy — or with a wider one than was meant — are the cases worth asserting.
 */
describe('Config.compose: grants', () => {
  const brokered = (over: Record<string, unknown> = {}) => ({
    secrets: {
      GITHUB_TOKEN: {
        mode: 'broker',
        profile: 'github',
        projects: [projectRoot],
        repos: { read: ['you/api'] },
        source: { command: ['gh', 'auth', 'token'] },
        ...over,
      },
    },
  })

  it('refuses a brokered credential under none, which would reach its upstream', () => {
    const message = refused({ project: { network: 'none' }, user: brokered() })
    assert.include(message, 'GITHUB_TOKEN is brokered')
    assert.include(message, 'network = "restricted"')
  })

  it('carries the grant through to the launch path', () => {
    const [secret] = composed({ project: {}, user: brokered() }).secrets
    assert.deepStrictEqual(secret?.mode === 'broker' ? secret.grant : undefined, {
      profile: 'github',
      repos: ['you/api'],
    })
  })

  it('refuses a brokered credential with no profile', () => {
    // The default a reader assumes is "it works"; the default that is safe is
    // "it refuses everything". Naming the profile is what stops those two being
    // confusable.
    const message = refused({ project: {}, user: brokered({ profile: undefined }) })
    assert.include(message, '`secrets.GITHUB_TOKEN.profile`')
    assert.include(message, '"github"')
  })

  it('refuses a profile that is not built', () => {
    const message = refused({ project: {}, user: brokered({ profile: 'gitlab' }) })
    assert.include(message, '"github"')
  })

  it('refuses a grant that reaches nothing', () => {
    for (const repos of [undefined, {}, { read: [] }]) {
      assert.include(refused({ project: {}, user: brokered({ repos }) }), 'reaches nothing')
    }
  })

  it('refuses a repository written as anything but owner/repo', () => {
    for (const repo of ['api', 'https://github.com/you/api', 'you/api/extra']) {
      const message = refused({ project: {}, user: brokered({ repos: { read: [repo] } }) })
      assert.include(message, 'is not a repository')
    }
  })

  it('says where the host comes from, since a grant cannot name one', () => {
    const message = refused({
      project: {},
      user: brokered({ repos: { read: ['github.com/you/api'] } }),
    })
    assert.include(message, 'github.com is decided by the profile')
  })

  it('refuses a grant on a delivered credential rather than ignoring it', () => {
    // Ignoring it is how someone ends up believing a credential is scoped when
    // it was handed to the guest whole.
    const message = refused({
      project: {},
      user: brokered({ mode: 'deliver' }),
    })
    assert.include(message, 'only means something for a brokered credential')
    const delivered = {
      secrets: {
        GITHUB_TOKEN: {
          mode: 'deliver',
          projects: [projectRoot],
          repos: { write: ['you/api'] },
          source: { command: ['gh', 'auth', 'token'] },
        },
      },
    }
    assert.include(
      refused({ project: {}, user: delivered }),
      '`secrets.GITHUB_TOKEN.repos` only means something for a brokered credential',
    )
  })

  it('carries the repositories a grant may push to, beside those it may only fetch', () => {
    const grantOf = (repos: Record<string, unknown>) => {
      const [secret] = composed({ project: {}, user: brokered({ repos }) }).secrets
      return secret?.mode === 'broker' ? secret.grant : undefined
    }
    assert.deepStrictEqual(grantOf({ read: ['you/api'] }), {
      profile: 'github',
      repos: ['you/api'],
    })
    assert.deepStrictEqual(grantOf({ write: ['you/web'] }), {
      profile: 'github',
      repos: [],
      write: ['you/web'],
    })
    assert.deepStrictEqual(grantOf({ read: ['you/api'], write: ['you/web'] }), {
      profile: 'github',
      repos: ['you/api'],
      write: ['you/web'],
    })
  })

  it('refuses repositories listed flat, with the line that lists them by access', () => {
    const message = (over: Record<string, unknown>) =>
      refused({ project: {}, user: brokered(over) })
    assert.include(
      message({ repos: ['you/api'] }),
      `${userPolicyName}: \`secrets.GITHUB_TOKEN\` lists its repositories in \`repos\`, and \`repos\` takes them by access now, as \`read\` and \`write\`. Write \`repos.read = [ "you/api" ];\` in its place.`,
    )
    assert.include(
      message({ repos: ['you/api'], write: ['you/web', 'you/docs'] }),
      'in `repos` and `write`, and `repos` takes them by access now, as `read` and `write`. Write `repos = { read = [ "you/api" ]; write = [ "you/web" "you/docs" ]; };` in their place.',
    )
    assert.include(
      message({ repos: undefined, write: ['you/web'] }),
      'in `write`, and `repos` takes them by access now, as `read` and `write`. Write `repos.write = [ "you/web" ];` in its place.',
    )
    // Half moved: Nix merges `repos.write = …;` into a `repos = { read = …; };`
    // beside it, so the same line still copies as it stands.
    assert.include(message({ write: ['you/web'] }), 'Write `repos.write = [ "you/web" ];`')
    // Only a list of repositories can be written out as one.
    assert.include(
      message({ repos: ['you/api'], write: 'you/web' }),
      '`secrets.GITHUB_TOKEN.write` must be a list of non-empty strings',
    )
    assert.include(
      refused({
        project: {
          secrets: {
            OWN: { mode: 'broker', profile: 'github', repos: ['you/web'], source: { file: '/t' } },
          },
        },
      }),
      `${projectPolicyPath}: \`secrets.OWN\` lists its repositories in \`repos\``,
    )
  })

  it('refuses anything under `repos` but `read` and `write`', () => {
    assert.include(
      refused({
        project: {},
        user: brokered({ repos: { push: ['you/web'], read: ['you/api'] } }),
      }),
      '`secrets.GITHUB_TOKEN.repos.push` is not a setting',
    )
    assert.include(
      refused({ project: {}, user: brokered({ repos: 'you/api' }) }),
      '`secrets.GITHUB_TOKEN.repos` must be an attribute set',
    )
  })

  it('refuses a grant whose two lists are both empty', () => {
    assert.include(
      refused({ project: {}, user: brokered({ repos: { read: [], write: [] } }) }),
      'reaches nothing',
    )
  })

  it('refuses a repository in both lists, which reads as one kept from being pushed to', () => {
    const message = refused({
      project: {},
      user: brokered({ repos: { read: ['you/api'], write: ['You/API.git'] } }),
    })
    assert.include(
      message,
      '`You/API.git` is in both `secrets.GITHUB_TOKEN.repos.read` and `secrets.GITHUB_TOKEN.repos.write`',
    )
  })

  it('refuses a repository written as anything but owner/repo in write too', () => {
    assert.include(
      refused({
        project: {},
        user: brokered({ repos: { write: ['https://github.com/you/web'] } }),
      }),
      'is not a repository',
    )
  })

  const calling = (over: Record<string, unknown> = {}) => ({
    secrets: {
      ANTHROPIC_API_KEY: {
        allow: ['messages'],
        hosts: ['api.anthropic.com'],
        mode: 'broker',
        profile: 'anthropic-messages',
        projects: [projectRoot],
        source: { command: ['pass', 'show', 'anthropic'] },
        ...over,
      },
    },
  })

  it('carries a model grant through as the rules of the sets it chose, and where they are', () => {
    const [secret] = composed({ project: {}, user: calling() }).secrets
    assert.deepStrictEqual(secret?.mode === 'broker' ? secret.grant : undefined, {
      definedBy: 'igloo',
      hosts: {
        'api.anthropic.com': {
          allow: [
            { method: ['POST'], path: 'v1/messages', set: 'messages' },
            { method: ['POST'], path: 'v1/messages/count_tokens', set: 'messages' },
          ],
          deny: [],
          send: { header: 'x-api-key' },
        },
      },
      placeholders: ['ANTHROPIC_API_KEY'],
      profile: 'anthropic-messages',
    })
  })

  it('refuses a model list or an output ceiling, and says where those limits are set', () => {
    // Ignoring either is how someone ends up believing a key is bounded when
    // nothing bounds it.
    for (const [key, value] of [
      ['models', ['claude-opus-5']],
      ['maxOutputTokens', 4096],
    ] as const) {
      for (const input of [
        { project: {}, user: calling({ [key]: value }) },
        { project: {}, user: brokered({ [key]: value }) },
        {
          project: {
            secrets: {
              OWN: {
                allow: ['models'],
                hosts: ['openrouter.ai'],
                mode: 'broker',
                profile: 'openrouter',
                source: { file: '/k' },
                [key]: value,
              },
            },
          },
        },
      ]) {
        const message = refused(input)
        assert.include(message, `.${key}\` is no longer a setting`)
        assert.include(message, 'set on the key, at the provider')
      }
    }
  })

  it('refuses `repos` on a profile grant, which has no repositories', () => {
    assert.include(
      refused({ project: {}, user: calling({ repos: { read: ['you/api'] } }) }),
      '`secrets.ANTHROPIC_API_KEY.repos` does not apply to the anthropic-messages profile',
    )
  })

  it('refuses two credentials for one profile, which a request could not choose between', () => {
    const message = refused({
      project: {
        secrets: {
          SECOND: {
            allow: ['messages'],
            hosts: ['api.anthropic.com'],
            mode: 'broker',
            profile: 'anthropic-messages',
            source: { file: '/k' },
          },
        },
      },
      user: calling(),
    })
    assert.include(message, `${projectPolicyPath}: \`SECOND\` and \`ANTHROPIC_API_KEY\``)
    assert.include(message, `(in ${userPolicyName})`)
    assert.include(message, 'keep one')
    assert.include(message, 'A request names no credential')
  })

  it('takes one credential for each profile', () => {
    const policy = composed({
      project: {
        secrets: {
          OPENROUTER: {
            allow: ['models'],
            hosts: ['openrouter.ai'],
            mode: 'broker',
            profile: 'openrouter',
            source: { file: '/k' },
          },
        },
      },
      user: { secrets: { ...calling().secrets, ...brokered().secrets } },
    })
    assert.deepStrictEqual(policy.secrets.map(secret => secret.name).toSorted(), [
      'ANTHROPIC_API_KEY',
      'GITHUB_TOKEN',
      'OPENROUTER',
    ])
  })

  it('refuses a second github credential, since a request to its API may name no repository', () => {
    const message = refused({
      project: {
        secrets: {
          SECOND_TOKEN: {
            mode: 'broker',
            profile: 'github',
            repos: { read: ['you/web'] },
            source: { file: '/t' },
          },
        },
      },
      user: brokered(),
    })
    assert.include(message, 'are both brokered for the github profile')
    assert.include(message, 'list every repository in it')
  })

  it('refuses `hosts` and `allow` on a github grant, which names repositories instead', () => {
    for (const key of ['allow', 'hosts']) {
      assert.include(
        refused({ project: {}, user: brokered({ [key]: ['x'] }) }),
        `\`secrets.GITHUB_TOKEN.${key}\` does not apply to the github profile`,
      )
    }
  })

  const driving = (over: Record<string, unknown> = {}) => ({
    secrets: {
      RUNPOD_API_KEY: {
        allow: ['read', 'pods'],
        hosts: ['api.runpod.io'],
        mode: 'broker',
        profile: 'runpod',
        source: { file: '/k' },
        ...over,
      },
    },
  })

  it('sends a runpod grant only the sets it chose, at the hosts they reach', () => {
    const [secret] = composed({ project: driving() }).secrets
    const grant = secret?.mode === 'broker' ? secret.grant : undefined
    assert.isTrue(grant !== undefined && 'hosts' in grant)
    if (grant === undefined || !('hosts' in grant)) return
    assert.deepStrictEqual(Object.keys(grant.hosts), ['api.runpod.io'])
    assert.deepStrictEqual(
      [...new Set(grant.hosts['api.runpod.io']?.allow.map(rule => rule.set))],
      ['read', 'pods'],
    )
    assert.deepStrictEqual(grant.placeholders, ['RUNPOD_API_KEY'])
  })

  it('refuses a second runpod credential, which a request could not choose between', () => {
    const message = refused({
      project: {
        secrets: {
          ...driving().secrets,
          OTHER: { ...driving().secrets.RUNPOD_API_KEY, source: { file: '/j' } },
        },
      },
    })
    assert.include(message, 'are both brokered for the runpod profile')
    assert.include(message, 'A request names no credential')
    assert.notInclude(message, 'repository')
  })
})

/**
 * The tunnel is an authorization rather than a posture, so its default is the
 * opposite of `network`'s: a project reaches exactly what it lists, and the
 * ceiling is the whole of what may be listed.
 */
describe('Config.compose: tunnel destinations', () => {
  const ceiling = { tunnelCeiling: ['pypi.org', 'files.pythonhosted.org', 'registry.npmjs.org'] }

  const restricted = { network: 'restricted' }

  it('gives a project what it listed, and only that', () => {
    assert.deepStrictEqual(
      composed({ project: { ...restricted, tunnel: ['pypi.org'] }, user: ceiling }).tunnel,
      ['pypi.org'],
    )
  })

  it('gives a project that listed nothing no tunnel at all', () => {
    // The ceiling is what may be asked for, not what is granted — otherwise
    // adding a host for one project would widen every other project's egress.
    assert.deepStrictEqual(composed({ project: restricted, user: ceiling }).tunnel, [])
  })

  it('gives internet any public name, and says a list there decides nothing', () => {
    const input = { project: { tunnel: ['pypi.org'] }, user: ceiling }
    assert.strictEqual(composed(input).tunnel, 'any')
    assert.isTrue(notes(input).some(note => note.includes('has no effect')))
  })

  it('refuses a list under none, rather than tunnelling past it', () => {
    const message = refused({ project: { network: 'none', tunnel: ['pypi.org'] }, user: ceiling })
    assert.include(message, 'reaches nothing')
    assert.include(message, 'network = "restricted"')
  })

  it('gives none nothing to tunnel to', () => {
    assert.deepStrictEqual(composed({ project: { network: 'none' }, user: ceiling }).tunnel, [])
  })

  it('refuses a destination outside the ceiling, naming both files', () => {
    const message = refused({ project: { tunnel: ['evil.example'] }, user: ceiling })
    assert.include(message, projectPolicyPath)
    assert.include(message, userPolicyName)
    assert.include(message, 'narrow the ceiling, not widen it')
  })

  it('says where to put it when no ceiling exists at all', () => {
    const message = refused({ project: { tunnel: ['pypi.org'] }, user: {} })
    assert.include(message, 'sets no `tunnelCeiling`')
    assert.include(message, 'tunnelCeiling = [ "pypi.org" ]')
  })

  it('keeps each half in the file it belongs to', () => {
    assert.include(refused({ project: { tunnelCeiling: ['pypi.org'] } }), 'is not a ceiling')
    assert.include(
      refused({ project: {}, user: { tunnel: ['pypi.org'] } }),
      "is a project's own request",
    )
  })

  it('takes a host and nothing that is not one', () => {
    for (const host of ['https://pypi.org', 'pypi.org:443', '*.pypi.org', 'pypi.org/simple']) {
      const message = refused({ user: { tunnelCeiling: [host] } })
      assert.include(message, 'is not a hostname', host)
    }
  })

  it('matches a destination however it is capitalised', () => {
    assert.deepStrictEqual(
      composed({
        project: { ...restricted, tunnel: ['PyPI.org'] },
        user: { tunnelCeiling: ['pypi.org'] },
      }).tunnel,
      ['PyPI.org'],
    )
  })
})

describe('Config.compose: published ports', () => {
  it('reads a bare number as the same port on both sides', () => {
    // The form anyone writes for the common case, and the one that keeps the
    // URL in the browser the same as the port in the project's own config.
    assert.deepStrictEqual(composed({ project: { ports: [3000] } }).ports, [
      { guest: 3000, host: 3000 },
    ])
  })

  it('takes a pair when the host port has to be a different one', () => {
    assert.deepStrictEqual(composed({ project: { ports: [{ guest: 5173, host: 5174 }] } }).ports, [
      { guest: 5173, host: 5174 },
    ])
  })

  it('publishes nothing by default', () => {
    // A port is reachable because a project asked for it and for no other
    // reason; there is no ceiling above this because there is nothing above a
    // project to bound it — the file is written by the person it publishes to.
    assert.deepStrictEqual(composed({ project: {} }).ports, [])
  })

  it('refuses two entries on one host port, naming both guest ports', () => {
    // ssh would fail the second forward, and the message it gives names
    // neither the file nor the other port.
    const message = refused({ project: { ports: [3000, { guest: 4000, host: 3000 }] } })
    assert.include(message, projectPolicyPath)
    assert.include(message, '3000')
    assert.include(message, '4000')
  })

  it('refuses anything that is not a port, and says both forms', () => {
    for (const entry of ['3000', 0, 65536, 1.5, { guest: 3000 }, { host: 3000 }]) {
      const message = refused({ project: { ports: [entry] } })
      assert.include(message, 'is not a port', JSON.stringify(entry))
      assert.include(message, 'guest = 5173')
    }
  })

  it('keeps it in the project, where what is being served is decided', () => {
    assert.include(refused({ user: { ports: [3000] } }), userPolicyName)
  })
})

describe('Config.compose: modelServers', () => {
  const ownServer = (over: Record<string, unknown> = {}) => ({
    modelServers: { 'llama-swap': { port: 8080, ...over } },
  })
  const sharedServer = (over: Record<string, unknown> = {}) => ({
    modelServers: { 'llama-swap': { port: 8080, projects: [projectRoot], ...over } },
  })

  it('gives a project the server its own layer declares', () => {
    assert.deepStrictEqual(composed({ project: ownServer() }).modelServers, [
      { layer: 'project', name: 'llama-swap', port: 8080 },
    ])
  })

  it('gives a project a server the user layer lists it in, and no other project', () => {
    assert.deepStrictEqual(composed({ project: {}, user: sharedServer() }).modelServers, [
      { layer: 'user', name: 'llama-swap', port: 8080 },
    ])
    assert.isEmpty(
      composed({ project: {}, user: sharedServer({ projects: ['/home/you/projects/other'] }) })
        .modelServers,
    )
    const link = '/home/you/link/api'
    assert.lengthOf(
      composed({ aliases: [link], project: {}, user: sharedServer({ projects: [link] }) })
        .modelServers,
      1,
    )
  })

  it('reads a key from where a secret’s value may be read, and nowhere else', () => {
    assert.deepStrictEqual(
      composed({ project: ownServer({ key: { file: '/run/secrets/llama-key' } }) }).modelServers,
      [
        {
          key: { _tag: 'File', path: '/run/secrets/llama-key' },
          layer: 'project',
          name: 'llama-swap',
          port: 8080,
        },
      ],
    )
    const stored = refused({ project: ownServer({ key: { file: '/nix/store/abc-key' } }) })
    assert.include(stored, '`modelServers.llama-swap.key.file`')
    assert.include(stored, 'Nix store')
    assert.include(
      refused({ project: ownServer({ key: { file: 'key' } }) }),
      '`modelServers.llama-swap.key.file` must be an absolute path',
    )
    assert.include(
      refused({ project: ownServer({ key: 'sk-local' }) }),
      '`modelServers.llama-swap.key` must be',
    )
  })

  it('takes a port and a key, and no address, since the server is always on loopback', () => {
    for (const field of ['host', 'url', 'address', 'baseUrl']) {
      const message = refused({ project: ownServer({ [field]: '192.168.1.10' }) })
      assert.include(message, `\`modelServers.llama-swap.${field}\` is not a setting`)
      assert.include(message, 'loopback')
    }
    assert.include(
      refused({ project: ownServer({ projects: [projectRoot] }) }),
      "this project's alone",
    )
  })

  it('refuses a port that is not one, and a name a URL would have to encode', () => {
    for (const port of [0, 65536, 80.5, '8080', undefined]) {
      assert.include(
        refused({ project: ownServer({ port }) }),
        '`modelServers.llama-swap.port` must be the port',
        String(port),
      )
    }
    for (const name of ['Llama', 'llama/swap', 'llama swap', '-swap']) {
      assert.include(
        refused({ project: { modelServers: { [name]: { port: 8080 } } } }),
        'is not a usable model server name',
        name,
      )
    }
    assert.include(refused({ project: { modelServers: [8080] } }), 'an attribute set')
  })

  it('refuses one name from both layers, which would reach two servers', () => {
    const message = refused({ project: ownServer({ port: 8081 }), user: sharedServer() })
    assert.include(message, '`modelServers.llama-swap` is declared here')
    assert.include(message, 'programs.igloo.policy')
  })

  it('refuses a secret holding the name a server’s key is held under', () => {
    const message = refused({
      project: {
        ...ownServer({ key: { file: '/run/secrets/llama-key' } }),
        secrets: {
          'model-server.llama-swap': { mode: 'deliver', source: { file: '/run/secrets/other' } },
        },
      },
    })
    assert.include(message, '`secrets.model-server.llama-swap` takes the name')
  })

  it('refuses a secret holding a name the broker’s TLS identity is held under', () => {
    for (const [name, half] of [
      ['broker.tls-certificate', 'certificate'],
      ['broker.tls-key', 'key'],
    ] as const) {
      const message = refused({
        project: { secrets: { [name]: { mode: 'deliver', source: { file: '/run/secrets/x' } } } },
      })
      assert.include(message, `\`secrets.${name}\` takes a name the broker holds its TLS ${half}`)
    }
  })

  it('refuses a server under none, and reaches it under restricted with nothing else', () => {
    const message = refused({ project: { ...ownServer(), network: 'none' } })
    assert.include(message, '`modelServers.llama-swap` is reached through the broker')
    assert.include(message, 'network = "restricted"')
    // The server is what a restricted VM with no destination reaches, so it is
    // not `none` wearing another word.
    assert.deepStrictEqual(
      notes({ project: { ...ownServer(), network: 'restricted' }, user: {} }),
      [],
    )
    assert.deepStrictEqual(
      composed({ project: { ...ownServer(), network: 'restricted' } }).tunnel,
      [],
    )
  })
})

/** A profile at one host, with a read set and a write set, for a layer to define. */
const exampleProfile = (over: Record<string, unknown> = {}) => ({
  allow: {
    read: { 'api.example.com': [{ method: ['GET', 'HEAD'], path: 'v1/**' }] },
    write: {
      'api.example.com': [{ method: 'POST', path: 'v1/items' }],
      'uploads.example.com': [{ method: 'POST', path: 'files' }],
    },
  },
  deny: { 'api.example.com': [{ method: '*', path: 'v1/keys/**' }] },
  hosts: {
    'api.example.com': { send: 'bearer' },
    'uploads.example.com': { send: { header: 'x-upload-key' } },
  },
  placeholders: ['EXAMPLE_API_KEY'],
  ...over,
})

/** A brokered credential granting `profile`, choosing `allow` and pinning `hosts`. */
const granting = (
  profile: string,
  allow: readonly string[],
  hosts: readonly string[],
  over: Record<string, unknown> = {},
) => ({ allow, hosts, mode: 'broker', profile, source: { file: '/k' }, ...over })

/** The profile grant a composed policy holds, by credential. */
const grantNamed = (policy: Config.Policy, name: string) => {
  const secret = policy.secrets.find(each => each.name === name)
  return secret?.mode === 'broker' && 'hosts' in secret.grant ? secret.grant : undefined
}

describe('Config.compose, on profiles', () => {
  it('grants a project’s own profile to its own credential, with some of its sets', () => {
    const grant = grantNamed(
      composed({
        project: {
          profiles: { example: exampleProfile() },
          secrets: { EXAMPLE: granting('example', ['read'], ['api.example.com']) },
        },
      }),
      'EXAMPLE',
    )
    assert.deepStrictEqual(grant, {
      definedBy: 'project',
      hosts: {
        'api.example.com': {
          allow: [{ method: ['GET', 'HEAD'], path: 'v1/**', set: 'read' }],
          deny: [{ method: '*', path: 'v1/keys/**' }],
          send: 'bearer',
        },
      },
      placeholders: ['EXAMPLE_API_KEY'],
      profile: 'example',
    })
  })

  it('grants a user layer profile to a project’s credential, and to one the user layer shares', () => {
    const user = { profiles: { example: exampleProfile() } }
    const asked = composed({
      project: {
        secrets: {
          EXAMPLE: granting('example', ['write'], ['uploads.example.com', 'API.example.com']),
        },
      },
      user,
    })
    assert.deepStrictEqual(Object.keys(grantNamed(asked, 'EXAMPLE')?.hosts ?? {}), [
      'api.example.com',
      'uploads.example.com',
    ])
    assert.strictEqual(grantNamed(asked, 'EXAMPLE')?.definedBy, 'user')
    const shared = composed({
      project: {},
      user: {
        ...user,
        secrets: {
          EXAMPLE: granting('example', ['read'], ['api.example.com'], { projects: [projectRoot] }),
        },
      },
    })
    assert.strictEqual(grantNamed(shared, 'EXAMPLE')?.profile, 'example')
  })

  it('lets the user layer replace one of igloo’s, and grants the replacement', () => {
    const replaced = composed({
      project: { secrets: { RUNPOD: granting('runpod', ['read'], ['api.example.com']) } },
      user: { profiles: { runpod: exampleProfile() } },
    })
    assert.strictEqual(grantNamed(replaced, 'RUNPOD')?.definedBy, 'user')
    assert.deepStrictEqual(Object.keys(grantNamed(replaced, 'RUNPOD')?.hosts ?? {}), [
      'api.example.com',
    ])
  })

  it('refuses a project defining a name igloo or the user layer defines', () => {
    const igloos = refused({ project: { profiles: { runpod: exampleProfile() } } })
    assert.include(igloos, `${projectPolicyPath}: \`profiles.runpod\` is one of igloo's already`)
    const users = refused({
      project: { profiles: { example: exampleProfile() } },
      user: { profiles: { example: exampleProfile() } },
    })
    assert.include(users, `\`profiles.example\` is defined in ${userPolicyName} already`)
    assert.include(users, 'replace none')
  })

  it('refuses a user layer credential naming a profile only a project defines', () => {
    const message = refused({
      project: { profiles: { example: exampleProfile() } },
      user: {
        secrets: {
          EXAMPLE: granting('example', ['read'], ['api.example.com'], { projects: [projectRoot] }),
        },
      },
    })
    assert.include(
      message,
      `${userPolicyName}: \`secrets.EXAMPLE.profile\` must name a broker profile`,
    )
    assert.include(message, "A project's own profiles are for that project's credentials alone")
  })

  it('refuses `hosts` that leave out a host the chosen sets reach, or name one they do not', () => {
    const missing = refused({
      project: {
        profiles: { example: exampleProfile() },
        secrets: { EXAMPLE: granting('example', ['write'], ['api.example.com']) },
      },
    })
    assert.include(missing, 'does not name uploads.example.com')
    assert.include(missing, 'hosts = [ "api.example.com" "uploads.example.com" ];')
    const extra = refused({
      project: {
        profiles: { example: exampleProfile() },
        secrets: {
          EXAMPLE: granting('example', ['read'], ['api.example.com', 'uploads.example.com']),
        },
      },
    })
    assert.include(extra, 'names uploads.example.com, which no set it allows reaches')
    const elsewhere = refused({
      project: {
        profiles: { example: exampleProfile() },
        secrets: { EXAMPLE: granting('example', ['read'], ['api.example.com', 'evil.example']) },
      },
    })
    assert.include(elsewhere, 'or the example profile names')
  })

  it('refuses a grant choosing no set, a set the profile lacks, or one set twice', () => {
    const project = (allow: readonly string[]) => ({
      project: {
        profiles: { example: exampleProfile() },
        secrets: { EXAMPLE: granting('example', allow, ['api.example.com']) },
      },
    })
    assert.include(refused(project([])), 'chooses no set')
    assert.include(refused(project(['admin'])), 'chooses admin, which is not one of')
    assert.include(refused(project(['read', 'read'])), 'chooses read twice')
  })

  it('refuses two of a project’s grants that reach one host', () => {
    const message = refused({
      project: {
        profiles: {
          example: exampleProfile(),
          mirror: exampleProfile({ placeholders: [] }),
        },
        secrets: {
          ONE: granting('example', ['read'], ['api.example.com']),
          TWO: granting('mirror', ['read'], ['api.example.com']),
        },
      },
    })
    assert.include(message, 'both reach api.example.com')
  })

  it('refuses each of the old shapes, writing out the grant that keeps what it allowed', () => {
    for (const [profile, hosts, allow] of [
      [
        'runpod',
        '[ "api.runpod.ai" "api.runpod.io" ]',
        '[ "clusters" "invoke" "pods" "read" "registries" "secrets" "serverless" "templates" "volumes" ]',
      ],
      ['openrouter', '[ "openrouter.ai" ]', '[ "models" ]'],
      ['anthropic-messages', '[ "api.anthropic.com" ]', '[ "messages" ]'],
    ] as const) {
      const message = refused({
        project: { secrets: { KEY: { mode: 'broker', profile, source: { file: '/k' } } } },
      })
      assert.include(
        message,
        `\`secrets.KEY\` grants the ${profile} profile without choosing from it`,
      )
      assert.include(message, `  hosts = ${hosts};\n  allow = ${allow};`)
    }
  })

  it('refuses `hosts` and `allow` on a delivered credential', () => {
    assert.include(
      refused({
        project: { secrets: { KEY: { allow: ['read'], mode: 'deliver', source: { file: '/k' } } } },
      }),
      'only means something for a brokered credential',
    )
  })
})

describe('Config.compose, on a profile’s definition', () => {
  /** What defining `profile` as `example` in a project comes to. */
  const defining = (profile: unknown) => refused({ project: { profiles: { example: profile } } })

  it('refuses a field a profile does not have, part 2’s and MCP’s among them', () => {
    for (const field of ['repository', 'ask', 'mcp', 'via']) {
      assert.include(
        defining(exampleProfile({ [field]: {} })),
        `\`profiles.example.${field}\` is not a profile's field`,
      )
    }
    assert.include(
      defining(
        exampleProfile({
          hosts: { 'api.example.com': { pages: 'github', send: 'bearer' } },
          allow: { read: { 'api.example.com': [{ method: 'GET', path: '' }] } },
          deny: {},
        }),
      ),
      "is not a host's field",
    )
    assert.include(
      defining(
        exampleProfile({
          allow: { read: { 'api.example.com': [{ length: 'kept', method: 'GET', path: '' }] } },
        }),
      ),
      "`length` is not a rule's field",
    )
  })

  it('refuses a host without `send`, and a key sent in a header the broker frames by', () => {
    assert.include(
      defining(
        exampleProfile({
          hosts: { 'api.example.com': {}, 'uploads.example.com': { send: 'bearer' } },
        }),
      ),
      'says how the key is sent there',
    )
    assert.include(
      defining(
        exampleProfile({
          hosts: {
            'api.example.com': { send: { header: 'Transfer-Encoding' } },
            'uploads.example.com': { send: 'bearer' },
          },
        }),
      ),
      'cannot carry a key',
    )
  })

  it('refuses a host that is an address, has no dot, or is one of github’s', () => {
    for (const host of ['10.0.0.1', 'localhost', 'https://api.example.com']) {
      assert.include(
        defining(exampleProfile({ hosts: { [host]: { send: 'bearer' } } })),
        'is not a host',
        host,
      )
    }
    assert.include(
      defining(exampleProfile({ hosts: { 'api.github.com': { send: 'bearer' } } })),
      "one of the github profile's hosts",
    )
  })

  it('refuses an empty set, and a rule at a host the profile does not name', () => {
    assert.include(defining(exampleProfile({ allow: { read: {} } })), 'is empty')
    assert.include(
      defining(exampleProfile({ allow: { read: { 'api.example.com': [] } } })),
      'non-empty list of rules',
    )
    assert.include(
      defining(
        exampleProfile({ allow: { read: { 'www.example.com': [{ method: 'GET', path: '' }] } } }),
      ),
      'which is not in `profiles.example.hosts`',
    )
    assert.include(defining(exampleProfile({ allow: {} })), 'names the sets')
  })

  it('refuses a method that is not one, and a path with ** anywhere but last', () => {
    for (const method of ['FETCH', 'get', [], ['GET', '*']]) {
      assert.include(
        defining(
          exampleProfile({ allow: { read: { 'api.example.com': [{ method, path: 'v1' }] } } }),
        ),
        'Write one of',
        JSON.stringify(method),
      )
    }
    for (const written of ['v1/**/items', '**/x', '/v1', 'v1/x*', 'repos/{repo}/**']) {
      assert.include(
        defining(
          exampleProfile({
            allow: { read: { 'api.example.com': [{ method: 'GET', path: written }] } },
          }),
        ),
        'A path is segments',
        written,
      )
    }
  })

  it('refuses a placeholder that is not a key’s variable', () => {
    for (const name of ['PATH', 'LD_PRELOAD', 'example_key', 'KEY', 'NODE_OPTIONS']) {
      assert.include(
        defining(exampleProfile({ placeholders: [name] })),
        "is not a key's variable",
        name,
      )
    }
  })

  it('refuses a GraphQL reader on a rule other than a POST, or in a deny rule', () => {
    assert.include(
      defining(
        exampleProfile({
          allow: {
            read: {
              'api.example.com': [{ graphql: { withheld: [] }, method: 'GET', path: 'graphql' }],
            },
          },
        }),
      ),
      'is "POST" alone',
    )
    assert.include(
      defining(
        exampleProfile({
          deny: { 'api.example.com': [{ graphql: {}, method: 'POST', path: 'g' }] },
        }),
      ),
      'no place in a `deny` rule',
    )
  })

  it('refuses a name the broker’s code takes', () => {
    for (const name of ['github', 'model-server']) {
      assert.include(
        refused({ project: { profiles: { [name]: exampleProfile() } } }),
        'Name the profile something else',
      )
    }
  })
})

describe('Config.compose, on a profile under a restricted ceiling', () => {
  const ceiling = (hosts: readonly string[]) => ({
    networkCeiling: 'restricted',
    profiles: { example: exampleProfile() },
    tunnelCeiling: hosts,
  })
  const project = { secrets: { EXAMPLE: granting('example', ['read'], ['api.example.com']) } }

  it('takes a profile whose hosts the ceiling lists', () => {
    assert.isDefined(
      grantNamed(composed({ project, user: ceiling(['api.example.com']) }), 'EXAMPLE'),
    )
  })

  it('refuses one whose host it does not, naming both files', () => {
    const message = refused({ project, user: ceiling(['pypi.org']) })
    assert.include(message, `${projectPolicyPath}: \`secrets.EXAMPLE\` grants the example profile`)
    assert.include(message, `that ${userPolicyName} defines`)
    assert.include(message, `${userPolicyName} sets \`networkCeiling = "restricted"\``)
    assert.include(message, 'api.example.com not in its `tunnelCeiling` (pypi.org)')
  })

  it('exempts a profile igloo ships, and holds the user layer’s replacement of one to it', () => {
    const runpod = {
      secrets: {
        RUNPOD: granting('runpod', ['read', 'invoke'], ['api.runpod.io', 'api.runpod.ai']),
      },
    }
    assert.strictEqual(
      grantNamed(composed({ project: runpod, user: { networkCeiling: 'restricted' } }), 'RUNPOD')
        ?.definedBy,
      'igloo',
    )
    const replaced = refused({
      project: { secrets: { RUNPOD: granting('runpod', ['read'], ['api.example.com']) } },
      user: { ...ceiling([]), profiles: { runpod: exampleProfile() } },
    })
    assert.include(replaced, 'grants the runpod profile that')
  })
})
