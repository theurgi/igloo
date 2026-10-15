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
    const args = Evaluation.args({ paths: ['/nix/store', '/p/igloo.nix'], uris: [] })

    assert.deepStrictEqual(
      args.filter((_, index) => args[index - 1] === '-I'),
      ['igloo-allowed-0=/nix/store', 'igloo-allowed-1=/p/igloo.nix'],
    )
  })

  it('allows no URI at all when given none', () => {
    const args = Evaluation.args({ paths: [], uris: [] })
    assert.strictEqual(args[args.indexOf('allowed-uris') + 1], '')
  })
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
  const lock = JSON.stringify({
    nodes: {
      microvm: {
        inputs: { nixpkgs: ['nixpkgs'], spectrum: 'spectrum' },
        locked: { owner: 'microvm-nix', repo: 'microvm.nix', rev: 'abc', type: 'github' },
      },
      nixpkgs: {
        locked: { owner: 'NixOS', repo: 'nixpkgs', rev: 'def', type: 'github' },
      },
      root: { inputs: { microvm: 'microvm', nixpkgs: 'nixpkgs' } },
      spectrum: {
        locked: { rev: '123', type: 'git', url: 'https://spectrum-os.org/git/spectrum' },
      },
      again: {
        locked: { owner: 'NixOS', repo: 'nixpkgs', rev: 'fed', type: 'github' },
      },
    },
    root: 'root',
    version: 7,
  })

  it('allows each GitHub input by its repository, once', () => {
    assert.deepStrictEqual(Evaluation.lockedUris(lock), [
      'github:microvm-nix/microvm.nix',
      'github:NixOS/nixpkgs',
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
          '{"nodes":{"nixpkgs":{"locked":{"owner":"NixOS","repo":"nixpkgs","type":"github"}}}}',
        )

        const allowance = yield* Evaluation.forRunner({
          iglooFlakePath: igloo,
          contentModules: [path.join(project, 'igloo.nix')],
          workspaceDir: path.join(project, 'workspace'),
        })

        assert.deepStrictEqual(allowance, {
          paths: [
            Evaluation.STORE,
            path.join(project, 'igloo.nix'),
            path.join(project, 'workspace'),
          ],
          uris: ['github:NixOS/nixpkgs'],
        })
        // The rest of the project directory holds the VM's private key.
        assert.notInclude(allowance.paths, project)
      }),
    ),
  )
})
