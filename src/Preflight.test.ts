import { BunServices } from '@effect/platform-bun'
import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'

import * as Binaries from './Binaries.ts'
import * as Preflight from './Preflight.ts'

const passed = (name: string): Preflight.Check => ({
  name,
  outcome: { _tag: 'Ok', detail: 'fine' },
})

const broke = (name: string): Preflight.Check => ({
  name,
  outcome: { _tag: 'Failed', detail: 'not fine', remedy: 'do the thing' },
})

describe('Preflight.report', () => {
  it('aligns the detail column on the longest name', () => {
    const lines = Preflight.report([passed('nix'), passed('/dev/vhost-vsock')]).split('\n')
    const at = (line: string): number => line.indexOf('fine')
    assert.strictEqual(at(lines[0] ?? ''), at(lines[1] ?? ''))
  })

  it('puts a failure’s remedy on its own line', () => {
    const lines = Preflight.report([broke('bubblewrap')]).split('\n')
    assert.include(lines[0] ?? '', 'FAIL')
    assert.include(lines[1] ?? '', '→ do the thing')
  })

  it('summarises how many failed', () => {
    assert.include(Preflight.report([passed('a'), passed('b')]), 'All 2 checks passed.')
    assert.include(Preflight.report([passed('a'), broke('b')]), '1 of 2 checks failed.')
  })

  // `Math.max()` of nothing is -Infinity, which `padEnd` would reject.
  it('survives an empty list', () => {
    assert.include(Preflight.report([]), 'All 0 checks passed.')
  })
})

describe('Preflight.rootBindArgs', () => {
  const entries = ['bin', 'dev', 'etc', 'home', 'mnt', 'nix', 'proc', 'tmp']

  it('binds every top-level directory when there is no autofs', () => {
    const args = Preflight.rootBindArgs(entries, '34 1 0:30 / / rw - tmpfs rootfs rw\n')
    assert.strictEqual(args.length, entries.length * 3)
    assert.deepStrictEqual(args.slice(0, 3), ['--dev-bind', '/bin', '/bin'])
    assert.isTrue(args.includes('/mnt'))
  })

  it('skips the top-level directory holding an autofs mount', () => {
    const mountinfo = [
      '34 1 0:30 / / rw - tmpfs rootfs rw',
      '90 34 0:55 / /mnt/backup rw,relatime shared:1 - autofs systemd-1 rw,fd=179',
      '',
    ].join('\n')
    const args = Preflight.rootBindArgs(entries, mountinfo)
    assert.isFalse(args.includes('/mnt'))
    assert.strictEqual(args.length, (entries.length - 1) * 3)
    assert.isTrue(args.includes('/nix'))
  })

  it('matches on the filesystem type, not on the mount point text', () => {
    // A directory merely named "autofs" is not one.
    const mountinfo = '90 34 0:55 / /mnt/autofs rw - ext4 /dev/sda1 rw\n'
    assert.isTrue(Preflight.rootBindArgs(entries, mountinfo).includes('/mnt'))
  })
})

describe('Preflight.systemdRelease', () => {
  it('reads the release from systemd-run and from the user manager', () => {
    assert.strictEqual(Preflight.systemdRelease('systemd 261 (261.3)'), 261)
    assert.strictEqual(Preflight.systemdRelease('261.3\n'), 261)
  })

  it('reads past a distribution’s suffix', () => {
    assert.strictEqual(Preflight.systemdRelease('259.5-0ubuntu3.4'), 259)
    assert.strictEqual(Preflight.systemdRelease('systemd 255 (255.4-1ubuntu8.4)'), 255)
  })

  it('finds none in nothing, or in something else', () => {
    assert.isUndefined(Preflight.systemdRelease(''))
    assert.isUndefined(Preflight.systemdRelease('Failed to connect to bus'))
  })
})

describe('Preflight.systemdRunOutcome', () => {
  it('passes the minimum and fails below it, with an upgrade', () => {
    assert.strictEqual(Preflight.systemdRunOutcome('systemd-run', 257)._tag, 'Ok')
    const old = Preflight.systemdRunOutcome('systemd-run', 256)
    assert.strictEqual(old._tag, 'Failed')
    if (old._tag === 'Failed') {
      assert.include(old.detail, 'PrivatePIDs=')
      assert.include(old.remedy, 'Upgrade systemd to 257')
    }
  })

  it('fails a systemd-run that gives no version', () => {
    assert.strictEqual(Preflight.systemdRunOutcome('/nonexistent', undefined)._tag, 'Failed')
  })
})

describe('Preflight.userManagerOutcome', () => {
  const remedy = (outcome: Preflight.Outcome): string =>
    outcome._tag === 'Failed' ? outcome.remedy : ''

  it('passes the minimum', () => {
    assert.strictEqual(Preflight.userManagerOutcome(257, 257)._tag, 'Ok')
  })

  // The host upgraded systemd and the manager still runs the old one, so the
  // fix is a restart, not an upgrade.
  it('sends a manager older than its systemd-run to a restart', () => {
    const behind = remedy(Preflight.userManagerOutcome(256, 257))
    assert.include(behind, 'systemctl --user daemon-reexec')
    assert.notInclude(behind, 'Upgrade')
  })

  it('sends a manager as old as its systemd-run to an upgrade, then a restart', () => {
    const old = remedy(Preflight.userManagerOutcome(256, 256))
    assert.include(old, 'Upgrade systemd to 257')
    assert.include(old, 'systemctl --user daemon-reexec')
  })

  it('fails a manager that does not answer', () => {
    assert.include(remedy(Preflight.userManagerOutcome(undefined, 257)), 'user session')
  })
})

describe('Preflight.failures', () => {
  it('counts only the failures', () => {
    assert.strictEqual(Preflight.failures([passed('a'), broke('b'), broke('c')]), 2)
  })
})

/**
 * Against the real host, with every binary pointed at something that cannot
 * work. The point is not which checks pass here — that varies by machine — but
 * that every check runs, reports, and none of them throws or hangs.
 */
describe('Preflight.run', () => {
  it.live(
    'reports on every prerequisite rather than stopping at the first failure',
    () =>
      Effect.gen(function* () {
        const bins: Binaries.Binaries = {
          ...Binaries.fromEnv({}),
          bwrap: '/nonexistent/bwrap',
          landlock: '/nonexistent/igloo-landlock',
          loginctl: '/nonexistent/loginctl',
          nix: '/nonexistent/nix',
          sshProxy: '/nonexistent/systemd-ssh-proxy',
          storeView: '/nonexistent/igloo-store-view',
        }
        const checks = yield* Preflight.run(bins, {
          iglooFlake: '/nonexistent/igloo',
          runtimeDir: undefined,
          user: 'nobody',
          userLayer: '/nonexistent/igloo-user-layer',
        })

        const named = new Set(checks.map(check => check.name))
        for (const name of [
          'igloo flake',
          'user layer',
          'nix',
          'store view',
          'landlock',
          'bubblewrap',
          'ssh vsock proxy',
          'XDG_RUNTIME_DIR',
        ]) {
          assert.isTrue(named.has(name), `missing check: ${name}`)
        }
        // The ones forced to fail above, so this asserts a verdict rather than
        // whatever the host happens to be.
        for (const name of [
          'igloo flake',
          'user layer',
          'nix',
          'store view',
          'landlock',
          'bubblewrap',
          'ssh vsock proxy',
          'XDG_RUNTIME_DIR',
        ]) {
          const check = checks.find(c => c.name === name)
          assert.strictEqual(check?.outcome._tag, 'Failed', `${name} should have failed`)
        }
        // A failure without a remedy is the failure mode this feature exists to
        // avoid, so it is checked rather than trusted.
        for (const check of checks) {
          if (check.outcome._tag === 'Failed') {
            assert.isNotEmpty(check.outcome.remedy, `${check.name} has no remedy`)
          }
        }
      }).pipe(Effect.provide(BunServices.layer)),
    20_000,
  )

  it.live(
    'counts no user layer as a choice rather than a fault',
    () =>
      Effect.gen(function* () {
        const checks = yield* Preflight.run(Binaries.fromEnv({}), {
          iglooFlake: '/nonexistent/igloo',
          runtimeDir: undefined,
          user: 'nobody',
          userLayer: undefined,
        })

        const check = checks.find(c => c.name === 'user layer')
        assert.strictEqual(check?.outcome._tag, 'Ok')
      }).pipe(Effect.provide(BunServices.layer)),
    20_000,
  )
})
