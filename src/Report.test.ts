import { BunServices } from '@effect/platform-bun'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, FileSystem } from 'effect'

import * as Cid from './Cid.ts'
import * as Project from './Project.ts'
import * as Report from './Report.ts'

const home = '/home/alice'
const root = `${home}/src/acme-widgets`
const cid = Cid.forIdentity(root)
const cidHex = cid.toString(16)
const known: Report.Known = {
  home: [home],
  hostName: 'alices-laptop.lan',
  project: { cid, label: 'acme-widgets', root },
  user: 'alice',
}

/** The identifying values of the record below, by what each is. */
const identifying = {
  address: '198.51.100.23',
  cid: String(cid),
  cidHex,
  credential: 'ACME_GITHUB',
  delivered: 'ACME_DEPLOY',
  destination: 'git.acme.example',
  email: 'alice@acme.example',
  home,
  host: 'cache.acme.example',
  hostName: 'alices-laptop',
  label: 'acme-widgets',
  repo: 'acme/secret-sauce',
  root,
  user: 'alice',
} as const

const json = (event: Record<string, unknown>): string => JSON.stringify(event)

/** `boot.json` as `BootLog` writes it. */
const summary = (value: Record<string, unknown>): string =>
  `${JSON.stringify(value, undefined, 2)}\n`

/** A failed launch's record holding each kind of value that identifies, several times over. */
const record: Report.BootRecord = {
  files: [
    {
      name: 'boot.json',
      text: summary({
        bootId: '2026-10-14T09-14-03-512Z-3f9a',
        durationMs: 4100,
        failure: [
          'VmError: nix build exited 1',
          "error: unable to download 'https://cache.acme.example/nix-cache-info': Could not resolve host: cache.acme.example",
          `       while building ${root}/.igloo/runner on alices-laptop for alice@acme.example`,
        ].join('\n'),
        finishedAt: '2026-10-14T09:14:07.612Z',
        outcome: 'failure',
        phases: [{ durationMs: 4000, name: 'build', ok: false }],
        startedAt: '2026-10-14T09:14:03.512Z',
      }),
    },
    {
      name: 'boot.jsonl',
      text: [
        json({ event: 'note', message: `launching acme-widgets from ${root}`, t: '1' }),
        // A delivered credential never reaches the broker, so this note is the
        // only place it is named by what it is.
        json({
          credentials: ['ACME_DEPLOY'],
          event: 'note',
          message: 'delivering 1 credential(s) into the guest: ACME_DEPLOY',
          t: '1',
        }),
        json({ event: 'runner', path: '/nix/store/0abc-microvm-qemu-acme-widgets', t: '2' }),
        json({ event: 'note', message: `booting acme-widgets (cid ${String(cid)})`, t: '2' }),
        // A fallback session's: `scope` here is a unit, not a repository.
        json({
          argv: [
            '/nix/store/0def-bubblewrap/bin/bwrap',
            '--bind',
            `${root}/workspace`,
            '/workspace',
          ],
          event: 'sandbox',
          scope: `igloo-acme-widgets-${cidHex}-fallback.scope`,
          t: '3',
        }),
        '',
      ].join('\n'),
    },
    {
      name: 'broker.log',
      text: [
        json({
          destinations: ['git.acme.example', 'pypi.org'],
          event: 'tunnel-listening',
          socket: `/run/user/1000/igloo/acme-widgets-${cidHex}-broker/proxy.sock`,
          t: '0',
        }),
        json({
          credentials: ['ACME_GITHUB'],
          event: 'listening',
          grants: [
            { credential: 'ACME_GITHUB', profile: 'github-git', repos: ['acme/secret-sauce'] },
          ],
          socket: `/run/user/1000/igloo/acme-widgets-${cidHex}-broker/http.sock`,
          t: '1',
        }),
        json({
          credential: 'ACME_GITHUB',
          event: 'allow',
          host: 'github.com',
          id: 1,
          operation: 'ls-refs',
          scope: 'acme/secret-sauce',
          t: '2',
        }),
        json({
          event: 'error',
          id: 1,
          reason:
            'github.com refused ACME_GITHUB; the credential the host holds is wrong, expired, or not scoped to acme/secret-sauce',
          t: '3',
          upstream: 401,
        }),
        json({
          address: '198.51.100.23',
          event: 'tunnel-open',
          id: 1,
          t: '4',
          target: 'git.acme.example:443',
        }),
        json({
          event: 'tls-listening',
          names: ['github.com'],
          socket: `/run/user/1000/igloo/acme-widgets-${cidHex}-broker/tls.sock`,
          t: '5',
        }),
        json({ answered: true, event: 'tunnel-open', id: 2, t: '6', target: 'github.com:443' }),
        '',
      ].join('\n'),
    },
    {
      name: 'serial.log',
      text: [
        '\u001b[0;32m[  OK  ]\u001b[0m Started getty@tty1.service.',
        // systemd's context for each unit, its probe of the console's size, a
        // query for the terminal's name, and its reset.
        '\u001b]3008;start=b4c4;user=root;hostname=acme-widgets;type=boot\u001b\\[  OK  ] Created slice /.',
        '\u001b7\u001b[32766;32766H\u001b[6n\u001b8\u001bP+q6E616D65\u001b\\Booting initrd of NixOS.',
        '\u001b[r\u001b[H\u001b[3J\u001bcWelcome to NixOS.',
        'acme-widgets login: root (automatic login)',
        'mounted /dev/vda on /nix/store',
        ...Object.values(identifying).map(value => `seen '${value}' here`),
        "git: fatal: unable to access 'https://git.acme.example/acme/secret-sauce.git/': Could not connect to 198.51.100.23",
        '',
      ].join('\n'),
    },
  ],
  id: '2026-10-14T09-14-03-512Z-3f9a',
}

const doctor = [
  '  ok    igloo flake           /nix/store/0ghi-source',
  '  FAIL  user manager lingers  lingering is off, so logging out stops every running VM',
  '        → Add "alice" to `programs.igloo.users` in the NixOS configuration, or run `loginctl enable-linger alice`.',
  `  ok    XDG_RUNTIME_DIR       /run/user/1000 beside ${home}`,
  '',
  '1 of 3 checks failed.',
].join('\n')

const report = Report.render({
  doctor,
  known,
  record,
  revision: undefined,
  version: '0.1.0',
})

/** The broker's log as the report shows it, a JSON value per line. */
const brokerLines = (): Array<Record<string, any>> => {
  const section = report.split('##### `broker.log`')[1]?.split('#####')[0] ?? ''
  return section
    .split('\n')
    .filter(line => line.startsWith('{'))
    .map((line): Record<string, any> => JSON.parse(line))
}

/** What replaced each value of `identifying` in serial.log, by what it is. */
const seen = (): Record<string, string> => {
  const found = [...report.matchAll(/seen '([^']*)' here/g)].map(match => match[1] ?? '')
  return Object.fromEntries(Object.keys(identifying).map((key, at) => [key, found[at] ?? '']))
}

describe('Report.render', () => {
  it('leaves none of the values that identify', () => {
    for (const value of Object.values(identifying)) {
      assert.notInclude(report.toLowerCase(), value.toLowerCase(), value)
    }
  })

  it('replaces each value by one placeholder, wherever it occurs', () => {
    const placeholder = seen()
    assert.deepStrictEqual(placeholder, {
      address: '<address-1>',
      cid: '<cid>',
      cidHex: '<cid>',
      credential: '<credential-2>',
      delivered: '<credential-1>',
      destination: '<destination-1>',
      email: '<email-1>',
      home: '~',
      host: '<host-1>',
      hostName: '<hostname>',
      label: '<project>',
      repo: '<repo-1>',
      root: '<project-root>',
      user: '<user>',
    })

    // In the broker's fields, by what each field holds, the startup lines among them.
    const [tunnel, listening, allow, error, opened, tls, answered] = brokerLines()
    assert.deepStrictEqual(tunnel?.['destinations'], [placeholder.destination, '<destination-2>'])
    assert.include(tunnel?.['socket'], `/${placeholder.label}-${placeholder.cidHex}-broker/`)
    assert.deepStrictEqual(listening?.['credentials'], [placeholder.credential])
    assert.deepStrictEqual(listening?.['grants'], [
      { credential: placeholder.credential, profile: 'github-git', repos: [placeholder.repo] },
    ])
    assert.strictEqual(allow?.['credential'], placeholder.credential)
    assert.strictEqual(allow?.['scope'], placeholder.repo)
    assert.strictEqual(allow?.['host'], 'github.com')
    assert.strictEqual(
      error?.['reason'],
      `github.com refused ${placeholder.credential}; the credential the host holds is wrong, expired, or not scoped to ${placeholder.repo}`,
    )
    assert.strictEqual(opened?.['address'], placeholder.address)
    assert.strictEqual(opened?.['target'], `${placeholder.destination}:443`)
    // The names the broker answers are igloo's own, so they stay.
    assert.deepStrictEqual(tls?.['names'], ['github.com'])
    assert.strictEqual(answered?.['target'], 'github.com:443')

    // In text, inside a JSON string and out of one.
    assert.include(
      report,
      `unable to download 'https://${placeholder.host}/<url-1>': Could not resolve host: ${placeholder.host}`,
    )
    assert.include(
      report,
      `while building ${placeholder.root}/.igloo/runner on ${placeholder.hostName} for ${placeholder.email}`,
    )
    assert.include(report, `launching ${placeholder.label} from ${placeholder.root}`)
    assert.include(
      report,
      `"scope":"igloo-${placeholder.label}-${placeholder.cidHex}-fallback.scope"`,
    )
    assert.include(report, `booting ${placeholder.label} (cid ${placeholder.cid})`)
    assert.include(report, `/nix/store/0abc-microvm-qemu-${placeholder.label}`)
    assert.include(report, `${placeholder.label} login: root`)
    assert.include(
      report,
      `{"credentials":["${placeholder.delivered}"],"event":"note","message":"delivering 1 credential(s) into the guest: ${placeholder.delivered}"`,
    )
    assert.include(report, `Add "${placeholder.user}" to`)
    assert.include(report, `loginctl enable-linger ${placeholder.user}`)
    assert.include(report, `beside ${placeholder.home}`)
    assert.include(
      report,
      `'https://${placeholder.destination}/<url-2>': Could not connect to ${placeholder.address}`,
    )
  })

  it('keeps what identifies nobody', () => {
    assert.include(report, 'mounted /dev/vda on /nix/store')
    assert.include(report, '/nix/store/0ghi-source')
    assert.include(report, 'Started getty@tty1.service.')
    assert.include(report, '/run/user/1000/igloo/')
    // The hosts igloo itself names.
    assert.include(report, '"host":"github.com"')
    // Colour codes, which a pasted report would show as noise.
    assert.notInclude(report, '\u001b')
    // A sequence goes whole, not only the escape that starts it.
    assert.include(report, '\n[  OK  ] Created slice /.\n')
    assert.include(report, '\nBooting initrd of NixOS.\n')
    assert.include(report, '\nWelcome to NixOS.\n')
    assert.notInclude(report, '3008;')
  })

  it('says what it replaced, by kind, and never a value', () => {
    const head = report.split('#### Version')[0] ?? ''
    assert.include(head, '| `<repo-N>` | a repository | 1 |')
    assert.include(head, '| `<destination-N>` | a tunnel destination | 2 |')
    assert.include(head, '| `~` | the home directory | 1 |')
    assert.include(head, 'Read it before you post')
    for (const value of Object.values(identifying)) assert.notInclude(head, value)
  })

  it('leaves a user name that is an ordinary word, and the paths that hold it', () => {
    const ordinary = Report.render({
      doctor: 'loginctl enable-linger dev',
      known: { home: ['/home/dev'], hostName: 'nixos', project: undefined, user: 'dev' },
      record: {
        files: [{ name: 'serial.log', text: 'opened /dev/vda for dev in /home/dev/src\n' }],
        id: 'b',
      },
      revision: 'abc123',
      version: '0.1.0',
    })
    assert.include(ordinary, 'loginctl enable-linger dev')
    assert.include(ordinary, 'opened /dev/vda for dev in ~/src')
    assert.include(ordinary, 'igloo 0.1.0, commit `abc123`')
  })

  it('keeps a host igloo names whole when a value is part of it', () => {
    const named = Report.render({
      doctor: '',
      known: {
        home: [],
        hostName: 'box',
        project: { cid: Cid.forIdentity('/srv/api'), label: 'api', root: '/srv/api' },
        user: undefined,
      },
      record: {
        files: [
          {
            name: 'broker.log',
            text: `${json({ credential: 'github', event: 'allow', host: 'api.anthropic.com' })}\n`,
          },
          { name: 'serial.log', text: 'api calls api.anthropic.com and github.com\n' },
        ],
        id: 'b',
      },
      revision: undefined,
      version: '0.1.0',
    })
    assert.include(named, '<project> calls api.anthropic.com and github.com')
    assert.include(named, '"credential":"<credential-1>"')
  })

  it('cuts the logs of a record too large for one issue body to fit, saying how much it left out', () => {
    const serial = Array.from(
      { length: 4000 },
      (_, at) => `[${String(at).padStart(5, '0')}] alice's guest printed this line`,
    )
    const broker = Array.from({ length: 3000 }, (_, at) =>
      json({ event: 'response', id: at, ms: 3, status: 200, t: String(at) }),
    )
    const large = Report.render({
      doctor,
      known,
      record: {
        files: [
          record.files[0]!,
          { name: 'broker.log', text: `${broker.join('\n')}\n` },
          { name: 'serial.log', text: `${serial.join('\n')}\n` },
          { name: 'tether.log', text: 'Warning: Permanently added the guest\n' },
        ],
        id: record.id,
      },
      revision: undefined,
      version: '0.1.0',
    })
    assert.isAtMost(large.length, Report.budget)
    assert.isAtMost(large.length, 65_536)
    assert.match(large, /\[\d+ lines before these left out\]\n\[\d+\] <user>'s guest/)
    assert.include(large, `[03999] <user>'s guest printed this line`)
    assert.notInclude(large, '[00000]')
    assert.match(large, /\[\d+ lines before these left out\]\n\{"event":"response"/)
    // A small log is shown whole, and the summary always is.
    assert.include(
      large,
      '##### `tether.log`\n\n```text\nWarning: Permanently added the guest\n```',
    )
    assert.include(large, '"outcome": "failure"')
  })
})

describe('Report.run', () => {
  /** A project whose `igloo.nix` does not parse, and the record of the launch that found so. */
  const brokenProject = Effect.fnUntraced(function* () {
    const fs = yield* FileSystem.FileSystem
    const base = yield* fs.makeTempDirectoryScoped()
    const project = yield* Project.init(`${base}/acme-widgets`)
    yield* fs.writeFileString(
      `${project.root}/igloo.nix`,
      '{ pkgs, ... }: { environment.systemPackages = [ pkgs.ripgrep-from-acme\n',
    )
    const id = '2026-10-14T09-14-03-512Z-3f9a'
    const dir = `${project.logDir}/${id}`
    yield* fs.makeDirectory(dir, { recursive: true })
    yield* fs.symlink(id, `${project.logDir}/latest`)
    yield* fs.writeFileString(
      `${dir}/boot.json`,
      summary({
        bootId: id,
        durationMs: 900,
        failure: `ConfigError: evaluating the layers failed: nix exited 1\nerror: syntax error, unexpected end of file, expecting ']'\n       at ${project.root}/igloo.nix:2:1:`,
        finishedAt: '2026-10-14T09:14:04.412Z',
        outcome: 'failure',
        phases: [],
        startedAt: '2026-10-14T09:14:03.512Z',
      }),
    )
    yield* fs.writeFileString(
      `${dir}/boot.jsonl`,
      `${json({ event: 'note', message: `building acme-widgets from ${project.root}`, t: '1' })}\n`,
    )
    return { base, dir, id, project }
  })

  const request = (cwd: string, named?: string): Report.Request => ({
    cwd,
    doctor: 'All 16 checks passed.',
    host: { home: undefined, hostName: 'alices-laptop', user: 'alice' },
    record: named,
    revision: undefined,
    version: '0.1.0',
  })

  it.effect('reports a project whose igloo.nix does not parse, with its boot record', () =>
    Effect.gen(function* () {
      const { id, project } = yield* brokenProject()
      const text = yield* Report.run(request(project.workspaceDir))
      assert.include(text, `#### Boot record \`${id}\``)
      assert.include(text, "expecting ']'\\n       at <project-root>/igloo.nix:2:1:")
      assert.include(text, 'building <project> from <project-root>')
      assert.notInclude(text, project.root)
      assert.notInclude(text, 'acme-widgets')
      // Nix's error is text igloo did not write, so the report asks for a read.
      assert.include(text, 'Read it before you post')
      // It reads no layer: nothing of igloo.nix is in it but its name.
      assert.notInclude(text, 'ripgrep-from-acme')
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect('finds a record by its id, or by its directory from anywhere', () =>
    Effect.gen(function* () {
      const { base, dir, id, project } = yield* brokenProject()
      const byId = yield* Report.run(request(project.root, id))
      assert.include(byId, `#### Boot record \`${id}\``)
      const byDir = yield* Report.run(request(base, dir))
      assert.include(byDir, `#### Boot record \`${id}\``)
      assert.notInclude(byDir, 'acme-widgets')
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect('refuses a record that is not there, by name', () =>
    Effect.gen(function* () {
      const { project } = yield* brokenProject()
      const exit = yield* Report.run(request(project.root, '2020-01-01T00-00-00-000Z-0000')).pipe(
        Effect.exit,
      )
      assert.isTrue(Exit.isFailure(exit))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )

  it.effect('gives the version and doctor alone outside a project', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const outside = yield* fs.makeTempDirectoryScoped()
      const text = yield* Report.run(request(outside))
      assert.include(text, 'igloo 0.1.0, from a build that records no commit')
      assert.include(text, 'All 16 checks passed.')
      assert.match(text, /#### Boot record\n\nNone: no igloo project at or above /)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )
})
