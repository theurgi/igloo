import { assert, describe, it } from '@effect/vitest'

import * as Binaries from './Binaries.ts'

describe('Binaries.fromEnv', () => {
  it('falls back to the NixOS system path for systemd-ssh-proxy', () => {
    const bins = Binaries.fromEnv({})
    assert.strictEqual(bins.sshProxy, '/run/current-system/sw/lib/systemd/systemd-ssh-proxy')
  })

  it('lets the environment override every binary', () => {
    const bins = Binaries.fromEnv({
      IGLOO_BWRAP: '/x/bwrap',
      IGLOO_LANDLOCK: '/x/igloo-landlock',
      IGLOO_SSH_PROXY: '/x/proxy',
      IGLOO_STORE_VIEW: '/x/igloo-store-view',
    })
    assert.strictEqual(bins.bwrap, '/x/bwrap')
    assert.strictEqual(bins.landlock, '/x/igloo-landlock')
    assert.strictEqual(bins.sshProxy, '/x/proxy')
    assert.strictEqual(bins.storeView, '/x/igloo-store-view')
    assert.strictEqual(bins.nix, 'nix')
  })
})
