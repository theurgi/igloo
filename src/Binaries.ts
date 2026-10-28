/**
 * External programs, each overridable by environment variable so a test can
 * substitute a fake and a host with an unusual layout can be corrected without
 * a code change.
 */
export interface Binaries {
  /**
   * The per-VM credential broker. A store path, or a program that needs
   * nothing outside the store but itself: its unit is given the program and
   * nothing beside it, so a script that runs the checkout's source cannot find
   * it. The devshell points this at the flake's own.
   */
  readonly broker: string
  /** Only the fallback sandbox uses this. */
  readonly bwrap: string
  /**
   * `igloo-landlock`, which the broker and the published ports run under so
   * that they reach no TCP port but their own and none of the user's abstract
   * sockets, and nix runs under to evaluate, so that it reads none of the
   * user's files. The devshell points this at the flake's own.
   */
  readonly landlock: string
  /** Only the preflight uses this, to ask whether the user's manager lingers. */
  readonly loginctl: string
  readonly nix: string
  readonly ssh: string
  /**
   * systemd's `ssh` client helper, which turns a `vsock/<cid>` host name into
   * an `AF_VSOCK` connection. Passed as an explicit `ProxyCommand` rather than
   * relied on through the host's `/etc/ssh/ssh_config`, so the tool does not
   * depend on how the host configured its ssh client.
   */
  readonly sshProxy: string
  /**
   * `igloo-store-view`, which runs the store's daemon in a namespace whose
   * `/nix/store` holds only the runner's closure. The devshell points this at
   * the flake's own.
   */
  readonly storeView: string
  readonly systemctl: string
  readonly systemdRun: string
  /**
   * The virtio-fs daemon, one process per share. It must be the same derivation
   * the runner was built against: the daemon serving the store runs in a
   * namespace holding only that runner's closure, so a binary from anywhere
   * else in the store cannot exec there. The devshell points this at the
   * flake's own.
   */
  readonly virtiofsd: string
}

export const fromEnv = (env: Record<string, string | undefined>): Binaries => ({
  broker: env['IGLOO_BROKER'] ?? 'igloo-broker',
  bwrap: env['IGLOO_BWRAP'] ?? 'bwrap',
  landlock: env['IGLOO_LANDLOCK'] ?? 'igloo-landlock',
  loginctl: env['IGLOO_LOGINCTL'] ?? 'loginctl',
  nix: env['IGLOO_NIX'] ?? 'nix',
  ssh: env['IGLOO_SSH'] ?? 'ssh',
  sshProxy: env['IGLOO_SSH_PROXY'] ?? '/run/current-system/sw/lib/systemd/systemd-ssh-proxy',
  storeView: env['IGLOO_STORE_VIEW'] ?? 'igloo-store-view',
  systemctl: env['IGLOO_SYSTEMCTL'] ?? 'systemctl',
  systemdRun: env['IGLOO_SYSTEMD_RUN'] ?? 'systemd-run',
  virtiofsd: env['IGLOO_VIRTIOFSD'] ?? 'virtiofsd',
})
