import { assert, describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'

import * as BuildPlan from './BuildPlan.ts'

const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const fod = '/nix/store/8kknbnsz99b477kskjs7sn76q9lwqa3i-igloo-probe-fod.drv'
const probe = '/nix/store/26bh7ql0g4x5nn84fs19x56c434b336l-igloo-probe.drv'
const tarball = '/nix/store/wj7phsmi7ncidl8k00p489krqss7n9sd-hello-2.12.3.tar.gz'

describe('BuildPlan.toBuild', () => {
  it('takes the derivations to build and leaves the paths to fetch', () => {
    const dryRun = [
      'these 2 derivations will be built:',
      `  ${fod}`,
      `  ${probe}`,
      'this path will be fetched (0.0 KiB download, 1.1 MiB unpacked):',
      `  ${tarball}`,
    ].join('\n')

    assert.deepStrictEqual(BuildPlan.toBuild(dryRun), [fod, probe])
  })

  it('reads a single derivation, and a fetch heading for several paths', () => {
    const dryRun = [
      'these 3 paths will be fetched (12.5 MiB download, 60.1 MiB unpacked):',
      '  /nix/store/0cxhcw4jh3y2n42sp4pyjk1faabdd5y5-top',
      '  /nix/store/sbpcwb0mmk2nkhp7ddw5gn8275bay7ps-plain',
      `  ${tarball}`,
      'this derivation will be built:',
      `  ${probe}`,
      '',
    ].join('\n')

    assert.deepStrictEqual(BuildPlan.toBuild(dryRun), [probe])
  })

  it('finds nothing to build in an empty plan', () => {
    assert.deepStrictEqual(BuildPlan.toBuild(''), [])
  })

  it('takes a derivation listed under a heading it does not know', () => {
    assert.deepStrictEqual(BuildPlan.toBuild(`these derivations are to be realised:\n\t${fod}\n`), [
      fod,
    ])
  })

  it('takes no derivation that is only mentioned in a message', () => {
    assert.deepStrictEqual(BuildPlan.toBuild(`error: path '${fod}' is not valid`), [])
  })
})

/** Trimmed from `nix derivation show` on Nix 2.34. */
const derivations = {
  // `pkgs.hello.src`: nixpkgs' `fetchurl`, which sets `__structuredAttrs`.
  'xvp6kdxf01harcy37nhfwb82n6d95ydf-hello-2.12.3.tar.gz.drv': {
    env: { out: tarball },
    name: 'hello-2.12.3.tar.gz',
    outputs: {
      out: { hash: 'sha256-DV9gFUOC/uELEUocNOeF2LH0kgc64tOm97FHaHs2aqA=', method: 'flat' },
    },
    structuredAttrs: {
      outputHash: 'sha256-DV9gFUOC/uELEUocNOeF2LH0kgc64tOm97FHaHs2aqA=',
      outputHashMode: 'flat',
      urls: ['mirror://gnu/hello/hello-2.12.3.tar.gz'],
    },
    version: 4,
  },
  // A `derivation` with `outputHash` and no structured attributes.
  '8kknbnsz99b477kskjs7sn76q9lwqa3i-igloo-probe-fod.drv': {
    env: {
      out: '/nix/store/6x9w5wmwg50ya73rh4is3g2x255h2i2r-igloo-probe-fod',
      outputHash: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      outputHashAlgo: 'sha256',
      outputHashMode: 'flat',
    },
    name: 'igloo-probe-fod',
    outputs: {
      out: { hash: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', method: 'flat' },
    },
    version: 4,
  },
  // `__impure = true`, which nix moves out of `env` and onto the outputs.
  'h3nicn2b4n2ch6c9gz2zhh1z83cyin0y-impure.drv': {
    env: { out: '/1rz4g4znpzjwh1xymhjpm42vipw92pr73vdgl6xs1hycac8kf2n9' },
    name: 'impure',
    outputs: { out: { hashAlgo: 'sha256', impure: true, method: 'nar' } },
    version: 4,
  },
  'qz3aa5vj5g4zgphdgxybkbh2jzpckqra-nochroot.drv': {
    env: { __noChroot: '1', out: '/nix/store/ys566hsbmi0dh312hj51334h09m2ww2k-nochroot' },
    name: 'nochroot',
    outputs: { out: { path: 'ys566hsbmi0dh312hj51334h09m2ww2k-nochroot' } },
    version: 4,
  },
  // A fixed output that also asks to leave the sandbox, under structured attributes.
  '2aapbhbbffr9qv16rqvibzk9whd5abqi-structured.drv': {
    env: { out: '/nix/store/q4ic05ffk8qliiyxbd5wikqcc6350lf2-structured' },
    name: 'structured',
    outputs: {
      out: { hash: 'sha256-4bKfDmWSBqHzN/4vdnDq7GbpbfvlwqBqaHfIDyxP5Z0=', method: 'nar' },
    },
    structuredAttrs: { __noChroot: true, outputHashMode: 'recursive' },
    version: 4,
  },
  // A floating content-addressed output, which builds in the sandbox.
  '51cknhkavps0daz4vwggkbs6bffsikp6-ca.drv': {
    env: {
      out: '/1rz4g4znpzjwh1xymhjpm42vipw92pr73vdgl6xs1hycac8kf2n9',
      outputHashAlgo: 'sha256',
      outputHashMode: 'recursive',
    },
    name: 'ca',
    outputs: { out: { hashAlgo: 'sha256', method: 'nar' } },
    version: 4,
  },
  // `__noChroot = false` reaches `env` as an empty string.
  'hqi7n9vprkr0piv5090539wi7nw4mynx-plain.drv': {
    env: { __noChroot: '', out: '/nix/store/sbpcwb0mmk2nkhp7ddw5gn8275bay7ps-plain' },
    inputs: { drvs: {}, srcs: [] },
    name: 'plain',
    outputs: { out: { path: 'sbpcwb0mmk2nkhp7ddw5gn8275bay7ps-plain' } },
    version: 4,
  },
}

describe('BuildPlan.refused', () => {
  it.effect('refuses fixed outputs, impure derivations and __noChroot, and nothing else', () =>
    Effect.gen(function* () {
      const refused = yield* BuildPlan.refused(yield* json({ derivations, version: 4 }))

      assert.deepStrictEqual(refused, [
        {
          drvPath: '/nix/store/xvp6kdxf01harcy37nhfwb82n6d95ydf-hello-2.12.3.tar.gz.drv',
          reasons: ['fixed-output'],
        },
        { drvPath: fod, reasons: ['fixed-output'] },
        { drvPath: '/nix/store/h3nicn2b4n2ch6c9gz2zhh1z83cyin0y-impure.drv', reasons: ['impure'] },
        {
          drvPath: '/nix/store/qz3aa5vj5g4zgphdgxybkbh2jzpckqra-nochroot.drv',
          reasons: ['no-chroot'],
        },
        {
          drvPath: '/nix/store/2aapbhbbffr9qv16rqvibzk9whd5abqi-structured.drv',
          reasons: ['fixed-output', 'no-chroot'],
        },
      ])
    }),
  )

  it.effect('refuses nothing when nothing is to be built', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* BuildPlan.refused('{"derivations":{},"version":4}'), [])
    }),
  )

  it.effect('fails on any other format, rather than reading a moved field as absent', () =>
    Effect.gen(function* () {
      // Nix before format version 4: keyed by full path, with no wrapper.
      const unwrapped = yield* json({
        [fod]: { env: {}, outputs: { out: { hash: 'sha256-AAAA', path: '/nix/store/x' } } },
      })
      for (const shown of [
        unwrapped,
        yield* json({ derivations, version: 5 }),
        yield* json({ derivations: { [fod]: { outputs: {} } }, version: 4 }),
        'not json',
      ]) {
        const error = yield* Effect.flip(BuildPlan.refused(shown))
        assert.instanceOf(error, BuildPlan.BuildPlanError)
      }
    }),
  )
})

describe('BuildPlan.describe', () => {
  it('names each derivation and why, and gives one command that builds them', () => {
    const message = BuildPlan.describe([
      { drvPath: fod, reasons: ['fixed-output'] },
      { drvPath: probe, reasons: ['fixed-output', 'no-chroot'] },
    ])

    assert.include(message, '2 derivations')
    assert.include(message, `  ${fod}: a fixed output, whose builder has the network\n`)
    assert.include(message, `  ${probe}: a fixed output, whose builder has the network; __noChroot`)
    assert.include(message, `  nix build --no-link \\\n    '${fod}^*' \\\n    '${probe}^*'`)
    assert.notInclude(message, 'impure')
  })

  it('leaves an impure derivation out of the command, and says to remove it', () => {
    const impure = '/nix/store/h3nicn2b4n2ch6c9gz2zhh1z83cyin0y-impure.drv'
    const message = BuildPlan.describe([
      { drvPath: impure, reasons: ['impure'] },
      { drvPath: fod, reasons: ['fixed-output'] },
    ])

    assert.include(message, `  ${impure}: impure`)
    assert.include(message, `  nix build --no-link \\\n    '${fod}^*'`)
    assert.notInclude(message, `'${impure}^*'`)
    assert.include(message, 'has to be removed')
  })

  it('gives no command when nothing can be built ahead', () => {
    const message = BuildPlan.describe([{ drvPath: fod, reasons: ['impure'] }])

    assert.include(message, 'a derivation built')
    assert.notInclude(message, 'nix build')
  })
})

describe('BuildPlan.describe, for one derivation', () => {
  it('speaks of it in the singular', () => {
    const message = BuildPlan.describe([{ drvPath: fod, reasons: ['fixed-output'] }])

    assert.include(message, 'needs a derivation built')
    assert.include(message, 'Any layer may have added it,')
    assert.include(message, 'Review it with')
    assert.include(message, 'If you trust it, build it yourself')
  })
})
