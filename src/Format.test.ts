import { assert, describe, it } from '@effect/vitest'
import { Cause } from 'effect'
import { CliError } from 'effect/unstable/cli'

import * as Format from './Format.ts'
import { VmError } from './Vm.ts'

describe('Format.bytes', () => {
  it('scales to binary units', () => {
    assert.strictEqual(Format.bytes(512), '512B')
    assert.strictEqual(Format.bytes(31 * 1024 * 1024), '31M')
    assert.strictEqual(Format.bytes(2 * 1024 * 1024 * 1024), '2.0G')
  })

  it('keeps one decimal only below 10', () => {
    // 3.4G against 3.9G is worth a character; 3400M against 3401M is not.
    assert.strictEqual(Format.bytes(3_650_722_201), '3.4G')
    assert.strictEqual(Format.bytes(15_032_385_536), '14G')
  })

  it('renders an unreported figure as missing rather than as zero', () => {
    assert.strictEqual(Format.bytes(undefined), '-')
    assert.strictEqual(Format.bytes(0), '0B')
  })
})

describe('Format.broker', () => {
  it('says a running broker is up, and how often it has been started again', () => {
    assert.strictEqual(Format.broker(undefined), '-')
    assert.strictEqual(Format.broker({ oomKills: 0, restarts: 0, state: 'running' }), 'up')
    assert.strictEqual(
      Format.broker({ oomKills: 0, restarts: 2, state: 'running' }),
      'up, restarted 2×',
    )
  })

  it('says when memory is why', () => {
    assert.strictEqual(
      Format.broker({ oomKills: 1, restarts: 1, state: 'running' }),
      'up, restarted 1×, 1 killed for memory',
    )
    assert.strictEqual(
      Format.broker({ oomKills: 6, restarts: 0, state: 'stopped' }),
      'stopped, 6 killed for memory',
    )
    assert.strictEqual(
      Format.broker({ oomKills: 0, restarts: 0, state: 'restarting' }),
      'restarting',
    )
  })
})

describe('Format.duration', () => {
  it('drops to seconds only under a minute', () => {
    assert.strictEqual(Format.duration(4_000), '4s')
    assert.strictEqual(Format.duration(59_999), '59s')
    assert.strictEqual(Format.duration(60_000), '1m')
  })

  it('carries two terms once past an hour', () => {
    assert.strictEqual(Format.duration(18 * 60_000), '18m')
    assert.strictEqual(Format.duration(3 * 3_600_000 + 7 * 60_000), '3h 7m')
    assert.strictEqual(Format.duration(6 * 86_400_000 + 2 * 3_600_000), '6d 2h')
  })

  it('does not render a clock skew as a negative age', () => {
    assert.strictEqual(Format.duration(-5_000), '0s')
    assert.strictEqual(Format.duration(undefined), '-')
  })
})

describe('Format.table', () => {
  it('pads every column but the last to its widest cell', () => {
    const out = Format.table(
      ['NAME', 'STATUS'],
      [
        ['a', 'running'],
        ['longer-name', 'broken'],
      ],
    )
    assert.deepStrictEqual(out.split('\n'), [
      'NAME         STATUS',
      'a            running',
      'longer-name  broken',
    ])
  })

  it('sizes a column by its header when every cell is shorter', () => {
    const out = Format.table(['MEMORY'], [['2G']])
    assert.deepStrictEqual(out.split('\n'), ['MEMORY', '2G'])
  })
})

describe('Format.failure', () => {
  it('prints the message as one line, with no stack', () => {
    const out = Format.failure(Cause.fail(new VmError({ message: 'nix build exited 1' })))
    assert.strictEqual(out, 'igloo: nix build exited 1\n')
  })

  it('names the boot record on a line of its own', () => {
    const error = new VmError({ bootRecord: '/p/.igloo/logs/b1', message: 'nix build exited 1' })
    assert.strictEqual(
      Format.failure(Cause.fail(error)),
      'igloo: nix build exited 1\nigloo: the boot record is /p/.igloo/logs/b1\n',
    )
  })

  it('prints nothing for an interruption', () => {
    assert.isUndefined(Format.failure(Cause.interrupt()))
  })

  it('prints nothing for an error the CLI has already rendered', () => {
    // A usage error: the help text and the error are on the terminal already.
    const help = new CliError.ShowHelp({ commandPath: ['igloo'], errors: [] })
    assert.isUndefined(Format.failure(Cause.fail(help)))
  })

  it('keeps the whole report for a defect, which is a bug rather than a failure', () => {
    const out = Format.failure(Cause.die(new Error('unreachable')))
    assert.isDefined(out)
    assert.isTrue(out?.startsWith('igloo: internal error\n'))
    assert.include(out, 'unreachable')
  })
})
