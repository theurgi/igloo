import type { VmSpec } from './Vm.ts'

import { BunServices } from '@effect/platform-bun'
import { afterAll, assert, beforeAll, describe, it, vi } from '@effect/vitest'
import { Clock, Effect, FileSystem, Result, Schema } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { homedir } from 'node:os'
import { basename, dirname } from 'node:path'

import * as Binaries from './Binaries.ts'
import * as BootLog from './BootLog.ts'
import * as Systemd from './Systemd.ts'
import * as Tls from './Tls.ts'
import * as Vm from './Vm.ts'

// A launch narrates itself on stderr for whoever started it. Here that is the
// test run, where it is noise between the results; the boot record keeps the
// same notes for the tests that read them.
beforeAll(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterAll(() => {
  vi.restoreAllMocks()
})

const PATH = process.env['PATH'] ?? ''

const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

/** What the fake `nix` evaluates every runner to. */
const runnerDrv = '/nix/store/00000000000000000000000000000000-runner.drv'

/** `nix derivation show` for `runnerDrv` alone, a plain derivation. */
const runnerShown = json({
  derivations: {
    '00000000000000000000000000000000-runner.drv': {
      env: { out: '/nix/store/00000000000000000000000000000000-runner' },
      outputs: { out: { path: '00000000000000000000000000000000-runner' } },
    },
  },
  version: 4,
})

/**
 * A tool by a path inside the store, which is all QEMU's confined unit can run.
 * Resolved through its directory rather than to the file itself: a multi-call
 * binary such as coreutils tells which tool to be by the name it was run as.
 */
const fromStore = Effect.fnUntraced(function* (name: string) {
  const fs = yield* FileSystem.FileSystem
  const found = Bun.which(name)
  const path = found === null ? '' : `${yield* fs.realPath(dirname(found))}/${name}`
  if (!path.startsWith('/nix/store/')) return yield* Effect.die(`${name} is not in the store`)
  return path
})

/**
 * QEMU's side of `down`'s exchange: a greeting, a reply to each command, and on
 * `system_powerdown` a `poweroff` file and an exit — which is what a guest that
 * obeys its power button amounts to, seen from the host.
 */
const qmpServer = String.raw`use strict;
use warnings;
use IO::Socket::UNIX;

my $server = IO::Socket::UNIX->new(Local => 'control.socket', Listen => 1)
  or die "fake QEMU: cannot listen on control.socket: $!";
while (my $client = $server->accept) {
  $client->autoflush(1);
  print $client qq({"QMP": {"version": {}, "capabilities": []}}\r\n);
  while (my $line = <$client>) {
    print $client qq({"return": {}}\r\n);
    if ($line =~ /"system_powerdown"/) {
      open(my $mark, '>', 'poweroff') or die;
      close($mark);
      exit 0;
    }
  }
}`

/**
 * Stand-ins for `nix`, `igloo-store-view`, `virtiofsd` and `ssh`. systemd is
 * *not* faked: the units are real transient units in the caller's user manager,
 * which is the part of this sequence with no other way to be checked.
 *
 * The fakes talk to each other through the working directory — virtiofsd binds
 * the socket there, and `microvm-run` becomes a QMP server on `control.socket`
 * that drops a `poweroff` file beside it when told to power off — so a test that
 * passes also proves the units were given the working directory they need.
 * The fake runner still has a `microvm-shutdown`, which only records that
 * something ran it, because nothing should.
 *
 * The fake runner declares its shares the way a real one does, in
 * `share/microvm/virtiofs/<tag>/`, with a socket named after a guest hostname
 * the host side was never told. That is the real shape, and reconstructing the
 * name host-side from a guessed hostname is what made the first host run fail.
 * Two shares, because only the one serving the store should run under
 * `igloo-store-view`.
 *
 * The fake runner is built into the VM's runtime directory, because QEMU's unit
 * is confined to that and the store, and a test cannot write to the store. For
 * the same reason its `microvm-run` names its interpreters by store path. It
 * records, in `sight`, which of the paths it must not reach it could read. The
 * QMP server is perl rather than bun, which would not start under the unit's
 * `MemoryDenyWriteExecute=`.
 *
 * The forwards' units are confined the same way but have nothing writable, so
 * the fake `ssh` and `igloo-landlock` stay where they are, which their units
 * bind in because it is outside the store, and name their interpreters by store
 * path. A held `ssh` prints what it can read into its unit's log, and listens
 * for a local forward with perl, for the reason the QMP server does.
 *
 * The broker's unit binds in its programs for the same reason, so the real
 * broker and the fake `igloo-landlock` it runs under stay where they are too.
 */
const writeFakes = Effect.fnUntraced(function* (
  dir: string,
  options?: {
    /** What the dry run prints. By default, that `runnerDrv` will be built. */
    readonly plan?: string
    /** Whether `runnerDrv`'s output is valid, which nix is asked only when the plan omits it. */
    readonly runnerBuilt?: boolean
    /** The spec's, when it is not `specIn`'s. */
    readonly runtimeDir?: string
    /** What `nix derivation show` prints. By default, `runnerShown`. */
    readonly shown?: string
    /**
     * How many times the guest refuses ssh before it answers. None by default,
     * since every refusal costs the readiness wait a real second.
     */
    readonly sshRefusals?: number
    readonly virtiofsdFails?: boolean
  },
) {
  const fs = yield* FileSystem.FileSystem
  const runtimeDir = options?.runtimeDir ?? `${dir}/run`
  const store = `${runtimeDir}/runner`
  const bash = yield* fromStore('bash')
  const perl = yield* fromStore('perl')
  const shutdownHelperRan = `${dir}/shutdown-helper-ran`
  // A file of the user's, so the home directory has something to hide. The
  // directory itself may be there: where `dir` is under it, systemd makes the
  // path down to each bind in a unit's empty root, and nothing beside it.
  const inHome = `${homedir()}/.igloo-selftest-${basename(dir)}`
  yield* Effect.addFinalizer(() => fs.remove(inHome).pipe(Effect.ignore))
  yield* fs.writeFileString(inHome, 'not for the unit')
  const unreachable = [`${dir}/project`, inHome, `${runtimeDir}/broker-credentials`]
  const buildCount = `${dir}/nix-build-count`
  const buildArgs = `${dir}/nix-build-args`
  const evalArgs = `${dir}/nix-eval-args`
  const showArgs = `${dir}/nix-show-args`
  const plan = `${dir}/nix-plan`
  const shown = `${dir}/nix-shown`
  yield* fs.writeFileString(
    plan,
    options?.plan ?? `this derivation will be built:\n  ${runnerDrv}\n`,
  )
  yield* fs.writeFileString(shown, options?.shown ?? (yield* runnerShown))
  const sshCount = `${dir}/ssh-count`
  const storeViewLog = `${dir}/store-view-log`
  const storeViewPaths = `${dir}/store-view-paths`
  const workspace = `${dir}/workspace`
  yield* fs.makeDirectory(workspace, { recursive: true })

  const write = Effect.fnUntraced(function* (name: string, body: string) {
    const file = `${dir}/${name}`
    yield* fs.writeFileString(file, body)
    yield* fs.chmod(file, 0o755)
    return file
  })

  const nix = yield* write(
    'fake-nix',
    `#!/usr/bin/env bash
if [ "$1" = "path-info" ] && [ "$2" = "--derivation" ]; then
  printf '%s\\n' "$@" > '${evalArgs}'
  echo '${runnerDrv}'
  exit 0
fi
if [ "$1" = "build" ] && [ "$2" = "--dry-run" ]; then
  cat '${plan}' >&2
  exit 0
fi
if [ "$1" = "path-info" ] && [ "$2" = '${runnerDrv}^*' ]; then
  exit ${options?.runnerBuilt === true ? '0' : '1'}
fi
if [ "$1" = "derivation" ] && [ "$2" = "show" ]; then
  printf '%s\\n' "$@" > '${showArgs}'
  cat '${shown}'
  exit 0
fi
if [ "$1" = "build" ]; then
  printf '%s\\n' "$@" > '${buildArgs}'
  outlink=""
  while [ $# -gt 0 ]; do
    if [ "$1" = "--out-link" ]; then outlink="$2"; fi
    shift
  done
  printf 'x' >> '${buildCount}'
  mkdir -p '${store}/bin'
  mkdir -p '${store}/share/microvm/virtiofs/ro-store' '${store}/share/microvm/virtiofs/workspace'
  echo 'igloo-test-virtiofs-ro-store.sock' > '${store}/share/microvm/virtiofs/ro-store/socket'
  echo '/nix/store' > '${store}/share/microvm/virtiofs/ro-store/source'
  echo 'igloo-test-virtiofs-workspace.sock' > '${store}/share/microvm/virtiofs/workspace/socket'
  echo '${workspace}' > '${store}/share/microvm/virtiofs/workspace/source'
  cat > '${store}/bin/microvm-run' <<'EOS'
#!${bash}
for p in ${unreachable.map(path => `'${path}'`).join(' ')}; do [ -r "$p" ] && echo "$p"; done > sight
exec ${perl} '${store}/qmp.pl'
EOS
  cat > '${store}/qmp.pl' <<'EOS'
${qmpServer}
EOS
  cat > '${store}/bin/microvm-shutdown' <<'EOS'
#!/usr/bin/env bash
touch '${shutdownHelperRan}'
EOS
  chmod +x '${store}/bin/microvm-run' '${store}/bin/microvm-shutdown'
  ln -sfn '${store}' "$outlink"
fi
if [ "$1" = "path-info" ]; then
  echo /nix/store/aaa
  echo /nix/store/bbb
fi
exit 0
`,
  )

  // Binds the socket named on its own command line, in whatever directory it
  // was started in — the two things the launch has to get right for QEMU to
  // find it.
  const virtiofsd = yield* write(
    'fake-virtiofsd',
    options?.virtiofsdFails === true
      ? `#!/usr/bin/env bash
exit 1
`
      : `#!/usr/bin/env bash
sock=""
for arg in "$@"; do
  case "$arg" in --socket-path=*) sock="\${arg#--socket-path=}" ;; esac
done
[ -n "$sock" ] || { echo "fake-virtiofsd: no --socket-path" >&2; exit 64; }
echo fresh > "$sock"
sleep 300
`,
  )

  // The real helper restricts the store inside a mount namespace; here the
  // command just runs. It refuses what the real one refuses about its list —
  // absent, empty, or a line that is not a store path — and keeps a copy, so a
  // test can tell which daemons ran under it and what they were given.
  const storeView = yield* write(
    'fake-store-view',
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${storeViewLog}'
paths=$1; shift
[ -s "$paths" ] || { echo "fake-store-view: $paths lists no store paths" >&2; exit 1; }
while IFS= read -r line; do
  case "$line" in
    /nix/store/*/* | /nix/store/. | /nix/store/..) echo "fake-store-view: $line" >&2; exit 1 ;;
    /nix/store/?*) ;;
    *) echo "fake-store-view: $line is not a store path" >&2; exit 1 ;;
  esac
done < "$paths"
cp "$paths" '${storeViewPaths}'
exec "$@"
`,
  )

  // Refuses the first two connections, so the readiness loop has to retry —
  // which is what a real guest does for the length of its boot.
  const sleep = yield* fromStore('sleep')
  // `specIn`'s key. A forward's unit is handed it by `LoadCredential=`, which
  // fails the start if it is missing.
  yield* fs.writeFileString(`${dir}/id`, 'not a key')
  // What a forward's unit must not reach: the above, the VM's runtime
  // directory with its QMP socket, and the key where the project keeps it.
  const unreachableByForwards = [...unreachable, runtimeDir, `${dir}/id`]
  const ssh = yield* write(
    'fake-ssh',
    `#!${bash}
# Resolve the destination the way ssh does — the first argument that is
# neither a flag nor a flag's value — so a remote command smuggled in ahead of
# it fails here the way it fails against a real guest.
dest=""
skip=0
for arg in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$arg" in
    -o|-i|-F|-R|-L) skip=1 ;;
    -*) ;;
    *) dest="$arg"; break ;;
  esac
done
case "$dest" in
  vsock/*) ;;
  *) echo "fake-ssh: destination is '$dest', not a vsock address" >&2; exit 255 ;;
esac
# -N marks a forward, held open for as long as the VM lives, rather than a
# command that runs and exits. It runs in its confined unit, and says what it
# can read there. A local forward also binds its host port, and binding it is
# the thing the launch waits for — a fake that only slept would make that wait
# time out on a forward that is working.
hold=""
identity=""
lports=""
prev=""
for arg in "$@"; do
  case "$prev" in
    -i) identity="$arg" ;;
    -L) rest="\${arg#*:}"; lports="$lports \${rest%%:*}" ;;
  esac
  if [ "$arg" = "-N" ]; then hold=1; fi
  prev="$arg"
done
if [ -n "$hold" ]; then
  [ -r "$identity" ] && echo "sees its identity"
  for p in ${unreachableByForwards.map(path => `'${path}'`).join(' ')}; do [ -r "$p" ] && echo "sees $p"; done
  [ -S '${runtimeDir}-broker/http.sock' ] && echo "sees the broker's socket"
  if [ -n "$lports" ]; then
    # The manager's locale names files outside the store, which perl warns of.
    LC_ALL=C exec ${perl} -MIO::Socket::INET -e 'my @held = map { IO::Socket::INET->new(LocalAddr => "127.0.0.1", LocalPort => $_, Listen => 8, ReuseAddr => 1) or die "fake-ssh: cannot listen on $_: $!\\n" } @ARGV; sleep 300' $lports
  fi
  exec ${sleep} 300
fi
# A guest answers only once its QEMU is running, and QEMU binds its control
# socket before the guest starts. Waiting for that here, rather than refusing,
# keeps the readiness loop from sleeping a second per refusal.
waited=0
while [ ! -S '${runtimeDir}/control.socket' ] && [ "$waited" -lt 50 ]; do
  sleep 0.1
  waited=$((waited + 1))
done
printf 'x' >> '${sshCount}'
if [ "$(wc -c < '${sshCount}')" -le ${String(options?.sshRefusals ?? 0)} ]; then exit 255; fi
exit 0
`,
  )
  // Never run: the fake ssh reaches its guest without one. It exists because a
  // forward's launch resolves it.
  const sshProxy = yield* write(
    'fake-ssh-proxy',
    `#!${bash}
echo "fake-ssh-proxy: nothing runs this" >&2
exit 1
`,
  )

  // Not a fake: the real broker, this checkout's source with a first line that
  // runs it under the store's bun, as the flake's package does. Nothing about
  // it needs standing in for, and a stand-in would not tell us whether the
  // confined unit can actually start it. One file, because outside the store
  // its unit is given the program and nothing beside it. The bun is the one
  // running these tests: `bun run` puts a shim of its own outside the store
  // ahead of the store's on `PATH`.
  const broker = yield* write(
    'igloo-broker.ts',
    `#!${process.execPath}
${yield* fs.readFileString(new URL('broker.ts', import.meta.url).pathname)}`,
  )
  // What the broker's unit must not reach: the VM's runtime directory, with
  // its QMP socket and the staged credential, the project, and the user
  // manager's socket, which starts units for the asking.
  const unreachableByBroker = [
    runtimeDir,
    `${dir}/project`,
    `${process.env['XDG_RUNTIME_DIR'] ?? '/run/user/0'}/systemd/private`,
  ]
  // A stand-in for the compiled helper: it holds the command line to the
  // helper's shape and runs the command after `--`, unrestricted. Its
  // interpreter is a store path because the published ports run under it too.
  // Before that it records, in `sight` in its working directory, which of the
  // paths the broker must not reach it can see. A forward's working directory
  // is a root it cannot write, so there it records nothing.
  const landlock = yield* write(
    'fake-landlock',
    `#!${bash}
while [ "$1" = --connect-tcp ] || [ "$1" = --bind-tcp ]; do shift 2; done
[ "$1" = -- ] || { echo "fake-landlock: expected [--connect-tcp PORT | --bind-tcp PORT]... -- COMMAND" >&2; exit 1; }
shift
{ for p in ${unreachableByBroker.map(path => `'${path}'`).join(' ')}; do [ -e "$p" ] && echo "$p"; done > sight; } 2>/dev/null
exec "$@"
`,
  )

  return {
    binaries: {
      broker,
      // Unused by the launch path — only the fallback runs bubblewrap — and,
      // like loginctl, pointed at nothing so that a caller reaching for it
      // fails here rather than shelling out for real.
      bwrap: '/nonexistent-bwrap',
      landlock,
      loginctl: '/nonexistent-loginctl',
      nix,
      ssh,
      sshProxy,
      storeView,
      systemctl: 'systemctl',
      systemdRun: 'systemd-run',
      virtiofsd,
    } satisfies Binaries.Binaries,
    buildArgs,
    buildCount,
    evalArgs,
    showArgs,
    shutdownHelperRan,
    sshCount,
    store,
    storeViewLog,
    storeViewPaths,
    workspace,
  }
})

/** Mirrors `Vm`'s own slice naming, escaping included. */
const sliceOf = (spec: VmSpec): string => `igloo-${Systemd.escapeSliceComponent(spec.id)}`

/** The boot records under a log directory, oldest first. */
const bootDirs = Effect.fnUntraced(function* (logDir: string) {
  const fs = yield* FileSystem.FileSystem
  const entries = yield* fs.readDirectory(logDir)
  return entries.filter(entry => /^\d{4}-/.test(entry)).toSorted()
})

/**
 * A spec whose durable paths sit in `dir` standing in for a project, and whose
 * runtime directory is separate — the same split the CLI makes between the
 * project and the tmpfs.
 */
const specIn = (dir: string, label: string, cid = 42): VmSpec => ({
  broker: false,
  brokered: [],
  brokerMem: undefined,
  brokerTls: undefined,
  tunnel: [],
  cid,
  credentials: [],
  evaluation: { paths: ['/nix/store'], uris: [] },
  flakeRef: '.#testVm',
  grants: [],
  guestWritable: [`${dir}/project/workspace`],
  id: `${label}-${cid.toString(16)}`,
  identityFile: `${dir}/id`,
  label,
  launchInputs: {},
  launchInputsFile: `${dir}/project/.igloo/launched-from.json`,
  logDir: `${dir}/project/.igloo/logs`,
  ports: [],
  projectRoot: `${dir}/project`,
  runnerRootLink: `${dir}/project/.igloo/runners/current`,
  runtimeDir: `${dir}/run`,
  unitEnv: { PATH },
  owner: { gid: 100, uid: 1000 },
  virtiofsdThreads: 2,
})

describe('Vm.sshArgs', () => {
  const bins = Binaries.fromEnv({})
  const spec = specIn('/tmp/x', 'demo')

  it('puts the destination after the options and before the remote command', () => {
    // ssh reads the first non-option argument as the destination. A remote
    // command placed before it becomes the destination, and the failure is an
    // unreachable host rather than a usage error.
    const args = Vm.sshArgs(bins.sshProxy, spec, ['-o', 'BatchMode=yes'], ['true'])
    const dest = args.indexOf('vsock/42')
    assert.notStrictEqual(dest, -1)
    assert.strictEqual(args[dest - 1], 'BatchMode=yes')
    assert.deepStrictEqual(args.slice(dest + 1), ['true'])
  })

  it('leaves the destination last when there is no remote command', () => {
    const args = Vm.sshArgs(bins.sshProxy, spec, ['-t'])
    assert.strictEqual(args.at(-1), 'vsock/42')
  })

  it('never emits a bare word before the destination', () => {
    // Every argument before the destination must be a flag or a flag's value,
    // or ssh will take it as the host.
    const args = Vm.sshArgs(bins.sshProxy, spec, ['-o', 'BatchMode=yes'], ['true'])
    const before = args.slice(0, args.indexOf('vsock/42'))
    for (const [i, arg] of before.entries()) {
      const previous = before[i - 1]
      const isFlag = arg.startsWith('-')
      const isFlagValue = previous !== undefined && previous.startsWith('-')
      assert.isTrue(isFlag || isFlagValue, `bare argument "${arg}" precedes the destination`)
    }
  })
})

describe('Vm.tetherOptions', () => {
  const bins = Binaries.fromEnv({})
  const spec = { ...specIn('/tmp/x', 'demo'), broker: true }

  it('forwards the guest port to this VM’s own socket, and no other’s', () => {
    const args = Vm.tetherOptions(spec)
    const forward = args[args.indexOf('-R') + 1]
    assert.strictEqual(forward, `127.0.0.1:3128:${spec.runtimeDir}-broker/http.sock`)
    // The bind address is explicit rather than left to the server's default,
    // and it is loopback: the forward must not be reachable from the guest's
    // network, only from inside the guest.
    assert.isTrue(forward?.startsWith('127.0.0.1:'))
  })

  it('fails the connection rather than forwarding nothing', () => {
    // Without this a guest that has already taken the port leaves ssh connected
    // and forwarding nothing, so the VM comes up with an unreachable broker and
    // nothing reports it.
    assert.isTrue(Vm.tetherOptions(spec).includes('ExitOnForwardFailure=yes'))
  })

  it('offers the guest nothing of the caller’s', () => {
    // Guest root owns the guest's sshd, so this client is talking to a server
    // the other side controls.
    const args = Vm.tetherOptions(spec)
    for (const declined of [
      'ControlMaster=no',
      'ControlPath=none',
      'ForwardAgent=no',
      'ForwardX11=no',
      'PermitLocalCommand=no',
      'IdentitiesOnly=yes',
    ]) {
      assert.isTrue(args.includes(declined), `${declined} is missing`)
    }
  })

  it('bounds how long a silent peer goes unnoticed', () => {
    const args = Vm.tetherOptions(spec)
    assert.isTrue(args.includes('ServerAliveInterval=15'))
    assert.isTrue(args.includes('ServerAliveCountMax=3'))
  })

  it('still leaves the destination resolvable when combined with sshArgs', () => {
    // `-R` takes a value, and a forward specification is a bare word. ssh reads
    // the first non-option argument as the destination, so a forward that was
    // not recognised as a flag's value would become the host.
    const args = Vm.sshArgs(bins.sshProxy, spec, Vm.tetherOptions(spec))
    assert.strictEqual(args.at(-1), 'vsock/42')
    const forward = args[args.indexOf('-R') + 1]
    assert.isTrue(forward?.endsWith('-broker/http.sock'))
  })
})

describe('Vm.portsOptions', () => {
  const bins = Binaries.fromEnv({})
  const spec = {
    ...specIn('/tmp/x', 'demo'),
    ports: [
      { guest: 3000, host: 3000 },
      { guest: 5173, host: 5174 },
    ],
  }

  it('binds the host end to loopback and reaches the guest’s own loopback', () => {
    const args = Vm.portsOptions(spec)
    const forwards = args.filter((_, index) => args[index - 1] === '-L')

    // Both ends are written out. The host end is the bind, so a published port
    // is not reachable from anywhere but this machine; the guest end is
    // resolved inside the guest, so a server on the guest's own loopback is
    // reachable without binding 0.0.0.0 there.
    assert.deepStrictEqual(forwards, [
      '127.0.0.1:3000:127.0.0.1:3000',
      '127.0.0.1:5174:127.0.0.1:5173',
    ])
  })

  it('fails the connection rather than publishing nothing', () => {
    // The same reason the tether needs it: without this a port that cannot be
    // bound leaves ssh connected and forwarding nothing, and a browser is what
    // finds out.
    assert.isTrue(Vm.portsOptions(spec).includes('ExitOnForwardFailure=yes'))
  })

  it('offers the guest nothing of the caller’s, exactly as the tether does', () => {
    // One hardening list for both forwards, so this is a check that they still
    // share it rather than a second copy of the tether's assertion.
    const ports = Vm.portsOptions(spec)
    for (const declined of Vm.tetherOptions({ ...spec, broker: true }).filter(
      option => option.includes('=') && !option.startsWith('127.0.0.1'),
    )) {
      assert.isTrue(ports.includes(declined), `${declined} is missing`)
    }
  })

  it('still leaves the destination resolvable when combined with sshArgs', () => {
    // `-L` takes a value and a forward specification is a bare word, so a
    // forward not recognised as a flag's value would become the destination.
    const args = Vm.sshArgs(bins.sshProxy, spec, Vm.portsOptions(spec))
    assert.strictEqual(args.at(-1), 'vsock/42')
  })
})

describe('Vm.tetherArgv and Vm.portsArgv', () => {
  const programs: Vm.ForwardPrograms = {
    landlock: '/nix/store/l/bin/igloo-landlock',
    proxy: '/nix/store/p/lib/systemd/systemd-ssh-proxy',
    shell: '/nix/store/b/bin/bash',
    ssh: '/nix/store/o/bin/ssh',
  }
  const spec: VmSpec = {
    ...specIn('/tmp/x', 'demo'),
    broker: true,
    ports: [
      { guest: 5173, host: 5173 },
      { guest: 8000, host: 18000 },
    ],
  }

  it('runs ssh and its proxy by the paths that exist in an empty root', () => {
    for (const argv of [Vm.tetherArgv(programs, spec), Vm.portsArgv(programs, spec)]) {
      assert.include(argv, programs.ssh)
      assert.include(argv, `ProxyCommand=${programs.proxy} %h %p`)
    }
    assert.strictEqual(Vm.tetherArgv(programs, spec)[0], programs.ssh)
  })

  it('reaches for the key it is handed, never the project’s own copy', () => {
    // The project is not in the unit's root; systemd expands this as it starts
    // the unit.
    for (const argv of [Vm.tetherArgv(programs, spec), Vm.portsArgv(programs, spec)]) {
      assert.strictEqual(argv[argv.indexOf('-i') + 1], '${CREDENTIALS_DIRECTORY}/identity')
      assert.notInclude(argv, spec.identityFile)
    }
  })

  it('publishes under Landlock, binding its host ports and connecting to none', () => {
    // The unit keeps the host's network. Its one connection, to the guest, is a
    // vsock, so it needs no TCP connect at all.
    const argv = Vm.portsArgv(programs, spec)
    assert.deepStrictEqual(argv.slice(0, argv.indexOf('--') + 2), [
      programs.landlock,
      '--bind-tcp',
      '5173',
      '--bind-tcp',
      '18000',
      '--',
      programs.ssh,
    ])
  })
})

/** The broker's own command line, after what it runs under. */
const brokerOf = (argv: readonly string[]): readonly string[] => argv.slice(argv.indexOf('--') + 1)

describe('Vm.brokerArgv', () => {
  const bins = Binaries.fromEnv({
    IGLOO_BROKER: '/store/bin/igloo-broker',
    IGLOO_LANDLOCK: '/store/bin/igloo-landlock',
  })
  const spec: VmSpec = {
    ...specIn('/tmp/x', 'demo'),
    broker: true,
    grants: [{ credential: 'GITHUB_TOKEN', profile: 'github-git', repos: ['you/api'] }],
  }

  it('runs the broker under Landlock, connecting to its own ports and no others', () => {
    // The unit leaves it the host's network, and with it every service on
    // loopback and every abstract socket; the helper is what narrows that.
    const argv = Vm.brokerArgv(bins, spec)
    assert.deepStrictEqual(argv.slice(0, argv.indexOf('--')), [
      '/store/bin/igloo-landlock',
      '--connect-tcp',
      '443',
      '--connect-tcp',
      '53',
    ])
  })

  it('lets it connect to a model server’s port too, and only this VM’s broker', () => {
    const argv = Vm.brokerArgv(bins, {
      ...spec,
      grants: [...spec.grants, { name: 'llama-swap', port: 8080, profile: 'model-server' }],
    })
    assert.deepStrictEqual(argv.slice(0, argv.indexOf('--')), [
      '/store/bin/igloo-landlock',
      '--connect-tcp',
      '443',
      '--connect-tcp',
      '53',
      '--connect-tcp',
      '8080',
    ])
    assert.deepStrictEqual(JSON.parse(brokerOf(argv)[3] ?? ''), [
      { credential: 'GITHUB_TOKEN', profile: 'github-git', repos: ['you/api'] },
      { name: 'llama-swap', port: 8080, profile: 'model-server' },
    ])
  })

  it('starts the broker on this VM’s own socket', () => {
    const argv = brokerOf(Vm.brokerArgv(bins, spec))
    assert.strictEqual(argv[0], '/store/bin/igloo-broker')
    assert.strictEqual(argv[1], `${spec.runtimeDir}-broker/http.sock`)
  })

  it('hands the grants over as names, which is all a command line may carry', () => {
    // `/proc/<pid>/cmdline` is world-readable. A profile, a credential's name
    // and some repositories can stand being read there; a value cannot, which is
    // why those arrive by `LoadCredential=` instead.
    const argv = brokerOf(Vm.brokerArgv(bins, spec))
    assert.strictEqual(argv[2], '--grants')
    assert.deepStrictEqual(JSON.parse(argv[3] ?? ''), [
      { credential: 'GITHUB_TOKEN', profile: 'github-git', repos: ['you/api'] },
    ])
  })

  it('starts no tunnel and no TLS listener for a VM with nowhere to tunnel to and no name to answer', () => {
    const argv = Vm.brokerArgv(bins, {
      ...spec,
      grants: [{ credential: 'ANTHROPIC_KEY', profile: 'anthropic-messages' }],
    })
    assert.isFalse(argv.includes('--proxy'))
    assert.isFalse(argv.includes('--tunnel'))
    assert.isFalse(argv.includes('--tls'))
  })

  it('answers a git grant’s host on a TLS socket of its own, reached through the tunnel', () => {
    const argv = brokerOf(Vm.brokerArgv(bins, spec))
    assert.strictEqual(argv[argv.indexOf('--tls') + 1], `${spec.runtimeDir}-broker/tls.sock`)
    // With nowhere to tunnel to, the tunnel still runs: it is how the guest
    // reaches the name.
    assert.strictEqual(argv[argv.indexOf('--proxy') + 1], `${spec.runtimeDir}-broker/proxy.sock`)
    assert.strictEqual(argv[argv.indexOf('--tunnel') + 1], '[]')
  })

  it('gives the tunnel its own socket, beside the broker’s and not instead of it', () => {
    const tunnelled = brokerOf(Vm.brokerArgv(bins, { ...spec, tunnel: ['pypi.org'] }))
    assert.strictEqual(tunnelled[1], `${spec.runtimeDir}-broker/http.sock`)
    assert.strictEqual(
      tunnelled[tunnelled.indexOf('--proxy') + 1],
      `${spec.runtimeDir}-broker/proxy.sock`,
    )
    assert.deepStrictEqual(JSON.parse(tunnelled[tunnelled.indexOf('--tunnel') + 1] ?? ''), [
      'pypi.org',
    ])
  })

  it('passes any name as the string the broker reads, not as a list', () => {
    const anywhere = Vm.brokerArgv(bins, { ...spec, tunnel: 'any' })
    assert.strictEqual(anywhere[anywhere.indexOf('--tunnel') + 1], '"any"')
  })
})

describe('Vm.tetherOptions, with a tunnel', () => {
  const spec = { ...specIn('/tmp/x', 'demo'), broker: true, tunnel: ['pypi.org'] }

  it('opens a second forward, on its own port', () => {
    // Two ports because the two listeners enforce different things: one
    // constructs every upstream request, the other carries bytes it cannot read.
    // Which one a client is using should be visible from inside the guest.
    const forwards = Vm.tetherOptions(spec)
      .map((arg, at, all) => (all[at - 1] === '-R' ? arg : undefined))
      .filter(arg => arg !== undefined)
    assert.deepStrictEqual(forwards, [
      `127.0.0.1:3128:${spec.runtimeDir}-broker/http.sock`,
      `127.0.0.1:3129:${spec.runtimeDir}-broker/proxy.sock`,
    ])
  })

  it('opens only the first when there is nowhere to tunnel to', () => {
    const args = Vm.tetherOptions({ ...spec, tunnel: [] })
    assert.strictEqual(args.filter(arg => arg === '-R').length, 1)
  })

  it('opens both when any name may be reached', () => {
    const args = Vm.tetherOptions({ ...spec, tunnel: 'any' })
    assert.strictEqual(args.filter(arg => arg === '-R').length, 2)
  })

  it('opens both for a name the broker answers, with nowhere to tunnel to', () => {
    const args = Vm.tetherOptions({
      ...spec,
      grants: [{ credential: 'GITHUB_TOKEN', profile: 'github-git', repos: ['you/api'] }],
      tunnel: [],
    })
    assert.strictEqual(args.filter(arg => arg === '-R').length, 2)
  })
})

// it.live throughout: the socket and readiness loops use real `Effect.sleep`,
// which it.effect's TestClock would freeze — the loops would exhaust their
// attempts before the fake virtiofsd got anywhere.
describe('Vm.up', () => {
  it.live(
    'builds, starts both units, waits for the guest, and powers off',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const fakes = yield* writeFakes(dir, { sshRefusals: 2 })
        const spec = specIn(dir, 'selftest-boot')
        yield* Effect.addFinalizer(() => Systemd.stopSlice('systemctl', sliceOf(spec)))

        yield* Vm.up(fakes.binaries, spec)

        // One daemon per share, each under its own unit, and QEMU only after
        // every socket is bound.
        for (const tag of ['ro-store', 'workspace']) {
          assert.isTrue(
            yield* Systemd.isActive('systemctl', `igloo-${spec.id}-virtiofsd-${tag}.service`),
            `${tag} daemon is not active`,
          )
          assert.isTrue(
            yield* fs.exists(`${spec.runtimeDir}/igloo-test-virtiofs-${tag}.sock`),
            `${tag} socket was never bound`,
          )
        }
        assert.isTrue(yield* Systemd.isActive('systemctl', `igloo-${spec.id}-qemu.service`))
        // QEMU's unit started confined, and from inside it neither the project
        // nor a file in the home directory was there.
        assert.strictEqual(yield* fs.readFileString(`${spec.runtimeDir}/sight`), '')

        // Only the store's daemon runs under the helper. The restricted view
        // exists to stop the guest seeing the whole host store; restricting a
        // share of the project's own directory would do nothing and hide the
        // difference between the two cases.
        const wrapped = (yield* fs.readFileString(fakes.storeViewLog)).trim().split('\n')
        assert.lengthOf(wrapped, 1)
        assert.include(wrapped[0] ?? '', 'ro-store')
        assert.include(wrapped[0] ?? '', '--shared-dir=/nix/store')
        // And it is given the runner's closure — exactly what `nix path-info`
        // answered, one path to a line.
        assert.strictEqual(
          yield* fs.readFileString(fakes.storeViewPaths),
          '/nix/store/aaa\n/nix/store/bbb\n',
        )
        // The readiness probe retried rather than accepting the first answer.
        assert.strictEqual((yield* fs.readFileString(fakes.sshCount)).length, 3)
        // The gc-root pins the closure for as long as the VM runs, and it is in
        // the project rather than on the tmpfs, so a warm second boot — which
        // skips the build — is still pinned by something.
        assert.strictEqual(yield* fs.realPath(spec.runnerRootLink), fakes.store)
        // The logs are in the project too: a serial.log that vanishes on reboot
        // is exactly the one you want after a boot failure. It is in this
        // boot's own directory, reachable through `latest` without knowing the
        // id, and the summary beside it says how the launch went.
        assert.isTrue(yield* fs.exists(`${spec.logDir}/${BootLog.LATEST}/serial.log`))
        const summary = yield* Schema.decodeEffect(BootLog.SummaryJson)(
          yield* fs.readFileString(`${spec.logDir}/${BootLog.LATEST}/boot.json`),
        )
        assert.strictEqual(summary.outcome, 'success')
        // Every step of a real launch is timed, and the guest's own phase is
        // the one the readiness loop spent its time in.
        const phases = summary.phases
        assert.deepStrictEqual(
          phases.map(entry => entry.name),
          ['evaluate', 'plan', 'build', 'closure', 'virtiofsd', 'guest'],
        )
        assert.isTrue(phases.every(entry => entry.ok))

        yield* Vm.down(fakes.binaries, spec)
        assert.isFalse(yield* Systemd.isActive('systemctl', `igloo-${spec.id}-qemu.service`))
        // Powered off over QMP rather than killed, which also proves the unit's
        // main process is the one listening — the only peer `down` will speak
        // to — under the confinement's PID namespace.
        assert.isTrue(yield* fs.exists(`${spec.runtimeDir}/poweroff`))
        // And by `down` itself: the runner is built from the VM's
        // configuration, and nothing in it runs outside QEMU's unit.
        assert.isFalse(yield* fs.exists(fakes.shutdownHelperRan))
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    30_000,
  )

  it.live(
    'starts no tether for a VM with no broker',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const fakes = yield* writeFakes(dir)
        const spec = specIn(dir, 'selftest-no-tether')
        yield* Effect.addFinalizer(() => Systemd.stopSlice('systemctl', sliceOf(spec)))

        yield* Vm.up(fakes.binaries, spec)

        // The tether is the only route to a broker, so a VM that declared none
        // must not have one opened on its behalf.
        assert.isFalse(yield* Systemd.isActive('systemctl', `igloo-${spec.id}-tether.service`))
        yield* Vm.down(fakes.binaries, spec)
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    30_000,
  )

  it.live(
    'tethers a broker VM to the guest it was opened against',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        // The runtime directory is under XDG_RUNTIME_DIR rather than in the
        // temp directory, because that is where the CLI puts it: the broker's
        // unit finds /run/user empty, and its own directory has to be bound
        // back in from there.
        const runtimeDir = `${process.env['XDG_RUNTIME_DIR'] ?? '/run/user/0'}/igloo-selftest-tether`
        const fakes = yield* writeFakes(dir, { runtimeDir })
        // Outside the temp directory, so nothing else removes them.
        yield* Effect.addFinalizer(() =>
          Effect.forEach([runtimeDir, `${runtimeDir}-broker`], stale =>
            fs.remove(stale, { recursive: true }).pipe(Effect.ignore),
          ),
        )
        // A brokered credential, which must reach the broker and must not reach
        // the guest. The same declaration shape as a delivered one; only the
        // reader differs.
        const sourceFile = `${dir}/token-source`
        yield* fs.writeFileString(sourceFile, 'sk-the-actual-secret')
        const spec = {
          ...specIn(dir, 'selftest-tether'),
          broker: true,
          brokered: [
            {
              cwd: dir,
              hostPath: `${runtimeDir}/broker-credentials/GITHUB_TOKEN`,
              name: 'GITHUB_TOKEN',
              source: { _tag: 'File', path: sourceFile } as const,
            },
          ],
          runtimeDir,
        }
        yield* Effect.addFinalizer(() => Systemd.stopSlice('systemctl', sliceOf(spec)))

        yield* Vm.up(fakes.binaries, spec)

        // The handoff, end to end: the value went in as a file the unit loaded,
        // and the broker reports holding it by name.
        const log = yield* fs.readFileString(`${spec.logDir}/${BootLog.LATEST}/broker.log`)
        assert.include(log, 'GITHUB_TOKEN')
        assert.notInclude(log, 'sk-the-actual-secret', 'the broker logged a credential value')
        // And QEMU, which shares the runtime directory the value was handed over
        // through, could not read it there.
        assert.isTrue(yield* fs.exists(`${runtimeDir}/broker-credentials/GITHUB_TOKEN`))
        assert.strictEqual(yield* fs.readFileString(`${runtimeDir}/sight`), '')

        // The broker comes up before the tether: a forward opened ahead of the
        // socket gives the guest a port whose every connection is refused.
        const brokerService = `igloo-${spec.id}-broker.service`
        assert.isTrue(yield* Systemd.isActive('systemctl', brokerService))
        assert.isTrue(
          yield* fs.exists(`${runtimeDir}-broker/http.sock`),
          'the broker bound no socket',
        )
        // From inside its unit, none of what it was looked for: not the VM's
        // runtime directory, the project, or the user manager's socket.
        assert.strictEqual(yield* fs.readFileString(`${runtimeDir}-broker/sight`), '')
        // No memory bound without policy, and first to go when memory runs out.
        const bounds = yield* Systemd.show('systemctl', brokerService, [
          'MemoryMax',
          'OOMScoreAdjust',
        ])
        assert.strictEqual(bounds.get('MemoryMax'), 'infinity')
        assert.strictEqual(bounds.get('OOMScoreAdjust'), '1000')

        const tether = `igloo-${spec.id}-tether.service`
        assert.isTrue(yield* Systemd.isActive('systemctl', tether))
        // From inside its unit, the key it was handed and the broker's socket,
        // and nothing else it was looked for: not the key where the project
        // keeps it, the project, a file in the home directory, the VM's runtime
        // directory or the brokered credential in it.
        assert.deepStrictEqual(
          (yield* fs.readFileString(`${spec.logDir}/${BootLog.LATEST}/tether.log`))
            .trim()
            .split('\n'),
          ['sees its identity', "sees the broker's socket"],
        )

        // Bound to QEMU's unit, so it cannot outlive the incarnation it was
        // opened against — a tether against a dead guest is a process holding a
        // socket nothing answers.
        const properties = yield* Systemd.show('systemctl', tether, ['After', 'BindsTo'])
        assert.include(properties.get('BindsTo') ?? '', `igloo-${spec.id}-qemu.service`)
        assert.include(properties.get('After') ?? '', `igloo-${spec.id}-qemu.service`)

        yield* Vm.down(fakes.binaries, spec)
        assert.isTrue(yield* Systemd.awaitInactive('systemctl', tether, '10 seconds'))
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    30_000,
  )

  it.live(
    'empties the runtime directory a previous run left, before writing into it',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const fakes = yield* writeFakes(dir)
        const spec = specIn(dir, 'selftest-stale')
        yield* Effect.addFinalizer(() => Systemd.stopSlice('systemctl', sliceOf(spec)))

        // The directory's path is stable, so a crashed run leaves its socket
        // here. Left in place it satisfies the readiness poll at once and QEMU
        // goes on to connect to nothing.
        const sock = `${spec.runtimeDir}/igloo-test-virtiofs-ro-store.sock`
        yield* fs.makeDirectory(spec.runtimeDir, { recursive: true })
        yield* fs.writeFileString(sock, 'stale\n')
        // And QEMU's unit can write here, so an entry may be a symlink placed
        // where this launch is about to write — here, the list of store paths
        // the store's daemon serves — pointing at a file of the user's.
        const victim = `${dir}/victim`
        yield* fs.writeFileString(victim, 'the user’s own')
        yield* fs.symlink(victim, `${spec.runtimeDir}/store-paths`)

        yield* Vm.up(fakes.binaries, spec)

        assert.strictEqual((yield* fs.readFileString(sock)).trim(), 'fresh')
        assert.strictEqual(yield* fs.readFileString(victim), 'the user’s own')
        assert.strictEqual(
          yield* fs.readFileString(`${spec.runtimeDir}/store-paths`),
          '/nix/store/aaa\n/nix/store/bbb\n',
        )
        yield* Vm.down(fakes.binaries, spec)
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    30_000,
  )

  it.live(
    'evaluates once, confined to what the spec allows, and builds the derivation it checked',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const fakes = yield* writeFakes(dir)
        const spec = {
          ...specIn(dir, 'selftest-confined'),
          evaluation: {
            paths: ['/nix/store', `${dir}/project/igloo.nix`],
            uris: ['github:NixOS/nixpkgs'],
          },
        }
        yield* Effect.addFinalizer(() => Systemd.stopSlice('systemctl', sliceOf(spec)))

        yield* Vm.up(fakes.binaries, spec)
        yield* Vm.down(fakes.binaries, spec)

        // The evaluation is where the content layers run, so this call is the
        // one the confinement has to reach, not only the function that renders
        // it.
        const evaluated = (yield* fs.readFileString(fakes.evalArgs)).split('\n')
        const option = (name: string) => evaluated[evaluated.indexOf(name) + 1]
        assert.include(evaluated, spec.flakeRef)
        assert.strictEqual(option('restrict-eval'), 'true')
        assert.strictEqual(option('allowed-uris'), 'github:NixOS/nixpkgs')
        assert.include(evaluated, `igloo-allowed-1=${dir}/project/igloo.nix`)

        // What the dry run listed is what was shown and checked.
        assert.deepStrictEqual((yield* fs.readFileString(fakes.showArgs)).trim().split('\n'), [
          'derivation',
          'show',
          runnerDrv,
        ])

        // The build is of that derivation, with nothing left to evaluate: a
        // second evaluation could see a workspace the check never did. And a
        // fixed output let through as fetchable is never built instead.
        const built = (yield* fs.readFileString(fakes.buildArgs)).split('\n')
        assert.strictEqual(built[1], `${runnerDrv}^*`)
        assert.notInclude(built, spec.flakeRef)
        assert.notInclude(built, '--impure')
        assert.strictEqual(built[built.indexOf('fallback') + 1], 'false')
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    30_000,
  )

  it.live(
    'refuses a runner whose build would run a fixed output, and builds nothing',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const fetcher = '/nix/store/11111111111111111111111111111111-probe-fod.drv'
        const fakes = yield* writeFakes(dir, {
          plan: `these 2 derivations will be built:\n  ${fetcher}\n  ${runnerDrv}\n`,
          shown: yield* json({
            derivations: {
              '11111111111111111111111111111111-probe-fod.drv': {
                env: { out: '/nix/store/22222222222222222222222222222222-probe-fod' },
                outputs: { out: { hash: 'sha256-AAAA', method: 'flat' } },
              },
              '00000000000000000000000000000000-runner.drv': {
                env: { out: '/nix/store/00000000000000000000000000000000-runner' },
                outputs: { out: { path: '00000000000000000000000000000000-runner' } },
              },
            },
            version: 4,
          }),
        })
        const spec = specIn(dir, 'selftest-refused')
        yield* Effect.addFinalizer(() => Systemd.stopSlice('systemctl', sliceOf(spec)))

        const result = yield* Effect.result(Vm.up(fakes.binaries, spec))

        assert.isTrue(Result.isFailure(result))
        const message = Result.isFailure(result) ? result.failure.message : ''
        assert.include(message, `${fetcher}: a fixed output`)
        assert.include(message, `'${fetcher}^*'`)
        assert.notInclude(message, `${runnerDrv}:`)
        assert.isFalse(yield* fs.exists(fakes.buildCount))
        assert.isFalse(yield* Systemd.isActive('systemctl', `igloo-${spec.id}-qemu.service`))
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    30_000,
  )

  it.live(
    'refuses a plan that does not list a runner that is not built, rather than building unchecked',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        // A nix whose dry run prints its plan in a form this does not read.
        const fakes = yield* writeFakes(dir, {
          plan: `will build 1 derivation: ${runnerDrv}\n`,
        })
        const spec = specIn(dir, 'selftest-unread')
        yield* Effect.addFinalizer(() => Systemd.stopSlice('systemctl', sliceOf(spec)))

        const result = yield* Effect.result(Vm.up(fakes.binaries, spec))

        assert.isTrue(Result.isFailure(result))
        assert.include(Result.isFailure(result) ? result.failure.message : '', 'does not read')
        assert.isFalse(yield* fs.exists(fakes.buildCount))
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    30_000,
  )

  it.live(
    'launches a runner that is already built, with nothing to check',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const fakes = yield* writeFakes(dir, { plan: '', runnerBuilt: true })
        const spec = specIn(dir, 'selftest-built')
        yield* Effect.addFinalizer(() => Systemd.stopSlice('systemctl', sliceOf(spec)))

        yield* Vm.up(fakes.binaries, spec)
        yield* Vm.down(fakes.binaries, spec)

        assert.isFalse(yield* fs.exists(fakes.showArgs))
        assert.strictEqual(yield* fs.readFileString(fakes.buildCount), 'x')
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    30_000,
  )

  it.live(
    'is idempotent against a VM that is already running',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const fakes = yield* writeFakes(dir)
        const spec = specIn(dir, 'selftest-idem')
        yield* Effect.addFinalizer(() => Systemd.stopSlice('systemctl', sliceOf(spec)))

        yield* Vm.up(fakes.binaries, spec)
        const booted = yield* fs.readLink(`${spec.logDir}/${BootLog.LATEST}`)
        yield* Vm.up(fakes.binaries, spec)

        // The second `up` neither rebuilt nor started anything — it found the VM
        // running and only confirmed the channel still answers.
        assert.strictEqual(yield* fs.readFileString(fakes.buildCount), 'x')
        // So it left no record either: what every `attach` after the first
        // does, and twenty of them would otherwise have pruned the boot's own.
        assert.deepStrictEqual(yield* bootDirs(spec.logDir), [booted])
        assert.strictEqual(yield* fs.readLink(`${spec.logDir}/${BootLog.LATEST}`), booted)
        // Its trail is still the boot's, with no drift report added, because
        // nothing had changed. A report on every launch is one nobody reads by
        // the third time.
        const trail = yield* fs.readFileString(`${spec.logDir}/${booted}/boot.jsonl`)
        assert.notInclude(trail, 'launched before')

        yield* Vm.down(fakes.binaries, spec)
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    30_000,
  )

  it.live(
    'publishes a port, and refuses to launch when the host port is taken',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const fakes = yield* writeFakes(dir)

        // A real listener on a real port, so the collision is the one a second
        // project would hit rather than a simulated one. Held open for the
        // first launch and released for the second.
        const held = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } })
        const taken = held.port
        const spec = { ...specIn(dir, 'selftest-ports'), ports: [{ guest: 5173, host: taken }] }
        yield* Effect.addFinalizer(() => Systemd.stopSlice('systemctl', sliceOf(spec)))

        const blocked = yield* Vm.up(fakes.binaries, spec).pipe(Effect.result)
        assert.strictEqual(blocked._tag, 'Failure')
        // By number, and with the remedy: a message that says only "a port is
        // in use" leaves the reader to work out which of their ports it was.
        const message = blocked._tag === 'Failure' ? blocked.failure.message : ''
        assert.include(message, String(taken))
        assert.include(message, 'host = ')
        // The message names no file, so the failure carries the record's path.
        const record =
          Result.isFailure(blocked) && 'bootRecord' in blocked.failure
            ? blocked.failure.bootRecord
            : undefined
        assert.isTrue(record?.startsWith(spec.logDir))
        // Nothing was published, which is the other half of refusing.
        assert.isFalse(yield* Systemd.isActive('systemctl', `igloo-${spec.id}-ports.service`))

        held.stop(true)
        yield* Vm.up(fakes.binaries, spec)
        assert.isTrue(yield* Systemd.isActive('systemctl', `igloo-${spec.id}-ports.service`))

        // Connect immediately rather than retrying: `up` returning is the claim
        // that the port is there, and a unit that is running is not that claim.
        const published = yield* Effect.promise(() =>
          Bun.connect({ hostname: '127.0.0.1', port: taken, socket: { data: () => {} } }),
        )
        published.end()
        // Listening on the host's loopback from a unit that sees its key and
        // nothing else it was looked for.
        assert.deepStrictEqual(
          (yield* fs.readFileString(`${spec.logDir}/${BootLog.LATEST}/ports.log`)).trim(),
          'sees its identity',
        )

        yield* Vm.down(fakes.binaries, spec)
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    30_000,
  )

  it.live(
    'keeps the record of an up that restarts a forward, which logs into it',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const fakes = yield* writeFakes(dir)
        const free = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } })
        const port = free.port
        free.stop(true)
        const spec = { ...specIn(dir, 'selftest-restart'), ports: [{ guest: 5173, host: port }] }
        yield* Effect.addFinalizer(() => Systemd.stopSlice('systemctl', sliceOf(spec)))

        yield* Vm.up(fakes.binaries, spec)
        const booted = yield* fs.readLink(`${spec.logDir}/${BootLog.LATEST}`)
        // The forward goes away while the guest runs, so the next `up` finds the
        // VM up and starts the forward again.
        yield* Systemd.stop('systemctl', `igloo-${spec.id}-ports.service`)
        yield* Vm.up(fakes.binaries, spec)

        // That unit writes into the new record from now on, so removing the
        // record as an idle `up`'s would have taken its log with it.
        const restarted = yield* fs.readLink(`${spec.logDir}/${BootLog.LATEST}`)
        assert.notStrictEqual(restarted, booted)
        assert.deepStrictEqual(yield* bootDirs(spec.logDir), [booted, restarted])
        assert.isTrue(yield* fs.exists(`${spec.logDir}/${restarted}/ports.log`))

        yield* Vm.down(fakes.binaries, spec)
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    30_000,
  )

  it.live(
    'tells a running VM that its configuration has moved on since it started',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const fakes = yield* writeFakes(dir)
        const layer = `${dir}/project/igloo.nix`
        const spec = { ...specIn(dir, 'selftest-drift'), launchInputs: { [layer]: 'before' } }
        yield* Effect.addFinalizer(() => Systemd.stopSlice('systemctl', sliceOf(spec)))

        yield* Vm.up(fakes.binaries, spec)
        yield* Vm.up(fakes.binaries, { ...spec, launchInputs: { [layer]: 'after' } })

        // `up` against a running VM rebuilds nothing by design, so an edited
        // layer takes effect only at the next `down`. Unsaid, that is a guest
        // quietly running older configuration than the file the author is
        // reading.
        assert.strictEqual(yield* fs.readFileString(fakes.buildCount), 'x')
        const trail = yield* fs.readFileString(`${spec.logDir}/latest/boot.jsonl`)
        assert.include(trail, 'launched before')
        // Naming the file is the whole point: "something changed" leaves the
        // reader with every layer to check.
        assert.include(trail, layer)

        yield* Vm.down(fakes.binaries, spec)
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    30_000,
  )

  it.live(
    'fails as soon as virtiofsd exits instead of waiting out the budget',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        // A virtiofsd that exits instead of binding its socket. Without the
        // liveness check the wait would sit out its full 10s and then report a
        // slow socket, which sends the reader to the wrong log.
        const fakes = yield* writeFakes(dir, { virtiofsdFails: true })
        const spec = specIn(dir, 'selftest-vfsd-dies')
        yield* Effect.addFinalizer(() => Systemd.stopSlice('systemctl', sliceOf(spec)))

        const started = yield* Clock.currentTimeMillis
        const result = yield* Vm.up(fakes.binaries, spec).pipe(Effect.result)
        const elapsed = (yield* Clock.currentTimeMillis) - started

        assert.strictEqual(result._tag, 'Failure')
        // Names the share, because otherwise the reader has one symptom and a
        // log file per daemon to guess between.
        const message = result._tag === 'Failure' ? result.failure.message : ''
        assert.include(message, 'ro-store')
        assert.include(message, 'exited during startup')
        // It points at a log inside the record already, so it is not named twice.
        assert.isFalse(Result.isFailure(result) && 'bootRecord' in result.failure)
        // Well inside the 10s the socket poll would otherwise have taken.
        assert.isTrue(elapsed < 5_000, `took ${elapsed}ms`)
        // Nothing was left half-started: QEMU is never reached.
        assert.isFalse(yield* Systemd.isActive('systemctl', `igloo-${spec.id}-qemu.service`))
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    30_000,
  )
})

/** Kill a VM's broker outright, as the kernel does when memory runs out. */
const killBroker = (spec: VmSpec) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    yield* spawner.exitCode(
      ChildProcess.make('systemctl', [
        '--user',
        'kill',
        '--signal=SIGKILL',
        `igloo-${spec.id}-broker.service`,
      ]),
    )
  })

/** The broker's answer to a request on its socket, or its error. */
const brokerAnswer = (runtimeDir: string): Promise<string> =>
  // oxlint-disable-next-line effecttsgo/global-fetch -- Bun's `unix` option, which HttpClient does not pass on
  fetch('http://broker/github.com/someone/else/info/refs?service=git-upload-pack', {
    unix: `${runtimeDir}-broker/http.sock`,
  }).then(
    response => String(response.status),
    (error: unknown) => String(error),
  )

const askBroker = (runtimeDir: string): Effect.Effect<string> =>
  Effect.promise(() => brokerAnswer(runtimeDir))

describe('Vm, when the broker is killed', () => {
  it.live(
    'starts it again, and says so; past its start limit, says it stopped, and up starts it',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        // Under XDG_RUNTIME_DIR, for the reason the tether's test gives.
        const runtimeDir = `${process.env['XDG_RUNTIME_DIR'] ?? '/run/user/0'}/igloo-selftest-killed`
        const fakes = yield* writeFakes(dir, { runtimeDir })
        yield* Effect.addFinalizer(() =>
          Effect.forEach([runtimeDir, `${runtimeDir}-broker`], stale =>
            fs.remove(stale, { recursive: true }).pipe(Effect.ignore),
          ),
        )
        const sourceFile = `${dir}/token-source`
        yield* fs.writeFileString(sourceFile, 'sk-the-actual-secret')
        // A git grant's host is answered over TLS, so the broker is handed a
        // certificate and its key beside the credential, as `up` hands them.
        const tls = yield* Tls.ensure(`${dir}/tls`, ['github.com'])
        const spec = {
          ...specIn(dir, 'selftest-killed'),
          broker: true,
          brokerTls: { certificate: tls.certificate, key: tls.key },
          brokered: [
            {
              cwd: dir,
              hostPath: `${runtimeDir}/broker-credentials/GITHUB_TOKEN`,
              name: 'GITHUB_TOKEN',
              source: { _tag: 'File', path: sourceFile } as const,
            },
          ],
          grants: [
            { credential: 'GITHUB_TOKEN', profile: 'github-git', repos: ['you/api'] } as const,
          ],
          runtimeDir,
        }
        yield* Effect.addFinalizer(() => Systemd.stopSlice('systemctl', sliceOf(spec)))
        const listedBroker = () =>
          Vm.list(fakes.binaries).pipe(Effect.map(vms => vms.find(vm => vm.id === spec.id)?.broker))

        yield* Vm.up(fakes.binaries, spec)
        assert.deepStrictEqual(yield* listedBroker(), {
          oomKills: 0,
          restarts: 0,
          state: 'running',
        })
        assert.isTrue(
          yield* fs.exists(`${runtimeDir}-broker/tls.sock`),
          'the broker answers no name over TLS',
        )

        // Killed once: its unit starts it again where the last one left its
        // sockets, and it answers on the socket the tether forwards to.
        yield* killBroker(spec)
        let answer = ''
        for (let attempt = 0; attempt < 40 && answer !== '403'; attempt++) {
          yield* Effect.sleep('250 millis')
          answer = yield* askBroker(runtimeDir)
        }
        assert.strictEqual(answer, '403')
        assert.deepStrictEqual(yield* listedBroker(), {
          oomKills: 0,
          restarts: 1,
          state: 'running',
        })

        // Killed as often as it comes back, until its unit gives up.
        let broker = yield* listedBroker()
        for (let attempt = 0; attempt < 120 && broker?.state !== 'stopped'; attempt++) {
          if (broker?.state === 'running') yield* killBroker(spec)
          yield* Effect.sleep('250 millis')
          broker = yield* listedBroker()
        }
        assert.strictEqual(broker?.state, 'stopped')

        // And `up` against the running VM starts it once more.
        yield* Vm.up(fakes.binaries, spec)
        assert.strictEqual((yield* listedBroker())?.state, 'running')
        assert.strictEqual(yield* askBroker(runtimeDir), '403')
        yield* Vm.down(fakes.binaries, spec)
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    90_000,
  )
})

describe('Vm.list', () => {
  it.live(
    'finds a running VM by its slice and reports what it was started with',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const fakes = yield* writeFakes(dir)
        // A hyphenated label and a CID whose hex has letters in it: both halves of
        // the id have to survive the slice-name escaping and come back out.
        const spec = specIn(dir, 'selftest-list-vm', 0x1f2a3b)
        yield* Effect.addFinalizer(() => Systemd.stopSlice('systemctl', sliceOf(spec)))

        yield* Vm.up(fakes.binaries, spec)

        // Other VMs may be up — the suite's own, or the caller's — so this is a
        // lookup, not an assertion about the whole list.
        const listed = (yield* Vm.list(fakes.binaries)).find(vm => vm.id === spec.id)
        assert.isDefined(listed)
        assert.strictEqual(listed.state, 'running')
        assert.strictEqual(listed.slice, `${sliceOf(spec)}.slice`)
        assert.strictEqual(listed.label, spec.label)
        // Read back off the slice name rather than recomputed, which is what makes
        // it right for a VM started with an explicit `--cid`.
        assert.strictEqual(listed.cid, spec.cid)
        assert.strictEqual(listed.projectRoot, spec.projectRoot)
        // The figures decision 1 turns on: the slice's own cgroup accounting.
        assert.isTrue((listed.memoryBytes ?? 0) > 0, `memory was ${String(listed.memoryBytes)}`)
        assert.isTrue((listed.uptimeMillis ?? -1) >= 0, `uptime was ${String(listed.uptimeMillis)}`)

        yield* Vm.down(fakes.binaries, spec)
        // A stopped VM is absent rather than listed as inactive.
        assert.isUndefined((yield* Vm.list(fakes.binaries)).find(vm => vm.id === spec.id))
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    30_000,
  )

  it.live(
    'reports a project root containing a space and a colon unaltered',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const fakes = yield* writeFakes(dir)
        const base = specIn(dir, 'selftest-list-odd')
        // Both are legal in a path and both are separators somewhere in the
        // description format, so this is the case that would silently truncate.
        const spec = { ...base, projectRoot: '/home/someone/my projects/a:b' }
        yield* Effect.addFinalizer(() => Systemd.stopSlice('systemctl', sliceOf(spec)))

        yield* Vm.up(fakes.binaries, spec)

        const listed = (yield* Vm.list(fakes.binaries)).find(vm => vm.id === spec.id)
        assert.isDefined(listed)
        assert.strictEqual(listed.projectRoot, spec.projectRoot)

        yield* Vm.down(fakes.binaries, spec)
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    30_000,
  )

  it.live(
    'sends nothing through a control socket that leads to another listener, and still stops the VM',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const fakes = yield* writeFakes(dir)
        const spec = specIn(dir, 'selftest-qmp-peer')
        yield* Effect.addFinalizer(() => Systemd.stopSlice('systemctl', sliceOf(spec)))

        yield* Vm.up(fakes.binaries, spec)

        // What a QEMU the guest has escaped into can do with the directory it
        // writes: swap its control socket for a symlink to another VM's. This
        // process stands in for the other VM's QEMU, and speaks QMP as it would,
        // so that a client which asked nothing about its peer would get as far
        // as powering it off.
        let received = 0
        const other = Bun.listen({
          socket: {
            data: (socket, data) => {
              received += data.length
              socket.write('{"return": {}}\r\n')
            },
            open: socket => {
              socket.write('{"QMP": {"version": {}, "capabilities": []}}\r\n')
            },
          },
          unix: `${dir}/other.sock`,
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => other.stop(true)))
        yield* fs.remove(`${spec.runtimeDir}/control.socket`)
        yield* fs.symlink(`${dir}/other.sock`, `${spec.runtimeDir}/control.socket`)

        yield* Vm.down(fakes.binaries, spec)

        assert.strictEqual(received, 0)
        // This VM's own QEMU was not asked either, so its cgroup was killed.
        assert.isFalse(yield* fs.exists(`${spec.runtimeDir}/poweroff`))
        assert.isFalse(yield* Systemd.isActive('systemctl', `igloo-${spec.id}-qemu.service`))
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    30_000,
  )
})
