import { assert, describe, it } from '@effect/vitest'

import * as Cid from './Cid.ts'

const identities = [
  'test',
  'project',
  'project-next',
  '/home/u/projects/thing',
  '',
  'a'.repeat(4096),
]

describe('Cid.forIdentity', () => {
  it('gives the same identity the same CID', () => {
    assert.strictEqual(Cid.forIdentity('project-next'), Cid.forIdentity('project-next'))
  })

  it('pins known identities, so an existing VM stays reachable across versions', () => {
    // These are not arbitrary expectations to be updated when they fail: a
    // change here means a deployed VM's CID moved and the host can no longer
    // attach to it.
    assert.strictEqual(Cid.forIdentity('test'), 2949738981)
    assert.strictEqual(Cid.forIdentity('project-next'), 3407105972)
  })

  it('separates identities that differ by one character', () => {
    assert.notStrictEqual(Cid.forIdentity('foo'), Cid.forIdentity('foo-'))
    assert.notStrictEqual(Cid.forIdentity('project-1'), Cid.forIdentity('project-2'))
  })

  it('stays clear of the reserved CIDs and of hand-picked ones', () => {
    for (const identity of identities) {
      const cid = Cid.forIdentity(identity)
      assert.isAtLeast(cid, 0x10000)
      assert.isAtMost(cid, 0xfffffffe)
      assert.strictEqual(cid, Math.trunc(cid))
    }
  })
})
