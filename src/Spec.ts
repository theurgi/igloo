import type * as Secrets from './Secrets.ts'

import * as path from 'node:path'

import * as Broker from './broker.ts'
import * as Config from './Config.ts'
import * as Flake from './Flake.ts'
import * as Vm from './Vm.ts'

/** What a VM's launch depends on besides its configuration: the host's facts about its project. */
export interface Facts {
  readonly iglooFlakePath: string
  readonly cid: number
  readonly homeDir: string
  readonly label: string
  /** The public half of the key the host connects with, authorized in the guest. */
  readonly publicKey: string
  readonly root: string
  readonly runtimeDir: string
  /**
   * The certificate authority the guest trusts for the names the broker
   * answers, as PEM, or `undefined` for a VM whose broker answers none.
   */
  readonly tlsAuthority: string | undefined
  readonly userLayerDir: string | undefined
  readonly workspaceDir: string
}

/** What a project's resolved configuration means for its VM. */
export interface Plan {
  /** Whether the VM gets a broker, and with it the tether. */
  readonly broker: boolean
  readonly brokered: readonly Secrets.Delivery[]
  readonly credentials: readonly Secrets.Delivery[]
  readonly grants: readonly Broker.Grant[]
  /**
   * The broker's grants and memory bound, where the tunnel may go and the
   * published ports, as the text the drift report hashes.
   */
  readonly hostSide: string
  readonly runner: Flake.RunnerSpec
}

/**
 * What a project's broker is granted: one grant per brokered credential, and
 * one per model server, its key held under a name of its own.
 */
export const grantsOf = (policy: Config.Policy): readonly Broker.Grant[] => [
  ...policy.secrets
    .filter(secret => secret.mode === 'broker')
    .map(secret => ({ credential: secret.name, ...secret.grant })),
  ...policy.modelServers.map(server => ({
    ...(server.key === undefined ? {} : { credential: Config.modelServerKeyName(server.name) }),
    name: server.name,
    port: server.port,
    profile: 'model-server' as const,
  })),
]

/**
 * Decide, from the composed layers and the host's facts, where each credential
 * goes, what the broker is granted, what the guest's environment says about
 * it, and the arguments the runner is built with.
 */
export const fromConfig = (
  config: {
    readonly content: readonly { readonly file: string; readonly name: string }[]
    readonly policy: Config.Policy
  },
  facts: Facts,
): Plan => {
  // The value never enters these records — only the path whoever reads it will
  // read it from, which is on the runtime tmpfs and is filled in on the launch
  // path itself. The two differ in exactly that reader: QEMU's `fw_cfg` puts a
  // delivered credential inside the guest, while a brokered one is loaded by
  // systemd into a host process the guest can only send requests to.
  //
  // A command source runs in the directory of the layer that declared it. With
  // no user layer nothing declares one there; `/` stands in as a directory the
  // guest cannot write.
  const cwdFor = (declared: { readonly layer: 'project' | 'user' }) =>
    declared.layer === 'project' ? facts.root : (facts.userLayerDir ?? '/')
  const credentials = config.policy.secrets
    .filter(secret => secret.mode === 'deliver')
    .map(secret => ({
      cwd: cwdFor(secret),
      hostPath: path.join(facts.runtimeDir, 'credentials', secret.name),
      name: secret.name,
      source: secret.source,
    }))
  const toBroker = config.policy.secrets.filter(secret => secret.mode === 'broker')
  const servers = config.policy.modelServers
  // A model server's key is fetched and held as a brokered credential is,
  // under a name of its own.
  const brokered = [
    ...toBroker.map(secret => ({ name: secret.name, secret })),
    ...servers.flatMap(server =>
      server.key === undefined
        ? []
        : [
            {
              name: Config.modelServerKeyName(server.name),
              secret: { layer: server.layer, source: server.key },
            },
          ],
    ),
  ].map(({ name, secret }) => ({
    cwd: cwdFor(secret),
    hostPath: path.join(facts.runtimeDir, 'broker-credentials', name),
    name,
    source: secret.source,
  }))
  const grants = grantsOf(config.policy)
  // The hosts the guest's git reaches the broker at, deduplicated: two grants
  // for the same upstream are one rewrite, and a repeated `insteadOf` would be
  // a conflicting definition rather than a second chance.
  const gitHosts = [
    ...new Set(grants.filter(Broker.isGitGrant).map(grant => Broker.profiles[grant.profile].host)),
  ]
  const answered = Broker.tlsNames(grants).length > 0
  const tunnel = config.policy.tunnel
  // A broker exists for a project that holds a grant, a credential's or a
  // model server's, or that has somewhere to tunnel to, and for no other. The
  // tether is started with it, because it is the only route to it — so a VM
  // with neither gets neither. No guest has a network card, so that is also the whole of its
  // egress.
  const broker = grants.length > 0 || Broker.tunnels(tunnel)
  const brokerEnv = {
    ...Broker.guestEnvironment(grants, Vm.brokerGuestPort),
    // Both spellings, because half the ecosystem reads one and half the other,
    // and `NODE_USE_ENV_PROXY` because Node's own `fetch` ignores the variables
    // without it — which is most of what an agent's tooling is built on. Set
    // for a name the broker answers as well as for a destination, since the
    // tunnel is how a client reaches both.
    //
    // `NO_PROXY` keeps loopback direct. Some clients send a plain `http://`
    // loopback URL to the proxy as well, which refuses anything but `CONNECT`,
    // and loopback is where the broker's own port and every server the guest
    // runs for itself — a local MCP server, say — are listening.
    ...(!Broker.runsTunnel(grants, tunnel)
      ? {}
      : {
          HTTPS_PROXY: `http://127.0.0.1:${String(Vm.proxyGuestPort)}`,
          https_proxy: `http://127.0.0.1:${String(Vm.proxyGuestPort)}`,
          NODE_USE_ENV_PROXY: '1',
          NO_PROXY: '127.0.0.1,localhost,::1',
          no_proxy: '127.0.0.1,localhost,::1',
        }),
    // Node and Bun verify against the authorities they carry rather than the
    // system's, which is where the guest trusts the broker's.
    ...(answered ? { NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt' } : {}),
  }

  const runner: Flake.RunnerSpec = {
    iglooFlakePath: facts.iglooFlakePath,
    brokerAuthority: answered ? facts.tlsAuthority : undefined,
    brokerEnv,
    brokerEtc: Broker.guestEtcFiles(grants, Vm.brokerGuestPort),
    brokerFiles: Broker.guestClientFiles(grants, Vm.brokerGuestPort),
    contentModules: config.content.map(({ file }) => file),
    credentials: credentials.map(({ hostPath, name }) => ({ hostPath, name })),
    gitBroker: gitHosts.length === 0 ? undefined : { hosts: gitHosts },
    hostName: Flake.hostNameFrom(facts.label),
    mem: config.policy.mem,
    shares: [
      { mountPoint: '/workspace', source: facts.workspaceDir, tag: 'workspace' },
      { mountPoint: '/root', source: facts.homeDir, tag: 'home' },
    ],
    sshAuthorizedKey: facts.publicKey,
    vcpu: config.policy.vcpu,
    // The CID has to reach the build and not just the connection: it is a
    // property of the guest's vsock device, so a runner built with one CID is
    // unreachable at another.
    vsockCid: facts.cid,
  }

  // None of these is a file, so they are hashed as values — rendered and sorted
  // rather than serialised, because a hash that moved when a key's insertion
  // order did would report a change nobody made, and a grant reordered in a
  // policy file is the same grant.
  const hostSide = [
    ...grants
      .map(grant =>
        Broker.isModelServerGrant(grant)
          ? `${grant.profile} ${grant.name} port=${String(grant.port)}${grant.credential === undefined ? '' : ` ${grant.credential}`}`
          : Broker.isInferenceGrant(grant)
            ? `${grant.profile} ${grant.credential}`
            : `${grant.profile} ${grant.credential} repos=${grant.repos.toSorted().join(',')}`,
      )
      .toSorted(),
    `brokerMem=${config.policy.brokerMem === undefined ? 'unbounded' : String(config.policy.brokerMem)}`,
    `tunnel=${tunnel === 'any' ? 'any' : tunnel.toSorted().join(',')}`,
    `ports=${config.policy.ports
      .map(port => `${String(port.host)}:${String(port.guest)}`)
      .toSorted()
      .join(',')}`,
  ].join('\n')

  return { broker, brokered, credentials, grants, hostSide, runner }
}
