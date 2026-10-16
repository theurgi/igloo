import type * as Config from './Config.ts'

import { assert, describe, it } from '@effect/vitest'

import * as Spec from './Spec.ts'

const facts: Spec.Facts = {
  iglooFlakePath: '/store/igloo',
  cid: 1234,
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

describe('Spec.fromConfig, on where each credential goes', () => {
  const plan = planFor({
    secrets: [
      { layer: 'project', mode: 'deliver', name: 'NPM_TOKEN', source: file('/secrets/npm') },
      {
        grant: { profile: 'github-git', repos: ['you/api'] },
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
      { credential: 'GITHUB_TOKEN', profile: 'github-git', repos: ['you/api'] },
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
      grant: { profile: 'github-git', repos },
      layer: 'project',
      mode: 'broker',
      name,
      source: file(`/${name}`),
    }) as const
  const inferenceGrant = {
    grant: { profile: 'anthropic-messages' },
    layer: 'project',
    mode: 'broker',
    name: 'ANTHROPIC_KEY',
    source: file('/key'),
  } as const

  it('points git at the broker once per upstream, and not at all without a git grant', () => {
    assert.deepStrictEqual(
      planFor({ secrets: [gitGrant(['you/api'], 'ONE'), gitGrant(['you/web'], 'TWO')] }).runner
        .gitBroker,
      { hosts: ['github.com'] },
    )
    assert.isUndefined(planFor({ secrets: [inferenceGrant] }).runner.gitBroker)
  })

  it('has the guest trust the broker’s authority only when the broker answers a name', () => {
    const git = planFor({ secrets: [gitGrant(['you/api'], 'ONE')] }).runner
    assert.strictEqual(git.brokerAuthority, facts.tlsAuthority)
    assert.strictEqual(git.brokerEnv['NODE_EXTRA_CA_CERTS'], '/etc/ssl/certs/ca-certificates.crt')
    for (const runner of [
      planFor({ secrets: [inferenceGrant] }).runner,
      planFor({ tunnel: 'any' }).runner,
    ]) {
      assert.isUndefined(runner.brokerAuthority)
      assert.notProperty(runner.brokerEnv, 'NODE_EXTRA_CA_CERTS')
    }
  })

  it('sets the proxy variables for a name the broker answers, with nowhere to tunnel to', () => {
    const environment = planFor({ secrets: [gitGrant(['you/api'], 'ONE')], tunnel: [] }).runner
      .brokerEnv
    assert.strictEqual(environment['HTTPS_PROXY'], 'http://127.0.0.1:3129')
    assert.notProperty(planFor({ secrets: [inferenceGrant] }).runner.brokerEnv, 'HTTPS_PROXY')
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
      grant: { profile: 'github-git', repos },
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

  it('renders different text for a different grant, destination, port or memory bound', () => {
    const base = planFor({ secrets: [grant(['you/api'], 'ONE')], tunnel: ['pypi.org'] })
    for (const changed of [
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

  it('points omp at the one server, through the broker', () => {
    assert.strictEqual(
      planFor({ modelServers: [keyless] }).runner.brokerEnv['LLAMA_CPP_BASE_URL'],
      'http://127.0.0.1:3128/local/llama-swap/v1',
    )
    assert.notProperty(
      planFor({ modelServers: [keyless, keyed] }).runner.brokerEnv,
      'LLAMA_CPP_BASE_URL',
    )
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
