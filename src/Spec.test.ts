import { assert, describe, it } from '@effect/vitest'
import { Result } from 'effect'
import { readFileSync } from 'node:fs'

import * as Broker from './broker.ts'
import * as Config from './Config.ts'
import * as Profiles from './Profiles.ts'
import * as Spec from './Spec.ts'

const facts: Spec.Facts = {
  iglooFlakePath: '/store/igloo',
  cid: 1234,
  diskImage: '/home/you/api/.igloo/disk.img',
  homeDir: '/home/you/api/.igloo/home',
  label: 'api',
  publicKey: 'ssh-ed25519 AAAA igloo',
  root: '/home/you/api',
  runtimeDir: '/run/user/1000/igloo/api-4d2',
  tlsAuthority: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
  userLayerDir: '/store/user-layer',
  workspaceDir: '/home/you/api/workspace',
}

const policy: Config.Policy = {
  brokerMem: undefined,
  disk: undefined,
  mem: 4096,
  modelServers: [],
  network: 'internet',
  ports: [],
  secrets: [],
  tunnel: [],
  vcpu: 2,
}

const file = (path: string) => ({ _tag: 'File', path }) as const

const planFor = (overrides: Partial<Config.Policy>, at: Spec.Facts = facts): Spec.Plan =>
  Spec.fromConfig({ content: [], policy: { ...policy, ...overrides } }, at)

describe('Spec.fromConfig, on the disk', () => {
  it('gives the runner no disk without one in policy', () => {
    assert.isUndefined(planFor({}).runner.disk)
  })

  it("gives the runner the project's file, and not its size", () => {
    const small = planFor({ disk: 20480 })
    assert.deepStrictEqual(small.runner.disk, { image: facts.diskImage })
    // A disk that grows is the same runner, and a launch that says so.
    const large = planFor({ disk: 40960 })
    assert.deepStrictEqual(large.runner, small.runner)
    assert.notStrictEqual(large.hostSide, small.hostSide)
  })
})

describe('Spec.fromConfig, on where each credential goes', () => {
  const plan = planFor({
    secrets: [
      { layer: 'project', mode: 'deliver', name: 'NPM_TOKEN', source: file('/secrets/npm') },
      {
        grant: { profile: 'github', repos: ['you/api'] },
        layer: 'user',
        mode: 'broker',
        name: 'GITHUB_TOKEN',
        source: file('/secrets/github'),
      },
    ],
  })

  it('hands the guest a delivered credential, and nothing brokered', () => {
    assert.deepStrictEqual(plan.runner.credentials, [
      { hostPath: `${facts.runtimeDir}/credentials/NPM_TOKEN`, name: 'NPM_TOKEN' },
    ])
    assert.deepStrictEqual(
      plan.credentials.map(({ name }) => name),
      ['NPM_TOKEN'],
    )
    // Nothing the runner is built from names the brokered value's file.
    assert.notInclude(JSON.stringify(plan.runner), 'broker-credentials')
    assert.notInclude(JSON.stringify(plan.runner), 'GITHUB_TOKEN')
  })

  it('keeps a brokered credential for the broker, with its grant', () => {
    assert.deepStrictEqual(plan.brokered, [
      {
        cwd: facts.userLayerDir ?? '',
        hostPath: `${facts.runtimeDir}/broker-credentials/GITHUB_TOKEN`,
        name: 'GITHUB_TOKEN',
        source: file('/secrets/github'),
      },
    ])
    assert.deepStrictEqual(plan.grants, [
      { credential: 'GITHUB_TOKEN', profile: 'github', repos: ['you/api'] },
    ])
    assert.isTrue(plan.broker)
  })
})

describe('Spec.fromConfig, on the rest of what it decides', () => {
  const declared = (layer: 'project' | 'user') =>
    ({ layer, mode: 'deliver', name: 'T', source: file('/t') }) as const

  it('runs a command source in the directory of the layer that declared it', () => {
    const cwd = (layer: 'project' | 'user', at: Spec.Facts = facts) =>
      planFor({ secrets: [declared(layer)] }, at).credentials[0]?.cwd
    assert.strictEqual(cwd('project'), facts.root)
    assert.strictEqual(cwd('user'), facts.userLayerDir)
    // With no user layer, a directory the guest cannot write.
    assert.strictEqual(cwd('user', { ...facts, userLayerDir: undefined }), '/')
  })

  const gitGrant = (repos: readonly string[], name: string) =>
    ({
      grant: { profile: 'github', repos },
      layer: 'project',
      mode: 'broker',
      name,
      source: file(`/${name}`),
    }) as const
  const inferenceGrant = {
    grant: {
      definedBy: 'igloo',
      hosts: {
        'api.anthropic.com': {
          allow: [{ method: ['POST'], path: 'v1/messages', set: 'messages' }],
          deny: [],
          send: { header: 'x-api-key' },
        },
      },
      placeholders: ['ANTHROPIC_API_KEY'],
      profile: 'anthropic-messages',
    },
    layer: 'project',
    mode: 'broker',
    name: 'ANTHROPIC_KEY',
    source: file('/key'),
  } as const
  const modelServer: Config.ModelServerDeclaration = { layer: 'user', name: 'local', port: 8080 }

  it('points git at the broker once per upstream, and not at all without a git grant', () => {
    assert.deepStrictEqual(
      planFor({ secrets: [gitGrant(['you/api'], 'ONE'), gitGrant(['you/web'], 'TWO')] }).runner
        .gitBroker,
      { hosts: ['github.com'] },
    )
    assert.isUndefined(planFor({ secrets: [inferenceGrant] }).runner.gitBroker)
  })

  it('has the guest trust the broker’s authority only when the broker answers a name', () => {
    for (const answered of [gitGrant(['you/api'], 'ONE'), inferenceGrant]) {
      const { runner } = planFor({ secrets: [answered] })
      assert.strictEqual(runner.brokerAuthority, facts.tlsAuthority)
      for (const name of ['NIX_SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) {
        assert.strictEqual(runner.brokerEnv[name], '/etc/ssl/certs/ca-certificates.crt')
      }
    }
    for (const runner of [
      planFor({ modelServers: [modelServer] }).runner,
      planFor({ tunnel: 'any' }).runner,
    ]) {
      assert.isUndefined(runner.brokerAuthority)
      assert.notProperty(runner.brokerEnv, 'NIX_SSL_CERT_FILE')
      assert.notProperty(runner.brokerEnv, 'NODE_EXTRA_CA_CERTS')
    }
  })

  it('sets the proxy variables for a name the broker answers, with nowhere to tunnel to', () => {
    const environment = planFor({ secrets: [gitGrant(['you/api'], 'ONE')], tunnel: [] }).runner
      .brokerEnv
    assert.strictEqual(environment['HTTPS_PROXY'], 'http://127.0.0.1:3129')
    assert.strictEqual(
      planFor({ secrets: [inferenceGrant] }).runner.brokerEnv['HTTPS_PROXY'],
      'http://127.0.0.1:3129',
    )
    assert.notProperty(planFor({ modelServers: [modelServer] }).runner.brokerEnv, 'HTTPS_PROXY')
  })

  it('gives a VM a broker for a brokered credential or a tunnel, and none for neither', () => {
    assert.isFalse(planFor({}).broker)
    assert.isFalse(planFor({ secrets: [declared('project')] }).broker)
    assert.isTrue(planFor({ tunnel: ['pypi.org'] }).broker)
    assert.isTrue(planFor({ tunnel: 'any' }).broker)
  })

  it('sets the proxy variables only when the tunnel goes somewhere', () => {
    assert.notProperty(planFor({}).runner.brokerEnv, 'HTTPS_PROXY')
    for (const tunnel of [['pypi.org'], 'any'] as const) {
      const environment = planFor({ tunnel }).runner.brokerEnv
      assert.strictEqual(environment['HTTPS_PROXY'], 'http://127.0.0.1:3129')
      assert.strictEqual(environment['https_proxy'], 'http://127.0.0.1:3129')
      assert.strictEqual(environment['NODE_USE_ENV_PROXY'], '1')
      assert.include(environment['NO_PROXY'] ?? '', '127.0.0.1')
    }
  })

  it('builds the runner for this project: its CID, its key, its shares and its content', () => {
    const { runner } = Spec.fromConfig(
      { content: [{ file: '/home/you/api/igloo.nix', name: 'the project layer' }], policy },
      facts,
    )
    assert.strictEqual(runner.vsockCid, facts.cid)
    assert.strictEqual(runner.sshAuthorizedKey, facts.publicKey)
    assert.deepStrictEqual(runner.contentModules, ['/home/you/api/igloo.nix'])
    assert.deepStrictEqual(
      runner.shares.map(({ mountPoint, source }) => [mountPoint, source]),
      [
        ['/workspace', facts.workspaceDir],
        ['/root', facts.homeDir],
      ],
    )
    assert.strictEqual(runner.mem, policy.mem)
    assert.strictEqual(runner.vcpu, policy.vcpu)
  })
})

describe('Spec.fromConfig, on what the drift report hashes', () => {
  const grant = (repos: readonly string[], name: string) =>
    ({
      grant: { profile: 'github', repos },
      layer: 'project',
      mode: 'broker',
      name,
      source: file(`/${name}`),
    }) as const

  it('renders the same text however the policy file ordered things', () => {
    const one = planFor({
      ports: [
        { guest: 3000, host: 3000 },
        { guest: 5173, host: 8080 },
      ],
      secrets: [grant(['you/api', 'you/web'], 'ONE'), grant(['you/cli'], 'TWO')],
      tunnel: ['pypi.org', 'crates.io'],
    })
    const other = planFor({
      ports: [
        { guest: 5173, host: 8080 },
        { guest: 3000, host: 3000 },
      ],
      secrets: [grant(['you/cli'], 'TWO'), grant(['you/web', 'you/api'], 'ONE')],
      tunnel: ['crates.io', 'pypi.org'],
    })
    assert.strictEqual(one.hostSide, other.hostSide)
  })

  it('renders different text for a different grant, destination, port, memory bound or disk size', () => {
    const base = planFor({ secrets: [grant(['you/api'], 'ONE')], tunnel: ['pypi.org'] })
    for (const changed of [
      planFor({ disk: 20480, secrets: [grant(['you/api'], 'ONE')], tunnel: ['pypi.org'] }),
      planFor({ brokerMem: 512, secrets: [grant(['you/api'], 'ONE')], tunnel: ['pypi.org'] }),
      planFor({ secrets: [grant(['you/web'], 'ONE')], tunnel: ['pypi.org'] }),
      planFor({ secrets: [grant(['you/api'], 'ONE')], tunnel: 'any' }),
      planFor({
        ports: [{ guest: 3000, host: 3000 }],
        secrets: [grant(['you/api'], 'ONE')],
        tunnel: ['pypi.org'],
      }),
    ]) {
      assert.notStrictEqual(changed.hostSide, base.hostSide)
    }
  })
})

describe('Spec.fromConfig, for a profile grant', () => {
  const rules = (over: Record<string, unknown> = {}) => ({
    allow: [
      { method: ['GET', 'HEAD'], path: 'v2/**', set: 'read' },
      { method: ['POST'], path: 'v2/pods', set: 'pods' },
    ],
    deny: [],
    send: 'bearer' as const,
    ...over,
  })
  const runpodGrant = (
    hosts: Record<string, ReturnType<typeof rules>> = { 'api.runpod.io': rules() },
  ) =>
    ({
      grant: {
        definedBy: 'igloo',
        hosts,
        placeholders: ['RUNPOD_API_KEY', 'RUNPOD_TOKEN'],
        profile: 'runpod',
      },
      layer: 'project',
      mode: 'broker',
      name: 'RUNPOD_API_KEY',
      source: file('/secrets/runpod'),
    }) as const
  const plan = planFor({ secrets: [runpodGrant()] })

  it('grants the broker what it reads of the grant, and holds its key there', () => {
    assert.deepStrictEqual(plan.grants, [
      { credential: 'RUNPOD_API_KEY', hosts: { 'api.runpod.io': rules() }, profile: 'runpod' },
    ])
    assert.deepStrictEqual(
      plan.brokered.map(each => each.name),
      ['RUNPOD_API_KEY'],
    )
    assert.deepStrictEqual(plan.credentials, [])
    assert.isTrue(plan.broker)
  })

  it('sets the profile’s placeholders, and has the guest reach its hosts trusting the broker', () => {
    assert.strictEqual(plan.runner.brokerAuthority, facts.tlsAuthority)
    for (const name of ['RUNPOD_API_KEY', 'RUNPOD_TOKEN']) {
      assert.strictEqual(plan.runner.brokerEnv[name], 'igloo-broker-holds-the-real-key')
    }
    assert.strictEqual(plan.runner.brokerEnv['HTTPS_PROXY'], 'http://127.0.0.1:3129')
    assert.strictEqual(
      plan.runner.brokerEnv['NODE_EXTRA_CA_CERTS'],
      '/etc/ssl/certs/ca-certificates.crt',
    )
    assert.isUndefined(plan.runner.gitBroker)
    assert.notProperty(planFor({}).runner.brokerEnv, 'RUNPOD_API_KEY')
  })

  it('records the profile, its sets and hosts, and a hash of the rules sent', () => {
    assert.match(
      plan.hostSide,
      /^runpod RUNPOD_API_KEY sets=pods,read hosts=api\.runpod\.io rules=[0-9a-f]{64}$/m,
    )
    // The same rules in another order are the same grant.
    const reordered = planFor({
      secrets: [
        runpodGrant({ 'api.runpod.io': rules({ allow: [...rules().allow].toReversed() }) }),
      ],
    })
    assert.strictEqual(reordered.hostSide, plan.hostSide)
    // A rule changed under the same sets and hosts is a change.
    const widened = planFor({
      secrets: [
        runpodGrant({
          'api.runpod.io': rules({
            allow: [...rules().allow, { method: ['DELETE'], path: 'v2/pods/*', set: 'pods' }],
          }),
        }),
      ],
    })
    assert.notStrictEqual(widened.hostSide, plan.hostSide)
    const sentOtherwise = planFor({
      secrets: [runpodGrant({ 'api.runpod.io': rules({ send: { header: 'x-key' } }) })],
    })
    assert.notStrictEqual(sentOtherwise.hostSide, plan.hostSide)
  })
})

describe('Spec.fromConfig, for a model server', () => {
  const keyless: Config.ModelServerDeclaration = { layer: 'user', name: 'llama-swap', port: 8080 }
  const keyed: Config.ModelServerDeclaration = {
    key: file('/secrets/ollama'),
    layer: 'project',
    name: 'ollama',
    port: 11434,
  }

  it('grants the broker the server, and a broker for it with no credential to hold', () => {
    const plan = planFor({ modelServers: [keyless], network: 'restricted' })
    assert.deepStrictEqual(plan.grants, [
      { name: 'llama-swap', port: 8080, profile: 'model-server' },
    ])
    assert.isEmpty(plan.brokered)
    assert.isTrue(plan.broker)
  })

  it('holds a server’s key as a brokered credential, read where its layer is', () => {
    const plan = planFor({ modelServers: [keyed] })
    assert.deepStrictEqual(plan.brokered, [
      {
        cwd: facts.root,
        hostPath: `${facts.runtimeDir}/broker-credentials/model-server.ollama`,
        name: 'model-server.ollama',
        source: file('/secrets/ollama'),
      },
    ])
    assert.deepStrictEqual(plan.grants, [
      { credential: 'model-server.ollama', name: 'ollama', port: 11434, profile: 'model-server' },
    ])
    assert.notInclude(JSON.stringify(plan.runner), 'broker-credentials')
  })

  it('records the server, its port and its key’s name as what the broker was started with', () => {
    const base = planFor({ modelServers: [keyless] })
    assert.include(base.hostSide, 'model-server llama-swap port=8080')
    for (const changed of [
      planFor({ modelServers: [{ ...keyless, port: 8081 }] }),
      planFor({ modelServers: [{ ...keyless, name: 'llama' }] }),
      planFor({ modelServers: [{ ...keyless, key: file('/k') }] }),
    ]) {
      assert.notStrictEqual(changed.hostSide, base.hostSide)
    }
    assert.strictEqual(
      planFor({ modelServers: [keyless, keyed] }).hostSide,
      planFor({ modelServers: [keyed, keyless] }).hostSide,
    )
  })
})

describe('a profile, from its definition to the broker', () => {
  /** igloo's profiles, from the JSON the package carries: `IGLOO_PROFILES`, which the devshell sets. */
  const shipped = (): ReadonlyMap<string, Profiles.Profile> => {
    const at = process.env['IGLOO_PROFILES']
    if (at === undefined || at === '') {
      throw new Error('IGLOO_PROFILES is not set: run the tests in `nix develop`')
    }
    return Result.getOrThrow(Profiles.read(at, JSON.parse(readFileSync(at, 'utf8'))))
  }
  const root = '/home/you/api'
  const example = {
    allow: {
      read: { 'api.example.com': [{ method: 'GET', path: 'v1/**' }] },
      write: { 'api.example.com': [{ method: 'POST', path: 'v1/items' }] },
    },
    hosts: { 'api.example.com': { send: { header: 'x-example-key' } } },
    placeholders: ['EXAMPLE_API_KEY'],
  }
  const reading = {
    allow: ['read'],
    hosts: ['api.example.com'],
    mode: 'broker',
    profile: 'example',
    source: { file: '/k' },
  }

  /**
   * The grants the broker is started with for these layers, read back as it
   * reads its `--grants`, and its decision on a request addressed by name.
   */
  const served = (layers: {
    readonly project: Record<string, unknown>
    readonly user?: Record<string, unknown>
  }) => {
    const composed = Result.getOrThrow(
      Config.compose({
        igloo: shipped(),
        project: { path: `${root}/igloo-policy.nix`, values: layers.project },
        projectAliases: [],
        projectRoot: root,
        user:
          layers.user === undefined
            ? undefined
            : { path: 'programs.igloo.policy', values: layers.user },
        userPolicyName: 'programs.igloo.policy',
      }),
    )
    const plan = Spec.fromConfig({ content: [], policy: composed.policy }, facts)
    const parsed = Broker.parseGrants(JSON.stringify(plan.grants))
    if ('message' in parsed) throw new Error(parsed.message)
    return {
      decide: (method: string, url: string) =>
        Broker.decideAddressed(parsed.grants, method, url)._tag,
      plan,
    }
  }

  it('serves what a project’s own profile’s chosen sets allow, and nothing else', () => {
    const { decide, plan } = served({
      project: { profiles: { example }, secrets: { EXAMPLE: reading } },
    })
    assert.strictEqual(decide('GET', 'https://api.example.com/v1/items'), 'Profile')
    assert.strictEqual(decide('POST', 'https://api.example.com/v1/items'), 'Deny')
    assert.strictEqual(plan.runner.brokerEnv['EXAMPLE_API_KEY'], Broker.guestPlaceholderKey)
  })

  it('serves a user layer’s profile, granted by the project or by the user layer', () => {
    for (const layers of [
      { project: { secrets: { EXAMPLE: reading } }, user: { profiles: { example } } },
      {
        project: {},
        user: { profiles: { example }, secrets: { EXAMPLE: { ...reading, projects: [root] } } },
      },
    ]) {
      const { decide } = served(layers)
      assert.strictEqual(decide('GET', 'https://api.example.com/v1/items'), 'Profile')
      assert.strictEqual(decide('POST', 'https://api.example.com/v1/items'), 'Deny')
    }
  })

  it('serves one of igloo’s, with the sets chosen and none other', () => {
    const { decide, plan } = served({
      project: {
        secrets: {
          RUNPOD: {
            allow: ['read'],
            hosts: ['api.runpod.io'],
            mode: 'broker',
            profile: 'runpod',
            source: { file: '/k' },
          },
        },
      },
    })
    assert.strictEqual(decide('GET', 'https://api.runpod.io/v2/pods'), 'Profile')
    assert.strictEqual(decide('POST', 'https://api.runpod.io/v2/pods'), 'Deny')
    assert.strictEqual(decide('POST', 'https://api.runpod.ai/v2/ep1/run'), 'Deny')
    assert.strictEqual(plan.runner.brokerEnv['RUNPOD_API_KEY'], Broker.guestPlaceholderKey)
  })
})
