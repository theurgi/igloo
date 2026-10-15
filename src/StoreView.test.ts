import { assert, describe, it } from '@effect/vitest'

import * as StoreView from './StoreView.ts'

describe('StoreView.argv', () => {
  it('names the paths file and then runs the command, unchanged', () => {
    assert.deepStrictEqual(
      StoreView.argv({
        argv: ['/nix/store/aaa-virtiofsd/bin/virtiofsd', '--shared-dir=/nix/store'],
        helper: '/nix/store/bbb-igloo-store-view/bin/igloo-store-view',
        paths: '/run/user/1000/igloo/test/store-paths',
      }),
      [
        '/nix/store/bbb-igloo-store-view/bin/igloo-store-view',
        '/run/user/1000/igloo/test/store-paths',
        '/nix/store/aaa-virtiofsd/bin/virtiofsd',
        '--shared-dir=/nix/store',
      ],
    )
  })
})

describe('StoreView.pathsFile', () => {
  it('writes one path per line, each terminated', () => {
    // The helper refuses a line it cannot read as a store path rather than
    // skipping it, so an unterminated last line has to read back whole.
    assert.strictEqual(
      StoreView.pathsFile(['/nix/store/aaa', '/nix/store/bbb']),
      '/nix/store/aaa\n/nix/store/bbb\n',
    )
  })

  it('writes nothing for an empty closure, which the helper then refuses', () => {
    assert.strictEqual(StoreView.pathsFile([]), '')
  })
})

describe('StoreView.storePathOf', () => {
  it('cuts a path inside the store down to the store path holding it', () => {
    assert.strictEqual(
      StoreView.storePathOf('/nix/store/aaa-virtiofsd-1.14.0/bin/virtiofsd'),
      '/nix/store/aaa-virtiofsd-1.14.0',
    )
    assert.strictEqual(StoreView.storePathOf('/nix/store/aaa'), '/nix/store/aaa')
  })

  it('has no answer for a path outside the store, or the store itself', () => {
    assert.isUndefined(StoreView.storePathOf('/usr/bin/virtiofsd'))
    assert.isUndefined(StoreView.storePathOf('virtiofsd'))
    assert.isUndefined(StoreView.storePathOf('/nix/store'))
    assert.isUndefined(StoreView.storePathOf('/nix/store/'))
    assert.isUndefined(StoreView.storePathOf('/nix/storefront/x'))
  })
})
