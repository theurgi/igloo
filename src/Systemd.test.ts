import { BunServices } from '@effect/platform-bun'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { homedir } from 'node:os'
import { basename, dirname } from 'node:path'

import * as Systemd from './Systemd.ts'

const programs = { systemctl: 'systemctl', systemdRun: 'systemd-run' }

const unit = (name: string): Systemd.Unit => ({
  argv: ['/bin/sh', '-c', 'sleep 300'],
  name,
  slice: 'igloo-test-systemd',
  workingDirectory: '/tmp',
})

describe('Systemd.escapeSliceComponent', () => {
  it('keeps a hyphenated name from becoming a child of a shorter one', () => {
    // Unescaped, `igloo-foo-bar.slice` nests under `igloo-foo.slice`, so
    // stopping the VM named `foo` would stop the VM named `foo-bar` too.
    assert.strictEqual(Systemd.escapeSliceComponent('foo-bar'), 'foo\\x2dbar')
  })

  it('leaves a name with no hyphen alone', () => {
    assert.strictEqual(Systemd.escapeSliceComponent('foo'), 'foo')
  })

  it('round-trips through unescapeSliceComponent', () => {
    // `list` recovers a VM's name from its slice, so the inverse has to hold or
    // a hyphenated VM is listed under a name `down` cannot then find.
    for (const name of ['foo', 'foo-bar', 'a-b-c']) {
      assert.strictEqual(Systemd.unescapeSliceComponent(Systemd.escapeSliceComponent(name)), name)
    }
  })
})

describe('Systemd.startArgs', () => {
  it('places the unit in its slice and forces the kill signal', () => {
    const args = Systemd.startArgs(unit('igloo-example'))
    assert.isTrue(args.includes('--user'))
    assert.isTrue(args.includes('--unit=igloo-example'))
    assert.isTrue(args.includes('--slice=igloo-test-systemd.slice'))
    assert.isTrue(args.includes('--collect'))
    assert.isTrue(args.includes('--property=KillSignal=SIGKILL'))
    assert.isTrue(args.includes('--working-directory=/tmp'))
  })

  it('separates systemd-run options from the command with --', () => {
    const args = Systemd.startArgs(unit('igloo-example'))
    const sep = args.indexOf('--')
    assert.notStrictEqual(sep, -1)
    assert.deepStrictEqual(args.slice(sep + 1), ['/bin/sh', '-c', 'sleep 300'])
  })

  it('passes the environment through explicitly', () => {
    // A transient unit inherits the user manager's environment, not the
    // caller's, so anything omitted here is simply absent in the unit.
    const args = Systemd.startArgs({ ...unit('igloo-example'), env: { PATH: '/a:/b' } })
    assert.isTrue(args.includes('--setenv=PATH=/a:/b'))
  })

  it('unsets each name the user manager holds but those the unit sets', () => {
    // In order: systemd stores a name in place of one it begins that it already
    // holds, so `JAVA_HOME` after `JAVA_HOME_11_X64` would unset `JAVA_HOME` alone.
    const args = Systemd.startArgs({ ...unit('igloo-example'), env: { PATH: '/a:/b' } }, [
      'JAVA_HOME_11_X64',
      'PATH',
      'JAVA_HOME',
      'HOME',
    ])
    assert.include(args, '--property=UnsetEnvironment=HOME JAVA_HOME JAVA_HOME_11_X64')
    assert.include(args, '--setenv=PATH=/a:/b')
    const none = Systemd.startArgs({ ...unit('igloo-example'), env: { PATH: '/a:/b' } }, ['PATH'])
    assert.isFalse(none.some(arg => arg.startsWith('--property=UnsetEnvironment')))
  })

  it('sets the description only when one is given', () => {
    assert.isFalse(
      Systemd.startArgs(unit('igloo-example')).some(a => a.startsWith('--description')),
    )
    const args = Systemd.startArgs({ ...unit('igloo-example'), description: '/ws/demo' })
    assert.isTrue(args.includes('--description=/ws/demo'))
  })

  it('sends both output streams to the log file when one is given', () => {
    const args = Systemd.startArgs({ ...unit('igloo-example'), logFile: '/tmp/x.log' })
    assert.isTrue(args.includes('--property=StandardOutput=append:/tmp/x.log'))
    assert.isTrue(args.includes('--property=StandardError=append:/tmp/x.log'))
  })

  it('orders a bound unit after what it is bound to', () => {
    // `BindsTo=` without `After=` constrains stopping but not starting, so the
    // two would race and this one could come up against a guest that is not
    // there yet.
    const args = Systemd.startArgs({ ...unit('igloo-example'), boundTo: ['igloo-x-qemu.service'] })
    assert.isTrue(args.includes('--property=BindsTo=igloo-x-qemu.service'))
    assert.isTrue(args.includes('--property=After=igloo-x-qemu.service'))
  })

  it('never emits a restart policy without a start limit', () => {
    const plain = Systemd.startArgs(unit('igloo-example'))
    assert.isFalse(plain.some(a => a.startsWith('--property=Restart=')))

    const args = Systemd.startArgs({
      ...unit('igloo-example'),
      restart: { burst: 3, delaySec: 2, intervalSec: 60 },
    })
    assert.isTrue(args.includes('--property=Restart=always'))
    assert.isTrue(args.includes('--property=RestartSec=2'))
    // Unbounded, a permanent failure restarts forever and a caller waiting on
    // the unit waits out its whole budget rather than failing on a known cause.
    assert.isTrue(args.includes('--property=StartLimitBurst=3'))
    assert.isTrue(args.includes('--property=StartLimitIntervalSec=60'))
  })

  it('keeps a confined path whole, spaces and colons included', () => {
    // Unquoted, systemd reads `/run/a b` as two paths and a `:` as the start of
    // a bind's destination, and refuses the unit — so a project whose
    // directory name has either could not start a VM.
    const args = Systemd.startArgs({
      ...unit('igloo-example'),
      confine: {
        kind: 'hypervisor',
        devices: ['/dev/kvm'],
        hidden: ['/run/a b:c/h'],
        writable: ['/run/a b:c'],
      },
    })
    assert.include(args, '--property=BindPaths="/run/a b:c"')
    assert.include(args, '--property=InaccessiblePaths="-/run/a b:c/h"')
    assert.include(args, '--property=BindPaths="-/dev/kvm"')
  })

  it('bounds a credential holder’s memory and swap only when told to, and has it killed first', () => {
    const credentials = (memoryMax?: string) =>
      Systemd.startArgs({
        ...unit('igloo-example'),
        confine: { kind: 'credentials', memoryMax, writable: ['/run/w'] },
      })
    assert.notInclude(credentials().join(' '), 'MemoryMax')
    assert.notInclude(credentials().join(' '), 'MemorySwapMax')
    assert.include(credentials('512M'), '--property=MemoryMax=512M')
    assert.include(credentials('512M'), '--property=MemorySwapMax=0')
    for (const args of [credentials(), credentials('512M')]) {
      assert.include(args, '--property=OOMScoreAdjust=1000')
      for (const bound of ['CPUQuota', 'TasksMax', 'LimitNOFILE']) {
        assert.notInclude(args.join(' '), bound)
      }
    }
  })

  it("gives a credential holder an empty root, the resolver's files and its paths", () => {
    const args = Systemd.startArgs({
      ...unit('igloo-example'),
      confine: { kind: 'credentials', readable: ['/run/r'], writable: ['/run/w'] },
    })
    assert.include(args, '--property=TemporaryFileSystem=/:ro')
    assert.include(args, '--property=BindReadOnlyPaths=/nix/store')
    assert.include(
      args,
      '--property=BindReadOnlyPaths="-/etc/nsswitch.conf" "-/etc/host.conf" "-/etc/hosts" "-/etc/resolv.conf" "-/etc/gai.conf"',
    )
    assert.include(args, '--property=BindReadOnlyPaths="/run/r"')
    assert.include(args, '--property=BindPaths="/run/w"')
  })

  it('gives a forwarder an empty root and its paths read-only', () => {
    const args = Systemd.startArgs({
      ...unit('igloo-example'),
      confine: { kind: 'forwarder', hostNetwork: false, readable: ['/run/a b:c', '/etc/passwd'] },
    })
    assert.include(args, '--property=TemporaryFileSystem=/:ro')
    assert.include(args, '--property=BindReadOnlyPaths=/nix/store')
    assert.include(args, '--property=BindReadOnlyPaths="/run/a b:c"')
    assert.include(args, '--property=BindReadOnlyPaths="/etc/passwd"')
    assert.isFalse(args.some(arg => arg.startsWith('--property=BindPaths=')))
    assert.include(args, '--property=MemoryDenyWriteExecute=yes')
    assert.include(args, '--property=PrivateUsers=self')
  })

  it("keeps a forwarder off IP unless it keeps the host's network", () => {
    const own = Systemd.startArgs({
      ...unit('igloo-example'),
      confine: { kind: 'forwarder', hostNetwork: false, readable: [] },
    })
    assert.include(own, '--property=PrivateNetwork=yes')
    assert.include(own, '--property=RestrictAddressFamilies=AF_UNIX AF_VSOCK')

    // A forward that listens on the host's loopback needs the host's network
    // and IPv4 on it, and still nothing else.
    const host = Systemd.startArgs({
      ...unit('igloo-example'),
      confine: { kind: 'forwarder', hostNetwork: true, readable: [] },
    })
    assert.notInclude(host, '--property=PrivateNetwork=yes')
    assert.include(host, '--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_VSOCK')
  })
})

/**
 * A tool by a path inside the store, which is all a hypervisor-confined unit
 * can run. Resolved through its directory rather than to the file itself: a
 * multi-call binary such as coreutils tells which tool to be by the name it was
 * run as.
 */
const fromStore = Effect.fnUntraced(function* (name: string) {
  const fs = yield* FileSystem.FileSystem
  const found = Bun.which(name)
  const path = found === null ? '' : `${yield* fs.realPath(dirname(found))}/${name}`
  if (!path.startsWith('/nix/store/')) return yield* Effect.die(`${name} is not in the store`)
  return path
})

// These run against the real user manager. They are the only check that the
// property set systemd-run is handed is one systemd actually accepts — an
// arg-shape test cannot catch a rejected property, since systemd-run fails at
// runtime rather than at construction.
describe('Systemd against the user manager', () => {
  const slice = 'igloo-selftest'
  const name = 'igloo-selftest-sleep'

  const cleanup = Effect.addFinalizer(() => Systemd.stopSlice('systemctl', slice))

  it.live('starts a unit, reports it active, and captures its output', () =>
    Effect.gen(function* () {
      yield* cleanup
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const log = `${dir}/out.log`

      yield* Systemd.start(programs, {
        argv: ['/bin/sh', '-c', 'pwd; sleep 300'],
        env: { PATH: process.env['PATH'] ?? '' },
        logFile: log,
        name,
        slice,
        workingDirectory: dir,
      })
      assert.isTrue(yield* Systemd.isActive('systemctl', name))

      yield* Effect.sleep('500 millis')
      const out = yield* fs.readFileString(log)
      // Proves --working-directory took effect, not just that the unit ran.
      assert.strictEqual(out.trim(), yield* fs.realPath(dir))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.live('starts a unit with none of the user manager’s environment but what it sets', () =>
    Effect.gen(function* () {
      yield* cleanup
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const names = (text: string, separator: string) =>
        new Set(
          text
            .split(separator)
            .filter(entry => entry.includes('='))
            .map(entry => entry.slice(0, entry.indexOf('='))),
        )
      const manager = names(
        yield* spawner.string(
          ChildProcess.make('systemctl', ['--user', 'show-environment'], { extendEnv: true }),
        ),
        '\n',
      )
      manager.delete('PATH')
      assert.isAbove(manager.size, 0, 'the user manager holds nothing a unit could inherit')

      yield* Systemd.start(programs, {
        argv: ['/bin/sh', '-c', 'sleep 300'],
        env: { PATH: process.env['PATH'] ?? '' },
        name,
        slice,
        workingDirectory: '/tmp',
      })
      yield* Effect.sleep('500 millis')
      const pid = (yield* Systemd.show('systemctl', name, ['MainPID'])).get('MainPID') ?? ''
      const held = names(yield* fs.readFileString(`/proc/${pid}/environ`), '\0')
      assert.deepStrictEqual(
        [...held].filter(entry => manager.has(entry)),
        [],
      )
      assert.isTrue(held.has('PATH'))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.live('stopping the slice kills a member that ignores SIGTERM', () =>
    Effect.gen(function* () {
      yield* cleanup
      // The teardown property the whole design rests on: systemd kills the
      // cgroup, so a process that traps SIGTERM has no say in it.
      yield* Systemd.start(programs, {
        argv: ['/bin/sh', '-c', 'trap "" TERM; sleep 300'],
        env: { PATH: process.env['PATH'] ?? '' },
        name,
        slice,
        workingDirectory: '/tmp',
      })
      assert.isTrue(yield* Systemd.isActive('systemctl', name))

      yield* Systemd.stopSlice('systemctl', slice)
      assert.isTrue(yield* Systemd.awaitInactive('systemctl', name, '5 seconds'))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.live('reports a unit that was never started as inactive', () =>
    Effect.gen(function* () {
      assert.isFalse(yield* Systemd.isActive('systemctl', 'igloo-selftest-absent'))
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.live('carries a description through to a running unit, spaces and all', () =>
    Effect.gen(function* () {
      yield* cleanup
      // The one place a caller's own string can be attached to a transient unit,
      // and the only reason `list` can name a workspace at all.
      const description = '/home/someone/my projects/demo/workspace'
      yield* Systemd.start(programs, {
        argv: ['/bin/sh', '-c', 'sleep 300'],
        description,
        env: { PATH: process.env['PATH'] ?? '' },
        name,
        slice,
        workingDirectory: '/tmp',
      })

      const properties = yield* Systemd.show('systemctl', name, ['ActiveState', 'Description'])
      assert.strictEqual(properties.get('Description'), description)
      assert.strictEqual(properties.get('ActiveState'), 'active')
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.live('fills an absent description with the command line', () =>
    Effect.gen(function* () {
      yield* cleanup
      yield* Systemd.start(programs, {
        argv: ['/bin/sh', '-c', 'sleep 300'],
        env: { PATH: process.env['PATH'] ?? '' },
        name,
        slice,
        workingDirectory: '/tmp',
      })
      // There is no value that means "nothing was recorded", which is why a
      // reader has to recognise its own descriptions rather than the absence of
      // one. A loaded unit behaves differently here from one that never ran,
      // whose description does default to the unit name.
      assert.strictEqual(
        (yield* Systemd.show('systemctl', name, ['Description'])).get('Description'),
        '[systemd-run] /bin/sh -c "sleep 300"',
      )
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.live('a start limit makes a permanent failure terminal', () =>
    Effect.gen(function* () {
      yield* cleanup
      // systemd-run fails at runtime rather than at construction, so this is
      // the only check that `StartLimitBurst`/`StartLimitIntervalSec` are
      // properties systemd accepts on a transient unit at all.
      yield* Systemd.start(programs, {
        argv: ['/bin/sh', '-c', 'exit 1'],
        env: { PATH: process.env['PATH'] ?? '' },
        name,
        restart: { burst: 2, delaySec: 1, intervalSec: 30 },
        slice,
        workingDirectory: '/tmp',
      })
      // Unbounded this would restart forever and the wait would time out, which
      // is the failure mode the limit exists to prevent.
      assert.isTrue(yield* Systemd.awaitInactive('systemctl', name, '20 seconds'))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.live('a bound unit stops when what it is bound to goes away', () =>
    Effect.gen(function* () {
      yield* cleanup
      const anchor = 'igloo-selftest-anchor.service'
      const bound = 'igloo-selftest-bound.service'

      yield* Systemd.start(programs, {
        argv: ['/bin/sh', '-c', 'sleep 2'],
        env: { PATH: process.env['PATH'] ?? '' },
        name: anchor,
        slice,
        workingDirectory: '/tmp',
      })
      yield* Systemd.start(programs, {
        argv: ['/bin/sh', '-c', 'sleep 300'],
        boundTo: [anchor],
        env: { PATH: process.env['PATH'] ?? '' },
        name: bound,
        slice,
        workingDirectory: '/tmp',
      })
      assert.isTrue(yield* Systemd.isActive('systemctl', bound))

      // The anchor stands in for QEMU: when the guest goes, anything attached
      // to it has nothing left to attach to and must not survive.
      assert.isTrue(yield* Systemd.awaitInactive('systemctl', anchor, '10 seconds'))
      assert.isTrue(yield* Systemd.awaitInactive('systemctl', bound, '10 seconds'))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.live('confines a unit and hands it a credential by path, not by value', () =>
    Effect.gen(function* () {
      yield* cleanup
      const fs = yield* FileSystem.FileSystem
      const bash = yield* fromStore('bash')
      const coreutils = dirname(yield* fromStore('cp'))
      // Under /run/user, as the broker's own directories are.
      const dir = `${process.env['XDG_RUNTIME_DIR'] ?? '/run/user/0'}/igloo-selftest-confine`
      yield* Effect.addFinalizer(() => fs.remove(dir, { recursive: true }).pipe(Effect.ignore))
      yield* fs.remove(dir, { recursive: true }).pipe(Effect.ignore)
      yield* fs.makeDirectory(dir, { recursive: true })
      const source = `${dir}/source`
      const writable = `${dir}/writable`
      const readable = `${dir}/readable`
      // A file of the user's, so the home directory has something to hide.
      const inHome = `${homedir()}/.igloo-selftest-confine-${String(process.pid)}`
      yield* Effect.addFinalizer(() => fs.remove(inHome).pipe(Effect.ignore))
      yield* fs.writeFileString(inHome, 'not for the unit')
      yield* fs.writeFileString(source, 'the-value')
      yield* fs.makeDirectory(writable)
      yield* fs.writeFileString(readable, 'its own')
      // The resolver's files, whichever of them the host has.
      const resolver = yield* Effect.filter(
        ['/etc/nsswitch.conf', '/etc/host.conf', '/etc/hosts', '/etc/resolv.conf', '/etc/gai.conf'],
        path => fs.exists(path),
      )

      yield* Systemd.start(programs, {
        argv: [
          bash,
          '-c',
          `cp "$CREDENTIALS_DIRECTORY/tok" ${writable}/seen; for p in ${source} ${readable} ${inHome} ${resolver.join(' ')}; do [ -r "$p" ] && echo "reads $p"; [ -w "$p" ] && echo "writes $p"; done > ${writable}/sight; cat /proc/self/oom_score_adj > ${writable}/oom; sleep 30`,
        ],
        confine: {
          kind: 'credentials',
          readable: [readable],
          writable: [writable],
        },
        credentials: [{ name: 'tok', path: source }],
        env: { PATH: coreutils },
        name,
        slice,
        workingDirectory: writable,
      })
      yield* Effect.sleep('1 second')

      // An arg-shape test cannot tell an accepted property from a rejected one:
      // systemd-run fails at runtime, so the unit simply never runs.
      assert.isTrue(yield* Systemd.isActive('systemctl', name), 'the confined unit is not running')
      assert.strictEqual(yield* fs.readFileString(`${writable}/seen`), 'the-value')
      // Raised as far as it goes, which a user manager may do for its own unit,
      // and no memory bound, since none was given.
      assert.strictEqual((yield* fs.readFileString(`${writable}/oom`)).trim(), '1000')
      assert.strictEqual(
        (yield* Systemd.show('systemctl', name, ['MemoryMax'])).get('MemoryMax'),
        'infinity',
      )
      // The value reaches the unit without ever being an argument, which is the
      // whole reason this is LoadCredential= and not SetCredential=.
      assert.isFalse(
        Systemd.startArgs({
          argv: ['/bin/sh'],
          credentials: [{ name: 'tok', path: source }],
          name,
          slice,
          workingDirectory: '/tmp',
        }).some(arg => arg.includes('the-value')),
      )
      // What it was given to read and the resolver's files, and those only to
      // read. Not the file its credential came from, beside it under
      // /run/user, and not the user's file in the home directory.
      assert.deepStrictEqual((yield* fs.readFileString(`${writable}/sight`)).trim().split('\n'), [
        `reads ${readable}`,
        ...resolver.map(path => `reads ${path}`),
      ])
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.live(
    "keeps a credential holder from every directory beside its own, and from the user's session",
    () =>
      Effect.gen(function* () {
        yield* cleanup
        const fs = yield* FileSystem.FileSystem
        const perl = yield* fromStore('perl')
        const runtime = process.env['XDG_RUNTIME_DIR'] ?? '/run/user/0'
        // Laid out as the CLI lays out VMs: one directory holding each VM's
        // runtime directory and its broker's, the unit's own among them, and
        // beside it a file the unit is given to read.
        const shown = `${runtime}/igloo-selftest-siblings`
        const vms = `${shown}/igloo`
        const own = `${vms}/own-broker`
        yield* Effect.addFinalizer(() => fs.remove(shown, { recursive: true }).pipe(Effect.ignore))
        yield* fs.remove(shown, { recursive: true }).pipe(Effect.ignore)
        yield* fs.makeDirectory(own, { recursive: true })
        yield* fs.writeFileString(`${shown}/beside`, 'shown')
        const listen = (path: string) =>
          Effect.acquireRelease(
            Effect.sync(() => Bun.listen({ socket: { data: () => {} }, unix: path })),
            server => Effect.sync(() => server.stop(true)),
          )
        // Another VM's: a credential value, the QMP socket that controls its
        // guest, and its broker's socket.
        const vm = (id: string) => ({
          broker: `${vms}/${id}-broker/http.sock`,
          control: `${vms}/${id}/control.socket`,
          credential: `${vms}/${id}/broker-credentials/tok`,
        })
        const stage = Effect.fnUntraced(function* (id: string) {
          const paths = vm(id)
          yield* fs.makeDirectory(dirname(paths.credential), { recursive: true })
          yield* fs.makeDirectory(dirname(paths.broker))
          yield* fs.writeFileString(paths.credential, 'not for the unit')
          yield* listen(paths.control)
          yield* listen(paths.broker)
        })
        yield* stage('before')
        // Its own socket, which shows the probe can connect at all.
        yield* listen(`${own}/own.sock`)
        // The session bus and the user manager's two sockets, whichever this
        // host has. The manager's private one it must have: these tests drive it.
        const session = yield* Effect.filter(
          [`${runtime}/bus`, `${runtime}/systemd/private`, `${runtime}/systemd/io.systemd.Manager`],
          path => fs.exists(path),
        )
        assert.include(session, `${runtime}/systemd/private`)

        // Once it is running, it waits for a VM started after it, then prints
        // each path it can connect to or see.
        const probe = String.raw`use IO::Socket::UNIX;
$| = 1;
my ($go, @paths) = @ARGV;
print "ready\n";
select(undef, undef, undef, 0.1) until -e $go;
for my $p (@paths) {
  if (IO::Socket::UNIX->new(Peer => $p)) { print "connects to $p\n" }
  elsif (-e $p) { print "sees $p\n" }
}
print "done\n";`
        const log = `${own}.log`
        const logged = Effect.fnUntraced(function* (line: string) {
          for (let attempt = 0; attempt < 50; attempt++) {
            const text = yield* fs.readFileString(log).pipe(Effect.orElseSucceed(() => ''))
            if (text.includes(`${line}\n`)) return
            yield* Effect.sleep('100 millis')
          }
        })
        yield* Systemd.start(programs, {
          argv: [
            perl,
            '-e',
            probe,
            `${own}/go`,
            ...Object.values(vm('before')),
            ...Object.values(vm('later')),
            ...session,
            `${shown}/beside`,
            `${own}/own.sock`,
          ],
          confine: { kind: 'credentials', readable: [`${shown}/beside`], writable: [own] },
          // The manager's locale names files outside the store, and perl
          // warns about each one it cannot find.
          env: { LC_ALL: 'C' },
          logFile: log,
          name,
          slice,
          workingDirectory: own,
        })
        yield* logged('ready')
        yield* stage('later')
        yield* fs.writeFileString(`${own}/go`, '')
        yield* logged('done')

        // Its own socket and what it was given to read, and of the rest
        // nothing: neither VM's credential or sockets, whether it was there when
        // the unit started or came after, and nothing the session listens on.
        assert.deepStrictEqual((yield* fs.readFileString(log)).trim().split('\n'), [
          'ready',
          `sees ${shown}/beside`,
          `connects to ${own}/own.sock`,
          'done',
        ])
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    20_000,
  )

  it.live(
    'keeps a credential holder from every socket under /run but its own',
    () =>
      Effect.gen(function* () {
        yield* cleanup
        const fs = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const perl = yield* fromStore('perl')
        const dir = `${process.env['XDG_RUNTIME_DIR'] ?? '/run/user/0'}/igloo-selftest-system`
        yield* Effect.addFinalizer(() => fs.remove(dir, { recursive: true }).pipe(Effect.ignore))
        yield* fs.remove(dir, { recursive: true }).pipe(Effect.ignore)
        yield* fs.makeDirectory(dir, { recursive: true })
        // Its own, which shows the probe can connect at all.
        const own = `${dir}/own.sock`
        yield* Effect.acquireRelease(
          Effect.sync(() => Bun.listen({ socket: { data: () => {} }, unix: own })),
          server => Effect.sync(() => server.stop(true)),
        )

        // Every socket under /run it can connect to, of any type. Non-blocking,
        // since a connect to a server whose backlog is full would otherwise wait
        // for it.
        const probe = String.raw`use File::Find;
use Socket;
$| = 1;
$SIG{__WARN__} = sub {};
my @sockets;
find({ no_chdir => 1, wanted => sub { push @sockets, $_ if -S $_ } }, '/run');
for my $p (sort @sockets) {
  for my $type (SOCK_STREAM, SOCK_DGRAM, SOCK_SEQPACKET) {
    socket(my $s, AF_UNIX, $type | SOCK_NONBLOCK, 0) or next;
    if (connect($s, pack_sockaddr_un($p))) { print "connects to $p\n"; last }
  }
}
print "done\n";`
        // The set is the host's, whatever it runs: what this test's own process,
        // one of the user's, can connect to.
        const reached = (yield* spawner.string(ChildProcess.make(perl, ['-e', probe])))
          .trim()
          .split('\n')
        assert.include(reached, `connects to ${own}`)
        assert.isAbove(reached.length, 3, 'nothing under /run but its own socket to test against')

        const log = `${dir}.log`
        yield* Effect.addFinalizer(() => fs.remove(log).pipe(Effect.ignore))
        yield* Systemd.start(programs, {
          argv: [perl, '-e', probe],
          confine: { kind: 'credentials', writable: [dir] },
          // The manager's locale names files outside the store, and perl
          // warns about each one it cannot find.
          env: { LC_ALL: 'C' },
          logFile: log,
          name,
          slice,
          workingDirectory: dir,
        })
        for (let attempt = 0; attempt < 100; attempt++) {
          const text = yield* fs.readFileString(log).pipe(Effect.orElseSucceed(() => ''))
          if (text.includes('done\n')) break
          yield* Effect.sleep('100 millis')
        }

        assert.deepStrictEqual((yield* fs.readFileString(log)).trim().split('\n'), [
          `connects to ${own}`,
          'done',
        ])
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    20_000,
  )

  it.live("keeps a credential holder from the user's terminals, shared memory and processes", () =>
    Effect.gen(function* () {
      yield* cleanup
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const bash = yield* fromStore('bash')
      const tools = yield* Effect.forEach(['sleep', 'ipcs', 'grep'], tool =>
        fromStore(tool).pipe(Effect.map(dirname)),
      )
      // Under /run/user, as the broker's own directories are.
      const dir = `${process.env['XDG_RUNTIME_DIR'] ?? '/run/user/0'}/igloo-selftest-reach`
      yield* Effect.addFinalizer(() => fs.remove(dir, { recursive: true }).pipe(Effect.ignore))
      yield* fs.remove(dir, { recursive: true }).pipe(Effect.ignore)
      yield* fs.makeDirectory(dir, { recursive: true })
      yield* fs.writeFileString(`${dir}/own`, 'its own')
      // What another program of the user's leaves where programs share memory:
      // a file in /dev/shm, and a System V segment anyone may read.
      const shm = `/dev/shm/igloo-selftest-${String(process.pid)}`
      yield* Effect.addFinalizer(() => fs.remove(shm).pipe(Effect.ignore))
      yield* fs.writeFileString(shm, 'not for the unit')
      const segment = (yield* spawner.string(
        ChildProcess.make('ipcmk', ['--shmem', '4096', '--mode', '0644']),
      )).replace(/\D/g, '')
      yield* Effect.addFinalizer(() =>
        spawner.exitCode(ChildProcess.make('ipcrm', ['--shmem-id', segment])).pipe(Effect.ignore),
      )
      const probes = [
        `${dir}/own`,
        '/proc/self/status',
        '/dev/pts',
        shm,
        '/dev/mqueue',
        '/dev/hugepages',
        // This test's own process, which is one of the user's.
        `/proc/${String(process.pid)}/cmdline`,
      ]

      yield* Systemd.start(programs, {
        argv: [
          bash,
          '-c',
          `for p in ${probes.map(p => `'${p}'`).join(' ')}; do [ -r "$p" ] && echo "$p"; done > sight; ipcs -m -i ${segment} 2>/dev/null | grep -q 'shmid=${segment}$' && echo segment >> sight; sleep 30`,
        ],
        confine: {
          kind: 'credentials',
          memoryMax: '128M',
          writable: [dir],
        },
        env: { PATH: tools.join(':') },
        name,
        slice,
        workingDirectory: dir,
      })
      yield* Effect.sleep('1 second')

      assert.isTrue(yield* Systemd.isActive('systemctl', name), 'the confined unit is not running')
      const bounds = yield* Systemd.show('systemctl', name, ['MemoryMax', 'MemorySwapMax'])
      assert.strictEqual(bounds.get('MemoryMax'), String(128 * 1024 * 1024))
      assert.strictEqual(bounds.get('MemorySwapMax'), '0')
      // Its own file and its own processes' entries in /proc, which show the
      // probe can read at all; none of what belongs to the user's other
      // programs.
      assert.deepStrictEqual((yield* fs.readFileString(`${dir}/sight`)).trim().split('\n'), [
        `${dir}/own`,
        '/proc/self/status',
      ])
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.live('confines a hypervisor to the store, its own directory and its devices', () =>
    Effect.gen(function* () {
      yield* cleanup
      const fs = yield* FileSystem.FileSystem
      const bash = yield* fromStore('bash')
      const sleep = yield* fromStore('sleep')
      // A temp directory, because where these live makes no difference: nothing
      // but the paths named reaches the unit, /tmp included.
      const dir = yield* fs.makeTempDirectoryScoped()
      // A space and a colon, which systemd would otherwise read as a second path
      // and as the start of a bind's destination.
      const writable = `${dir}/run dir:1`
      const hidden = `${writable}/hidden`
      const sibling = `${dir}/sibling`
      yield* fs.makeDirectory(hidden, { recursive: true })
      yield* fs.makeDirectory(sibling)
      yield* fs.writeFileString(`${writable}/own`, 'its own')
      yield* fs.writeFileString(`${hidden}/secret`, 'not for the unit')
      yield* fs.writeFileString(`${sibling}/secret`, 'not for the unit')
      // A file of the user's, so the home directory has something to hide. The
      // directory itself may be there, when `dir` is under it: systemd makes
      // the path down to a bind in the unit's empty root, and nothing beside it.
      const inHome = `${homedir()}/.igloo-selftest-${basename(dir)}`
      yield* Effect.addFinalizer(() => fs.remove(inHome).pipe(Effect.ignore))
      yield* fs.writeFileString(inHome, 'not for the unit')
      const probes = [
        `${writable}/own`,
        `${hidden}/secret`,
        `${sibling}/secret`,
        inHome,
        '/dev/pts',
        '/dev/kvm',
      ]

      yield* Systemd.start(programs, {
        argv: [
          bash,
          '-c',
          `for p in ${probes.map(p => `'${p}'`).join(' ')}; do [ -r "$p" ] && echo "$p"; done > sight; exec ${sleep} 30`,
        ],
        confine: {
          kind: 'hypervisor',
          // One device the host has if it runs VMs at all, and one no host has:
          // an absent device is for the process to report, not a reason the
          // unit cannot start.
          devices: ['/dev/kvm', '/dev/igloo-selftest-absent'],
          hidden: [hidden, `${writable}/absent`],
          writable: [writable],
        },
        name,
        slice,
        workingDirectory: writable,
      })
      yield* Effect.sleep('1 second')

      assert.isTrue(yield* Systemd.isActive('systemctl', name), 'the confined unit is not running')
      // Its own directory, and the device if the host has one; not the hidden
      // path inside that directory, not a sibling of it, not a file in the
      // home directory, and not the user's terminals.
      const kvm = yield* fs.exists('/dev/kvm')
      assert.deepStrictEqual(
        (yield* fs.readFileString(`${writable}/sight`)).trim().split('\n'),
        kvm ? [`${writable}/own`, '/dev/kvm'] : [`${writable}/own`],
      )
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.live('confines a forwarder to the store and what it may read, with or without IP', () =>
    Effect.gen(function* () {
      yield* cleanup
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const perl = yield* fromStore('perl')
      const dir = yield* fs.makeTempDirectoryScoped()
      const readable = `${dir}/readable`
      const sibling = `${dir}/sibling`
      const source = `${dir}/source`
      yield* fs.makeDirectory(readable)
      yield* fs.makeDirectory(sibling)
      yield* fs.writeFileString(`${readable}/own`, 'its own')
      yield* fs.writeFileString(`${sibling}/secret`, 'not for the unit')
      yield* fs.writeFileString(source, 'the-value')
      // As for a hypervisor: a file in the home directory, which may itself be
      // there as the path down to `readable`.
      const inHome = `${homedir()}/.igloo-selftest-${basename(dir)}`
      yield* Effect.addFinalizer(() => fs.remove(inHome).pipe(Effect.ignore))
      yield* fs.writeFileString(inHome, 'not for the unit')
      // The credential it was handed, each path it can read, whether it can
      // write the first, the outcome of opening a socket of each family —
      // AF_INET, AF_INET6, AF_NETLINK, AF_VSOCK — and its network namespace.
      // Printed, because nothing in its root is writable.
      const probe = String.raw`my ($credential, @paths) = @ARGV;
my $c;
print open($c, '<', $credential) ? ('credential ', <$c>, "\n") : "no credential\n";
for my $p (@paths) { print "$p\n" if -r $p }
print open(my $w, '>>', $paths[0]) ? "writable\n" : "read-only\n";
for my $f ([2, 1], [10, 1], [16, 2], [40, 1]) {
  print "family $f->[0] ", (socket(my $s, $f->[0], $f->[1], 0) ? 'opened' : "$!"), "\n";
}
print 'net ', readlink('/proc/self/ns/net'), "\n";`
      const paths = [`${readable}/own`, `${sibling}/secret`, source, inHome]
      const plain = (yield* spawner.string(
        ChildProcess.make(perl, ['-e', probe, source, ...paths]),
      )).split('\n')
      const opened = (family: number): string =>
        plain.find(line => line.startsWith(`family ${String(family)} `)) ?? ''

      const view = Effect.fnUntraced(function* (hostNetwork: boolean) {
        const log = `${dir}/${hostNetwork ? 'host' : 'own'}.log`
        yield* Systemd.start(programs, {
          // Expanded by systemd as it starts the unit, which is how a forward
          // finds its key in an empty root.
          argv: [perl, '-e', probe, '${CREDENTIALS_DIRECTORY}/tok', ...paths],
          confine: { kind: 'forwarder', hostNetwork, readable: [readable] },
          credentials: [{ name: 'tok', path: source }],
          // The manager's locale names files outside the store, and perl
          // warns about each one it cannot find.
          env: { LC_ALL: 'C' },
          logFile: log,
          name: `${name}-${hostNetwork ? 'host' : 'own'}`,
          slice,
          workingDirectory: '/',
        })
        yield* Effect.sleep('1 second')
        return (yield* fs.readFileString(log)).trim().split('\n')
      })
      const refused = 'Address family not supported by protocol'
      const ours = `net ${yield* fs.readLink('/proc/self/ns/net')}`

      // What it was handed and what it may read, and nothing else: not a
      // sibling, not the credential's source, not a file in the home. It
      // reaches its guest over vsock and nothing else, so no IP and no netlink.
      const own = yield* view(false)
      assert.deepStrictEqual(own.slice(0, -1), [
        'credential the-value',
        `${readable}/own`,
        'read-only',
        `family 2 ${refused}`,
        `family 10 ${refused}`,
        `family 16 ${refused}`,
        opened(40),
      ])
      assert.match(own.at(-1) ?? '', /^net /)
      assert.notStrictEqual(own.at(-1), ours, 'it shares the network namespace')

      // The same, but on the host's network and with IPv4 on it, which a
      // forward that listens on the host's loopback needs.
      const host = yield* view(true)
      assert.deepStrictEqual(host, [
        'credential the-value',
        `${readable}/own`,
        'read-only',
        opened(2),
        `family 10 ${refused}`,
        `family 16 ${refused}`,
        opened(40),
        ours,
      ])
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.live(
    'keeps a unit of every kind from the kernel log',
    () =>
      Effect.gen(function* () {
        yield* cleanup
        const fs = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const bash = yield* fromStore('bash')
        const dmesg = yield* fromStore('dmesg')
        const dir = yield* fs.makeTempDirectoryScoped()
        // The log's two files, and syslog(2), which `dmesg -S` reads it through
        // in place of /dev/kmsg. Its errors go nowhere, so a shell reporting
        // dmesg killed adds no line.
        const probe = `exec 2>/dev/null; for p in /dev/kmsg /proc/kmsg; do [ -e "$p" ] && echo "has $p"; done; ${dmesg} -S >/dev/null && echo 'reads the log'; echo done`
        // Both files are there for this test's own process, one of the user's.
        // Whether it may read the log is the host's to decide.
        const plain = (yield* spawner.string(ChildProcess.make(bash, ['-c', probe])))
          .trim()
          .split('\n')
        assert.includeMembers(plain, ['has /dev/kmsg', 'has /proc/kmsg', 'done'])

        const kinds: Record<string, Systemd.Confinement> = {
          credentials: { kind: 'credentials', writable: [dir] },
          forwarder: { kind: 'forwarder', hostNetwork: false, readable: [] },
          hypervisor: { kind: 'hypervisor', devices: [], hidden: [], writable: [dir] },
        }
        for (const [kind, confine] of Object.entries(kinds)) {
          const log = `${dir}/${kind}.log`
          yield* Systemd.start(programs, {
            argv: [bash, '-c', probe],
            confine,
            logFile: log,
            name: `${name}-${kind}`,
            slice,
            workingDirectory: '/',
          })
          for (let attempt = 0; attempt < 50; attempt++) {
            const text = yield* fs.readFileString(log).pipe(Effect.orElseSucceed(() => ''))
            if (text.includes('done\n')) break
            yield* Effect.sleep('100 millis')
          }
          assert.deepStrictEqual((yield* fs.readFileString(log)).trim().split('\n'), ['done'], kind)
        }
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    20_000,
  )

  it.live('lists the slice as a child of the prefix, and unknown properties as defaults', () =>
    Effect.gen(function* () {
      yield* cleanup
      yield* Systemd.start(programs, {
        argv: ['/bin/sh', '-c', 'sleep 300'],
        env: { PATH: process.env['PATH'] ?? '' },
        name,
        slice,
        workingDirectory: '/tmp',
      })

      assert.include(yield* Systemd.listSlices('systemctl', 'igloo'), `${slice}.slice`)
      // The slice's cgroup accounts for its members, which is what makes a
      // forgotten VM's memory visible.
      const memory = (yield* Systemd.show('systemctl', `${slice}.slice`, ['MemoryCurrent'])).get(
        'MemoryCurrent',
      )
      assert.isTrue(Number(memory) > 0, `MemoryCurrent was ${String(memory)}`)

      // `show` answers for a unit that was never loaded, so its result cannot be
      // read as evidence the unit exists.
      const absent = yield* Systemd.show('systemctl', 'igloo-selftest-absent.service', [
        'ActiveState',
        'MemoryCurrent',
      ])
      assert.strictEqual(absent.get('ActiveState'), 'inactive')
      assert.strictEqual(absent.get('MemoryCurrent'), '[not set]')
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )
})
