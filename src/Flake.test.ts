import { BunServices } from '@effect/platform-bun'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Scope } from 'effect'
import * as path from 'node:path'

import * as Flake from './Flake.ts'

const provided = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(BunServices.layer))

const spec: Flake.RunnerSpec = {
  iglooFlakePath: '/home/you/src/igloo-next',
  brokerEnv: {},
  brokerEtc: {},
  brokerFiles: [],
  contentModules: [],
  credentials: [],
  gitBroker: undefined,
  hostName: 'api',
  mem: 4096,
  shares: [
    { mountPoint: '/workspace', source: '/home/you/projects/api/workspace', tag: 'workspace' },
    { mountPoint: '/root', source: '/home/you/projects/api/.igloo/home', tag: 'home' },
  ],
  sshAuthorizedKey: 'ssh-ed25519 AAAAC3Nza key',
  vcpu: 4,
  vsockCid: 582428065,
}

describe('Flake.hostNameFrom', () => {
  it('leaves a usable label alone', () => {
    assert.strictEqual(Flake.hostNameFrom('igloo-next'), 'igloo-next')
  })

  it('replaces what NixOS would reject', () => {
    // `networking.hostName` is validated at evaluation time, so an unsanitised
    // label fails the build rather than booting with an odd prompt.
    assert.strictEqual(Flake.hostNameFrom('my_app'), 'my-app')
    assert.strictEqual(Flake.hostNameFrom('Some.Thing'), 'some-thing')
  })

  it('never yields a name that starts, ends, or consists of separators', () => {
    assert.strictEqual(Flake.hostNameFrom('_leading'), 'leading')
    assert.strictEqual(Flake.hostNameFrom('trailing_'), 'trailing')
    assert.strictEqual(Flake.hostNameFrom('___'), 'igloo')
    assert.isAtMost(Flake.hostNameFrom('x'.repeat(80)).length, 63)
  })
})

describe('Flake.render', () => {
  it('emits every share with its tag and mount point', () => {
    const text = Flake.render(spec)
    assert.include(text, 'source = "/home/you/projects/api/workspace"')
    assert.include(text, 'mountPoint = "/workspace"')
    assert.include(text, 'tag = "workspace"')
    assert.include(text, 'mountPoint = "/root"')
    assert.include(text, 'tag = "home"')
  })

  it('does not emit the store share, which mkRunner adds itself', () => {
    // Repeating it would give the guest two shares on one tag.
    assert.notInclude(Flake.render(spec), 'ro-store')
  })

  it('writes the CID and key into the text rather than leaving them to the environment', () => {
    const text = Flake.render(spec)
    assert.include(text, 'vsockCid = 582428065;')
    assert.include(text, 'sshAuthorizedKey = "ssh-ed25519 AAAAC3Nza key";')
    assert.notInclude(text, 'getEnv')
  })

  it('imports each content layer from where it lives, in composition order', () => {
    // Imported rather than copied in, so a module's own relative imports still
    // resolve; user first, so a project's module overrides it.
    const text = Flake.render({
      ...spec,
      contentModules: [
        '/nix/store/1ypxl6n5mj3n2qq0cq4c0s8m7ad2mxk9-igloo-user-layer/igloo.nix',
        '/home/you/projects/api/igloo.nix',
      ],
    })
    assert.match(
      text,
      /contentModules = \[\n\s+\(import "\/nix\/store\/1ypxl6n5mj3n2qq0cq4c0s8m7ad2mxk9-igloo-user-layer\/igloo\.nix"\)\n\s+\(import "\/home\/you\/projects\/api\/igloo\.nix"\)\n\s+\];/,
    )
  })

  it('names the hosts the guest sends git at, and the port they reach', () => {
    // The host opens the tether, so the host is what knows the port; a guest
    // configured against another number fails as a refused connection inside the
    // VM, a long way from what set it.
    const text = Flake.render({
      ...spec,
      gitBroker: { hosts: ['github.com'], port: 3128 },
    })
    assert.include(text, 'gitBroker = { hosts = [ "github.com" ]; port = 3128; };')
  })

  it('says so when no git grant exists, rather than leaving it out', () => {
    assert.include(Flake.render(spec), 'gitBroker = null;')
  })

  it('emits the environment that points a provider client at the broker', () => {
    const text = Flake.render({
      ...spec,
      brokerEnv: {
        ANTHROPIC_API_KEY: 'igloo-broker-holds-the-real-key',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:3128/api.anthropic.com',
      },
    })
    assert.include(text, 'ANTHROPIC_BASE_URL = "http://127.0.0.1:3128/api.anthropic.com";')
    assert.include(text, 'ANTHROPIC_API_KEY = "igloo-broker-holds-the-real-key";')
  })

  it('says so when no provider grant exists either', () => {
    assert.include(Flake.render(spec), 'brokerEnv = { };')
    assert.include(Flake.render(spec), 'brokerFiles = [ ];')
    assert.include(Flake.render(spec), 'brokerEtc = { };')
  })

  it('emits the /etc files that point a client at the broker, escaped as Nix strings', () => {
    const text = Flake.render({
      ...spec,
      brokerEtc: { 'igloo/opencode.json': '{"provider":{}}\n' },
    })
    assert.include(text, '"igloo/opencode.json" = "{\\"provider\\":{}}\n";')
  })

  it('emits the files that point a client at the broker, escaped as Nix strings', () => {
    const text = Flake.render({
      ...spec,
      brokerFiles: [
        { content: '{\n  "providers": {}\n}\n', path: '.pi/agent/models.json', program: 'pi' },
      ],
    })
    assert.include(
      text,
      '{ path = ".pi/agent/models.json"; program = "pi"; content = "{\n  \\"providers\\": {}\n}\n"; }',
    )
  })

  it('says so when no content layer was found', () => {
    // The first question anyone asks when their configuration appears to do
    // nothing is answered by this file.
    assert.include(Flake.render(spec), 'contentModules = [ ];')
  })

  it('emits the machine bindings rather than inheriting them', () => {
    assert.include(Flake.render({ ...spec, mem: 2047, vcpu: 8 }), 'mem = 2047;')
    assert.include(Flake.render({ ...spec, mem: 2047, vcpu: 8 }), 'vcpu = 8;')
  })

  it('takes igloo as a path input', () => {
    assert.include(Flake.render(spec), 'inputs.igloo.url = "path:/home/you/src/igloo-next"')
  })

  it('escapes a path that would otherwise end the Nix string', () => {
    const text = Flake.render({
      ...spec,
      shares: [{ mountPoint: '/workspace', source: '/tmp/a"b\\c', tag: 'workspace' }],
    })
    assert.include(text, String.raw`source = "/tmp/a\"b\\c"`)
  })

  it('escapes a path that would otherwise be evaluated as Nix', () => {
    const text = Flake.render({
      ...spec,
      shares: [
        { mountPoint: '/workspace', source: '/tmp/${builtins.currentSystem}', tag: 'workspace' },
      ],
    })
    assert.include(text, String.raw`source = "/tmp/\${builtins.currentSystem}"`)
  })
})

describe('Flake.comparable', () => {
  it('reads an igloo upgrade that changed nothing else as unchanged', () => {
    // An installed igloo is a store path, and an upgrade is a new one.
    const at = (iglooFlakePath: string) => Flake.comparable({ ...spec, iglooFlakePath })
    assert.strictEqual(
      at('/nix/store/0a3dq2gjbzsw1mnf7xyzsq1v6ylc7mkr-source'),
      at('/nix/store/9zkcl1wfbk06mmz2yx2l3qh1q5vgd2dr-source'),
    )
  })

  it('reads a home-manager switch that moved the user layer as unchanged', () => {
    // Its file is compared on its own account; the path is what a switch moves.
    const at = (userLayer: string) =>
      Flake.comparable({
        ...spec,
        contentModules: [`${userLayer}/igloo.nix`, '/home/you/projects/api/igloo.nix'],
      })
    assert.strictEqual(
      at('/nix/store/1ypxl6n5mj3n2qq0cq4c0s8m7ad2mxk9-igloo-user-layer'),
      at('/nix/store/7b2qk0wz9jv3m0y4p9ffd1h6wq3s8l5c-igloo-user-layer'),
    )
  })

  it('still says how many layers there are', () => {
    // A layer added or removed is a different runner.
    const withLayers = (count: number) =>
      Flake.comparable({
        ...spec,
        contentModules: Array.from({ length: count }, (_, index) => `/layer-${String(index)}.nix`),
      })
    assert.notStrictEqual(withLayers(1), withLayers(2))
  })

  it('leaves out the paths it imports and nothing else', () => {
    // Anything more left out is a change to the runner the report cannot see.
    const layered = { ...spec, contentModules: ['/home/you/projects/api/igloo.nix'] }
    const comparable = Flake.comparable(layered).split('\n')
    const differing = Flake.render(layered)
      .split('\n')
      .filter((line, index) => line !== comparable[index])
    assert.deepStrictEqual(differing, [
      '  inputs.igloo.url = "path:/home/you/src/igloo-next";',
      '          (import "/home/you/projects/api/igloo.nix")',
    ])
  })
})

describe('Flake.write', () => {
  it.effect('writes flake.nix, returns its reference, and leaves no lock file', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = path.join(yield* fs.makeTempDirectoryScoped(), 'runner')

        const ref = yield* Flake.write(dir, spec)

        assert.strictEqual(ref, `path:${dir}`)
        assert.strictEqual(
          yield* fs.readFileString(path.join(dir, 'flake.nix')),
          Flake.render(spec),
        )
        // A lock would pin the `path:` input to a copy of the igloo tree, leaving
        // the next launch building a version of the tool that is not installed.
        assert.isFalse(yield* fs.exists(path.join(dir, 'flake.lock')))
      }),
    ),
  )

  it.effect('overwrites a previous run rather than leaving stale facts behind', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = path.join(yield* fs.makeTempDirectoryScoped(), 'runner')

        yield* Flake.write(dir, spec)
        yield* Flake.write(dir, { ...spec, vsockCid: 99 })

        const text = yield* fs.readFileString(path.join(dir, 'flake.nix'))
        assert.include(text, 'vsockCid = 99;')
        assert.notInclude(text, '582428065')
      }),
    ),
  )
})
