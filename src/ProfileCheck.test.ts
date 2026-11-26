import { assert, describe, it } from '@effect/vitest'
import { Result } from 'effect'
import { readFileSync } from 'node:fs'

import * as ProfileCheck from './ProfileCheck.ts'
import * as Profiles from './Profiles.ts'
import { type Index, type Operation, readIndex } from './SpecIndex.ts'

/**
 * The profiles igloo ships, read as the CLI reads them, from the JSON the
 * package carries: `IGLOO_PROFILES`, which the devshell sets.
 */
const shipped = ((): ReadonlyMap<string, Profiles.Profile> => {
  const file = process.env['IGLOO_PROFILES']
  if (file === undefined || file === '')
    throw new Error('IGLOO_PROFILES is not set: run the tests in `nix develop`')
  return Result.getOrThrow(Profiles.read(file, JSON.parse(readFileSync(file, 'utf8'))))
})()

const ofShipped = (name: string): Profiles.Profile => {
  const profile = shipped.get(name)
  if (profile === undefined) throw new Error(`igloo ships no ${name}`)
  return profile
}

/** A file under `specs/`: an index, or the groups or unallowed writes beside it. */
const specsFile = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../specs/${name}`, import.meta.url), 'utf8'))

/** The groups or unallowed writes checked in under `specs/` as `name`. */
const listsOf = (name: string): Readonly<Record<string, readonly string[]>> => {
  const raw = specsFile(name)
  if (!ProfileCheck.isLists(raw)) throw new Error(`${name} is not lists of strings`)
  return raw
}

const indexOf = (name: string): Index => {
  const read = readIndex(specsFile(`${name}.json`))
  if ('message' in read) throw new Error(read.message)
  return read.index
}

/** A profile as a layer writes one, read as `Profiles.read` reads it. */
const profileOf = (raw: unknown): Profiles.Profile =>
  Result.getOrThrow(Profiles.read('test', { test: raw })).get('test')!

const operation = (fields: Partial<Operation> & Pick<Operation, 'method' | 'path'>): Operation => ({
  group: 'things',
  host: 'api.example.com',
  multiSegment: [],
  operationId: `${fields.method} ${fields.path}`,
  ...fields,
})

const indexWith = (operations: readonly Operation[], paths?: readonly string[]): Index => ({
  operations,
  ...(paths === undefined ? {} : { paths }),
  sha256: '0'.repeat(64),
  source: 'https://example.com/openapi.json',
})

const hostOf = (report: ProfileCheck.Report, host: string): ProfileCheck.HostReport => {
  const found = report.hosts.find(each => each.host === host)
  if (found === undefined) throw new Error(`no report for ${host}`)
  return found
}

const allowedBy = (report: ProfileCheck.Report, host: string, set: string): readonly string[] =>
  (hostOf(report, host).sets.find(each => each.set === set)?.allowed ?? []).map(
    each => each.operation.operationId,
  )

describe('igloo’s runpod against Runpod’s v2 spec', () => {
  const report = ProfileCheck.check('runpod', ofShipped('runpod'), [indexOf('runpod')])
  const text = ProfileCheck.render(report)
  const host = hostOf(report, 'api.runpod.io')

  it('lists what each set allows, by group', () => {
    assert.deepStrictEqual(allowedBy(report, 'api.runpod.io', 'pods'), [
      'createPod',
      'deletePod',
      'updatePod',
      'podAction',
      'execPod',
      'deleteQueuedPod',
    ])
    assert.include(text, '  pods allows 6:\n    Pods (6):\n      POST v2/pods  createPod\n')
  })

  it('lists the writes nothing allows, those left refused among them', () => {
    const unallowed = host.unallowed.map(ProfileCheck.operationText)
    for (const refused of [
      'PUT v2/account/ssh-keys',
      'POST v2/signup/authentication-attempts',
      'POST v2/signup/authentication-attempts/{id}/verify',
      'POST v2/tags',
      'PUT v2/tags/{id}/resources/{resourceType}/{resourceId}',
      'POST v2/cost-centers',
      'POST v2/organization/invites',
      'POST v2/registries/delegations',
    ]) {
      assert.include(unallowed, refused)
    }
    assert.notInclude(unallowed, 'POST v2/pods/{id}/exec')
    assert.include(text, 'writes nothing allows or denies (28):')
    assert.include(text, '      PUT v2/account/ssh-keys  updateSshKeys\n')
  })

  it('says the level each host comes to', () => {
    assert.strictEqual(host.level, 'allow-list')
    assert.include(text, 'api.runpod.io: an allow-list, with every set chosen')
  })

  it('reports a rule the index was not made for as unchecked, and matches every other', () => {
    assert.deepStrictEqual(host.sets.find(each => each.set === 'read')?.outside, ['POST graphql'])
    assert.deepStrictEqual(report.failures, [])
  })

  it('reports a host no spec describes as unchecked, not failed', () => {
    assert.isFalse(hostOf(report, 'api.runpod.ai').checked)
    assert.include(text, 'api.runpod.ai: an allow-list, with every set chosen\n  unchecked:')
  })

  it('passes against the groups and unallowed writes checked in beside the index', () => {
    const reviewed = ProfileCheck.check('runpod', ofShipped('runpod'), [indexOf('runpod')], {
      groups: listsOf('runpod.groups.json'),
      unallowed: listsOf('runpod.unallowed.json'),
    })
    assert.deepStrictEqual(reviewed.failures, [])
  })
})

describe('igloo’s github against GitHub’s spec, with the groups `pulls` is meant to reach', () => {
  const github = ofShipped('github')
  const groups = { pulls: ['pulls', 'reactions'] }

  it('fails without its deny, naming the Codespace a pull request makes', () => {
    const report = ProfileCheck.check('github', { ...github, deny: {} }, [indexOf('github')], {
      groups,
    })
    assert.strictEqual(report.failures.length, 1)
    assert.include(report.failures[0], 'codespaces/create-with-pr-for-authenticated-user')
    assert.include(report.failures[0], 'pulls at api.github.com')
  })

  it('passes with it', () => {
    const report = ProfileCheck.check('github', github, [indexOf('github')], { groups })
    assert.deepStrictEqual(report.failures, [])
    assert.notInclude(
      allowedBy(report, 'api.github.com', 'pulls'),
      'codespaces/create-with-pr-for-authenticated-user',
    )
  })

  it('passes against every group and unallowed write checked in', () => {
    const report = ProfileCheck.check('github', github, [indexOf('github')], {
      groups: listsOf('github.groups.json'),
      unallowed: listsOf('github.unallowed.json'),
    })
    assert.deepStrictEqual(report.failures, [])
  })

  it('asks of a slot that may hold a `/` in both forms', () => {
    const report = ProfileCheck.check('github', github, [indexOf('github')])
    const status = hostOf(report, 'api.github.com')
      .sets.find(each => each.set === 'checks')
      ?.allowed.find(each => each.operation.operationId === 'repos/create-commit-status')
    assert.strictEqual(status?.only, 'one-segment')
    assert.include(
      ProfileCheck.render(report),
      'POST repos/{owner}/{repo}/statuses/{sha}  repos/create-commit-status, only where {sha} is one segment',
    )
  })

  it('checks the asset upload at uploads.github.com, and leaves github.com unchecked', () => {
    const report = ProfileCheck.check('github', github, [indexOf('github')])
    assert.deepStrictEqual(allowedBy(report, 'uploads.github.com', 'releases'), [
      'repos/upload-release-asset',
    ])
    assert.isFalse(hostOf(report, 'github.com').checked)
  })
})

describe('check', () => {
  const things = indexWith([
    operation({ method: 'GET', path: 'v1/things' }),
    operation({ method: 'POST', path: 'v1/things' }),
    operation({ method: 'DELETE', path: 'v1/things/{id}' }),
    operation({ group: 'keys', method: 'POST', path: 'v1/keys' }),
  ])
  const profile = (allow: unknown, deny?: unknown) =>
    profileOf({
      allow,
      ...(deny === undefined ? {} : { deny }),
      hosts: { 'api.example.com': { send: 'bearer' } },
    })

  it('reports a pattern that matches no operation, and fails', () => {
    const report = ProfileCheck.check(
      'test',
      profile({ write: { 'api.example.com': [{ method: 'POST', path: 'v1/thingz' }] } }),
      [things],
    )
    assert.deepStrictEqual(hostOf(report, 'api.example.com').sets[0]?.unmatched, ['POST v1/thingz'])
    assert.deepStrictEqual(report.failures, [
      'write at api.example.com: POST v1/thingz matches no operation',
    ])
    assert.include(ProfileCheck.render(report), '    matching no operation: POST v1/thingz')
  })

  it('reports a deny rule that matches no operation', () => {
    const report = ProfileCheck.check(
      'test',
      profile(
        { all: { 'api.example.com': [{ method: '*', path: '**' }] } },
        {
          'api.example.com': [{ method: 'POST', path: 'v1/key' }],
        },
      ),
      [things],
    )
    assert.deepStrictEqual(hostOf(report, 'api.example.com').denyUnmatched, ['POST v1/key'])
  })

  it('says whether a host is itself, itself less a refusal list, or an allow-list', () => {
    const all = { all: { 'api.example.com': [{ method: '*', path: '**' }] } }
    const deny = { 'api.example.com': [{ method: 'POST', path: 'v1/keys' }] }
    const level = (allow: unknown, refused?: unknown) =>
      hostOf(ProfileCheck.check('test', profile(allow, refused), [things]), 'api.example.com').level
    assert.strictEqual(level(all), 'host')
    assert.strictEqual(level(all, deny), 'host-less-deny')
    assert.strictEqual(
      level({ read: { 'api.example.com': [{ method: 'GET', path: '**' }] } }),
      'allow-list',
    )
  })

  it('counts a write `deny` refuses as decided, and one nothing names as unallowed', () => {
    const host = hostOf(
      ProfileCheck.check(
        'test',
        profile(
          { all: { 'api.example.com': [{ method: 'GET', path: '**' }] } },
          {
            'api.example.com': [{ method: 'POST', path: 'v1/keys' }],
          },
        ),
        [things],
      ),
      'api.example.com',
    )
    assert.deepStrictEqual(host.unallowed.map(ProfileCheck.operationText), [
      'POST v1/things',
      'DELETE v1/things/{id}',
    ])
  })

  it('fails on a write the unallowed list does not name, and on one it names that is not', () => {
    const report = ProfileCheck.check(
      'test',
      profile({ read: { 'api.example.com': [{ method: 'GET', path: '**' }] } }),
      [things],
      {
        unallowed: {
          'api.example.com': ['POST v1/things', 'DELETE v1/things/{id}', 'PUT v1/gone'],
        },
      },
    )
    assert.strictEqual(report.failures.length, 2)
    assert.include(
      report.failures[0],
      'POST v1/keys (POST v1/keys), in keys, is a write nothing allows',
    )
    assert.include(report.failures[1], 'names PUT v1/gone, which is not a write nothing allows')
  })

  it('fails on groups naming a set the profile does not have', () => {
    const report = ProfileCheck.check(
      'test',
      profile({ read: { 'api.example.com': [{ method: 'GET', path: '**' }] } }),
      [things],
      { groups: { read: ['things'], reed: ['things'] } },
    )
    assert.deepStrictEqual(report.failures, [
      "the groups name reed, which is not one of test's sets",
    ])
  })

  it('finds a `*` deny that a slot holding a `/` passes', () => {
    const report = ProfileCheck.check(
      'test',
      profile(
        { all: { 'api.example.com': [{ method: '*', path: '**' }] } },
        {
          'api.example.com': [{ method: 'GET', path: 'v1/files/*' }],
        },
      ),
      [indexWith([operation({ method: 'GET', multiSegment: ['path'], path: 'v1/files/{path}' })])],
    )
    assert.deepStrictEqual(hostOf(report, 'api.example.com').sets[0]?.allowed, [
      {
        only: 'slashed',
        operation: operation({ method: 'GET', multiSegment: ['path'], path: 'v1/files/{path}' }),
      },
    ])
  })

  it('reports a rule outside the paths an index kept as unchecked, not as matching nothing', () => {
    const report = ProfileCheck.check(
      'test',
      profile({
        api: {
          'api.example.com': [
            { method: 'GET', path: 'v1/things' },
            { method: 'POST', path: 'graphql' },
          ],
        },
      }),
      [indexWith(things.operations, ['v1/**'])],
    )
    const set = hostOf(report, 'api.example.com').sets[0]
    assert.deepStrictEqual(set?.outside, ['POST graphql'])
    assert.deepStrictEqual(set?.unmatched, [])
    assert.deepStrictEqual(report.failures, [])
  })
})
