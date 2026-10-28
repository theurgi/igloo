import { BunServices } from '@effect/platform-bun'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Scope } from 'effect'
import * as path from 'node:path'

import * as Evaluation from './Evaluation.ts'

const provided = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(BunServices.layer))

describe('Evaluation.args', () => {
  it('confines the evaluation to what it is given', () => {
    const args = Evaluation.args({
      paths: ['/nix/store', '/home/you/projects/api/igloo.nix'],
      flakes: [],
      uris: ['github:NixOS/nixpkgs', 'github:microvm-nix/microvm.nix'],
    })
    const option = (name: string) => args[args.indexOf(name) + 1]

    // Impure, because pure evaluation ignores `-I` and could not be told which
    // layer files to read; restricted, so that it reads nothing else.
    assert.include(args, '--impure')
    assert.strictEqual(option('restrict-eval'), 'true')
    assert.strictEqual(
      option('allowed-uris'),
      'github:NixOS/nixpkgs github:microvm-nix/microvm.nix',
    )
    assert.strictEqual(option('nix-path'), '')
    assert.strictEqual(option('allow-unsafe-native-code-during-evaluation'), 'false')
    // Import from derivation builds during evaluation, before the check of
    // what the build would run.
    assert.strictEqual(option('allow-import-from-derivation'), 'false')
  })

  it('names every allowed path, so none of them answers a `<name>` lookup', () => {
    const args = Evaluation.args({ paths: ['/nix/store', '/p/igloo.nix'], flakes: [], uris: [] })

    assert.deepStrictEqual(
      args.filter((_, index) => args[index - 1] === '-I'),
      ['igloo-allowed-0=/nix/store', 'igloo-allowed-1=/p/igloo.nix'],
    )
  })

  it('allows no URI at all when given none', () => {
    const args = Evaluation.args({ paths: [], flakes: [], uris: [] })
    assert.strictEqual(args[args.indexOf('allowed-uris') + 1], '')
  })
})

describe('Evaluation.confinement', () => {
  const allowance = {
    paths: ['/nix/store', '/p/igloo.nix', '/p/workspace'],
    flakes: ['/p/.igloo/runner', '/opt/igloo'],
    uris: ['github:NixOS/nixpkgs/def'],
  }
  const rules = Evaluation.confinement(allowance, '/tmp/cache')
  const named = (flag: string) => rules.filter((_, index) => rules[index - 1] === flag)

  it('lets nix read the allowance, the flakes and what it reads of itself', () => {
    assert.deepStrictEqual(named('--read'), [
      '/nix/store',
      '/p/igloo.nix',
      '/p/workspace',
      '/p/.igloo/runner',
      '/opt/igloo',
      '/proc/self/maps',
      '/proc/stat',
    ])
    // Not the directory, which holds nix's environment.
    assert.notInclude(named('--read'), '/proc/self')
  })

  it('lets it write only its cache, and connect only to HTTPS and DNS', () => {
    assert.deepStrictEqual(named('--write'), ['/tmp/cache'])
    assert.deepStrictEqual(named('--connect-tcp'), ['443', '53'])
    assert.deepStrictEqual(named('--bind-tcp'), [])
    assert.strictEqual(rules.at(-1), '--')
  })

  it('reads the store whatever the allowance says, and each path once', () => {
    const reads = Evaluation.confinement(
      { paths: ['/p/x.nix', '/p/x.nix'], flakes: [], uris: [] },
      '/c',
    ).filter((_, index, all) => all[index - 1] === '--read')
    assert.deepStrictEqual(reads, ['/nix/store', '/p/x.nix', '/proc/self/maps', '/proc/stat'])
  })
})

describe('Evaluation.command', () => {
  it.effect('runs nix confined both ways, with a cache that lasts as long as the scope', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const allowance = { paths: ['/nix/store', '/p/igloo.nix'], flakes: [], uris: [] }
      const cache = yield* Effect.scoped(
        Effect.gen(function* () {
          const command = yield* Evaluation.command(
            { landlock: '/l/igloo-landlock', nix: '/n/nix' },
            allowance,
            ['eval', '--expr', '1'],
          )
          assert.strictEqual(command._tag, 'StandardCommand')
          if (command._tag !== 'StandardCommand') return ''
          assert.strictEqual(command.command, '/l/igloo-landlock')
          const end = command.args.indexOf('--')
          const written = command.args[command.args.indexOf('--write') + 1] ?? ''
          assert.deepStrictEqual(
            command.args.slice(0, end + 1),
            Evaluation.confinement(allowance, written),
          )
          assert.deepStrictEqual(command.args.slice(end + 1), [
            '/n/nix',
            'eval',
            '--expr',
            '1',
            ...Evaluation.args(allowance),
          ])
          // nix's cache is the one place it may write, not the developer's.
          assert.strictEqual(command.options.env?.['NIX_CACHE_HOME'], written)
          assert.isTrue(command.options.extendEnv)
          assert.isTrue(yield* fs.exists(written))
          return written
        }),
      )
      assert.isFalse(yield* fs.exists(cache))
    }).pipe(Effect.provide(BunServices.layer)),
  )
})

describe('Evaluation.readable', () => {
  it.effect('always includes the store', () =>
    provided(
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* Evaluation.readable([]), [Evaluation.STORE])
      }),
    ),
  )

  it.effect('allows a symlinked layer by its link and by what it resolves to', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
        const target = path.join(dir, 'elsewhere.nix')
        const link = path.join(dir, 'igloo.nix')
        yield* fs.writeFileString(target, '{ }')
        yield* fs.symlink(target, link)

        const allowed = yield* Evaluation.readable([link])

        // nix checks both, so either one missing refuses the layer.
        assert.include(allowed, link)
        assert.include(allowed, target)
      }),
    ),
  )

  it.effect('keeps a path that does not resolve, and adds nothing for it', () =>
    provided(
      Effect.gen(function* () {
        const allowed = yield* Evaluation.readable(['/nonexistent/igloo.nix'])
        assert.deepStrictEqual(allowed, [Evaluation.STORE, '/nonexistent/igloo.nix'])
      }),
    ),
  )

  it.effect('does not list a path inside the store separately', () =>
    provided(
      Effect.gen(function* () {
        const allowed = yield* Evaluation.readable(['/nix/store/aaa-igloo.nix'])
        assert.deepStrictEqual(allowed, [Evaluation.STORE])
      }),
    ),
  )
})

describe('Evaluation.lockedUris', () => {
  const github = (owner: string, repo: string, rev: string, narHash?: string) => ({
    locked: { lastModified: 1, owner, repo, rev, type: 'github', ...(narHash ? { narHash } : {}) },
  })
  const lock = JSON.stringify({
    nodes: {
      microvm: {
        inputs: { nixpkgs: ['nixpkgs'], spectrum: 'spectrum' },
        ...github(
          'microvm-nix',
          'microvm.nix',
          'abc',
          'sha256-IyOsrL64VjSHJKdzvQQcgNJtrSd4/jDa7vhlFa9libM=',
        ),
      },
      nixpkgs: github(
        'NixOS',
        'nixpkgs',
        'def',
        'sha256-+//7//v/+//7//v/+//7//v/+//7//v/+//7//v/+/8=',
      ),
      root: { inputs: { microvm: 'microvm', nixpkgs: 'nixpkgs' } },
      spectrum: {
        locked: { rev: '123', type: 'git', url: 'https://spectrum-os.org/git/spectrum' },
      },
      again: github(
        'NixOS',
        'nixpkgs',
        'def',
        'sha256-+//7//v/+//7//v/+//7//v/+//7//v/+//7//v/+/8=',
      ),
      unhashed: github('NixOS', 'nix', 'fed'),
    },
    root: 'root',
    version: 7,
  })

  it('allows each GitHub input at its locked revision and hash, once', () => {
    assert.deepStrictEqual(Evaluation.lockedUris(lock), [
      'github:microvm-nix/microvm.nix/abc?narHash=sha256-IyOsrL64VjSHJKdzvQQcgNJtrSd4/jDa7vhlFa9libM%3D',
      'github:NixOS/nixpkgs/def?narHash=sha256-%2B//7//v/%2B//7//v/%2B//7//v/%2B//7//v/%2B//7//v/%2B/8%3D',
    ])
  })

  it('allows nothing for a lock it cannot read', () => {
    assert.deepStrictEqual(Evaluation.lockedUris(''), [])
    assert.deepStrictEqual(Evaluation.lockedUris('{"nodes": 3}'), [])
  })
})

describe('Evaluation.forRunner', () => {
  it.effect('allows the layers, the workspace and what igloo is locked to', () =>
    provided(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
        const igloo = path.join(dir, 'igloo')
        const project = path.join(dir, 'project')
        yield* fs.makeDirectory(igloo)
        yield* fs.makeDirectory(path.join(project, 'workspace'), { recursive: true })
        yield* fs.writeFileString(path.join(project, 'igloo.nix'), '{ }')
        yield* fs.writeFileString(
          path.join(igloo, 'flake.lock'),
          '{"nodes":{"nixpkgs":{"locked":{"narHash":"sha256-AAAA=","owner":"NixOS","repo":"nixpkgs","rev":"def","type":"github"}}}}',
        )

        const allowance = yield* Evaluation.forRunner({
          iglooFlakePath: igloo,
          runnerDir: path.join(project, '.igloo', 'runner'),
          contentModules: [path.join(project, 'igloo.nix')],
          workspaceDir: path.join(project, 'workspace'),
        })

        assert.deepStrictEqual(allowance, {
          paths: [
            Evaluation.STORE,
            path.join(project, 'igloo.nix'),
            path.join(project, 'workspace'),
          ],
          flakes: [path.join(project, '.igloo', 'runner'), igloo],
          uris: ['github:NixOS/nixpkgs/def?narHash=sha256-AAAA%3D'],
        })
        // The rest of the project directory holds the VM's private key.
        assert.notInclude(allowance.paths, project)
        assert.notInclude(allowance.flakes, project)
      }),
    ),
  )
})
