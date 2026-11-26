import { assert, describe, it, vi } from '@effect/vitest'
import { Result } from 'effect'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as connectTls } from 'node:tls'

import * as Broker from './broker.ts'
import * as Profiles from './Profiles.ts'

/**
 * The profiles igloo ships, read as the CLI reads them, from the JSON the
 * package carries: `IGLOO_PROFILES`, which the devshell sets.
 */
const shippedProfiles = (): ReadonlyMap<string, Profiles.Profile> => {
  const file = process.env['IGLOO_PROFILES']
  if (file === undefined || file === '') {
    throw new Error('IGLOO_PROFILES is not set: run the tests in `nix develop`')
  }
  const read = Profiles.read(file, JSON.parse(readFileSync(file, 'utf8')))
  if (Result.isFailure(read)) throw new Error(read.failure)
  return read.success
}

/** The shipped profile `name`. */
const shippedProfile = (name: string): Profiles.Profile => {
  const profile = shippedProfiles().get(name)
  if (profile === undefined) throw new Error(`igloo ships no ${name} profile`)
  return profile
}

/** A grant of the shipped profile `name`, every set chosen, as a credential of the same name would be. */
const shippedGrant = (name: string, credential: string): Broker.ProfileGrant => {
  const profile = shippedProfile(name)
  return { credential, ...Profiles.grantOf(name, profile, Object.keys(profile.allow)) }
}

/**
 * A grant of GitHub's profile as igloo ships it: `repos`, each with its sets,
 * and `sets` for the whole account.
 */
const github = (
  repos: Readonly<Record<string, readonly string[]>> = { 'you/api': ['fetch', 'read'] },
  sets: readonly string[] = ['graphql'],
  credential = 'GITHUB_TOKEN',
): Broker.ProfileGrant => ({
  credential,
  ...Profiles.grantOf('github', shippedProfile('github'), sets, repos),
})

/** Every set of GitHub's that names a repository: what one written to is granted. */
const writes = (): readonly string[] => Profiles.repoSets(shippedProfile('github'))

/** `you/api`, fetched and read, and GraphQL. */
const grants: readonly Broker.Grant[] = [github()]

/** Runpod's profile, as igloo ships it, with every set chosen. */
const runpod: readonly Broker.Grant[] = [shippedGrant('runpod', 'RUNPOD_API_KEY')]

const base = 'http://127.0.0.1:3128'

/** A ref advertisement at github.com, by its name. */
const advertise = (path: string, query = '?service=git-upload-pack', granted = grants) =>
  Broker.decideAddressed(granted, 'GET', `https://github.com${path}${query}`)

/** A fetch or a push at github.com, by its name. */
const fetchPack = (path: string, granted = grants) =>
  Broker.decideAddressed(granted, 'POST', `https://github.com${path}`)

/** The status of a decision, or `'allow'` — enough to assert without a cast. */
const outcome = (decision: Broker.Decision): number | string =>
  decision._tag === 'Deny' ? decision.status : 'allow'

/** The upstream a decision sends to, or `''` for a refusal. */
const upstreamOf = (decision: Broker.Decision): string =>
  decision._tag === 'Deny' ? '' : decision.upstream

describe('git’s reader, on what it permits', () => {
  it('allows the ref advertisement for a repository listed for fetch', () => {
    assert.deepStrictEqual(advertise('/you/api/info/refs'), {
      _tag: 'Profile',
      credential: 'GITHUB_TOKEN',
      git: 'ls-refs',
      host: 'github.com',
      profile: 'github',
      repo: 'you/api',
      rule: 'git fetch',
      send: { basic: 'x-access-token' },
      sendsBody: false,
      set: 'fetch',
      upstream: 'https://github.com/you/api.git/info/refs?service=git-upload-pack',
    })
  })

  it('allows the fetch that follows it', () => {
    const decision = fetchPack('/you/api/git-upload-pack')
    assert.strictEqual(upstreamOf(decision), 'https://github.com/you/api.git/git-upload-pack')
    assert.strictEqual(decision._tag === 'Profile' ? decision.sendsBody : false, true)
  })

  it('treats a `.git` suffix as the same repository, in the request and in the grant', () => {
    // git keeps whatever the remote URL said, and a person writes it either way.
    assert.strictEqual(outcome(advertise('/you/api.git/info/refs')), 'allow')
    assert.strictEqual(
      upstreamOf(
        advertise('/you/api/info/refs', undefined, [github({ 'you/api.git': ['fetch'] })]),
      ),
      'https://github.com/you/api.git/info/refs?service=git-upload-pack',
    )
  })

  it('matches the repository ignoring case, as GitHub does', () => {
    assert.strictEqual(outcome(advertise('/YOU/API/info/refs')), 'allow')
  })

  it('sends the grant’s spelling upstream, never the request’s', () => {
    // The request decides which repository applies and nothing else. A name
    // that reached the upstream URL would be a path this broker never
    // authorized, however carefully the rest of it was checked.
    assert.strictEqual(
      upstreamOf(advertise('/you/api/info/refs', undefined, [github({ 'You/Api': ['fetch'] })])),
      'https://github.com/You/Api.git/info/refs?service=git-upload-pack',
    )
  })

  it('allows a push, at both of its endpoints, for a repository listed for push', () => {
    const pushing = [github({ 'you/api': ['push'] })]
    const refs = advertise('/you/api/info/refs', '?service=git-receive-pack', pushing)
    assert.strictEqual(
      upstreamOf(refs),
      'https://github.com/you/api.git/info/refs?service=git-receive-pack',
    )
    assert.strictEqual(refs._tag === 'Profile' ? refs.git : undefined, 'push-refs')
    assert.strictEqual(
      upstreamOf(fetchPack('/you/api/git-receive-pack', pushing)),
      'https://github.com/you/api.git/git-receive-pack',
    )
    // push alone is not fetch.
    assert.strictEqual(outcome(fetchPack('/you/api/git-upload-pack', pushing)), 403)
  })
})

describe('git’s reader, on what it refuses', () => {
  it('refuses everything when no grant is configured', () => {
    // A 403 rather than a 5xx, which most model clients retry for minutes.
    assert.strictEqual(outcome(Broker.decide([], 'GET', `${base}/github.com/you/api`)), 403)
  })

  it('refuses a repository the grant does not list', () => {
    assert.strictEqual(outcome(advertise('/you/other/info/refs')), 403)
  })

  it('names what a refused request asked for, where its reason repeats it', () => {
    const asked = (decision: Broker.Decision) =>
      decision._tag === 'Deny' ? decision.asked : decision._tag
    assert.deepStrictEqual(asked(advertise('/you/Other/info/refs')), { scope: 'you/other' })
    // A reason that repeats nothing of the request's has nothing to add.
    assert.isUndefined(asked(fetchPack('/you/api/info/refs?service=git-upload-pack')))
  })

  it('refuses a push at both endpoints that request one, saying it may fetch', () => {
    // The advertisement is where git asks whether it may push at all, so
    // refusing only the second one would let a push start and fail late.
    const refs = advertise('/you/api/info/refs', '?service=git-receive-pack')
    assert.strictEqual(outcome(refs), 403)
    assert.strictEqual(
      refs._tag === 'Deny' ? refs.reason : '',
      'this VM may fetch you/api, not push to it',
    )
    assert.strictEqual(outcome(fetchPack('/you/api/git-receive-pack')), 403)
  })

  // A read refused for its shape is sent without the key where the tunnel
  // reaches github.com, and refused where it does not: none reaches it here.
  const unsent = (decision: Broker.Decision) =>
    decision._tag === 'Deny' && decision.reason.startsWith('no grant covers this')
      ? decision.status
      : outcome(decision)

  it('refuses an advertisement with no service, rather than guessing one', () => {
    assert.strictEqual(unsent(advertise('/you/api/info/refs', '')), 403)
    assert.strictEqual(unsent(advertise('/you/api/info/refs', '?service=git-upload-archive')), 403)
  })

  it('refuses a path with more or fewer segments than a repository', () => {
    // This is what makes traversal unreachable: there is one shape, and
    // `/you/api/../../x/info/refs` is not it.
    assert.strictEqual(unsent(advertise('/you/api/extra/info/refs')), 403)
    assert.strictEqual(unsent(advertise('/api/info/refs')), 403)
    assert.strictEqual(unsent(advertise('/you/api/../../x/info/refs')), 403)
  })

  it('refuses percent-encoding rather than deciding what it meant', () => {
    assert.strictEqual(outcome(advertise('/you/%61pi/info/refs')), 400)
    assert.strictEqual(outcome(advertise('/you/api%2f../info/refs')), 400)
  })

  it('refuses an empty path segment', () => {
    assert.strictEqual(unsent(advertise('//you/api/info/refs')), 403)
  })

  it('refuses the right method on the wrong endpoint', () => {
    assert.strictEqual(
      outcome(
        Broker.decideAddressed(
          grants,
          'POST',
          'https://github.com/you/api/info/refs?service=git-upload-pack',
        ),
      ),
      405,
    )
    assert.strictEqual(
      outcome(Broker.decideAddressed(grants, 'GET', 'https://github.com/you/api/git-upload-pack')),
      405,
    )
  })

  it('refuses anything at github.com but git’s endpoints', () => {
    // github.com takes the token for whatever else it serves, which is the
    // reason the rules are of operations and not of hosts.
    assert.strictEqual(outcome(advertise('/you/api/pulls', '')), 403)
    assert.strictEqual(outcome(advertise('/settings/keys', '')), 403)
  })

  it('refuses an unparseable target', () => {
    assert.strictEqual(outcome(Broker.decide(grants, 'GET', 'http://[')), 400)
    assert.strictEqual(outcome(Broker.decideAddressed(grants, 'GET', 'http://[')), 400)
  })

  it('serves no profile host through the path form', () => {
    // A profile's hosts are answered by name alone.
    for (const target of [
      '/github.com/you/api/info/refs?service=git-upload-pack',
      `${base}/api.github.com/repos/you/api`,
      'http://evil.example/github.com/you/api/info/refs?service=git-upload-pack',
    ]) {
      assert.strictEqual(outcome(Broker.decide(grants, 'GET', target)), 404, target)
    }
  })
})

describe('Broker.tlsNames', () => {
  it('answers each host the grant’s sets reach, once', () => {
    assert.deepStrictEqual(Broker.tlsNames(grants), ['api.github.com', 'github.com'])
    assert.deepStrictEqual(Broker.tlsNames([github({ 'you/api': ['fetch', 'releases'] }, [])]), [
      'api.github.com',
      'github.com',
      'uploads.github.com',
    ])
    // A grant choosing no git set leaves github.com unanswered.
    assert.deepStrictEqual(Broker.tlsNames([github({}, ['graphql'])]), ['api.github.com'])
  })

  it('answers nothing for a model server, which is reached by its path', () => {
    assert.deepStrictEqual(Broker.tlsNames(servers), [])
  })

  it('answers each host of every profile grant', () => {
    assert.deepStrictEqual(Broker.tlsNames(runpod), ['api.runpod.ai', 'api.runpod.io'])
    assert.deepStrictEqual(Broker.tlsNames([...grants, ...runpod, ...inference]), [
      'api.github.com',
      'github.com',
      'api.runpod.ai',
      'api.runpod.io',
      'api.anthropic.com',
      'openrouter.ai',
    ])
  })
})

describe('Broker.decideAddressed', () => {
  const addressed = (url: string, method = 'GET', granted = grants) =>
    Broker.decideAddressed(granted, method, url)

  it('reads one trailing dot, and any case, as the same name', () => {
    for (const host of ['github.com.', 'GitHub.com']) {
      assert.strictEqual(
        outcome(addressed(`https://${host}/you/api/info/refs?service=git-upload-pack`)),
        'allow',
        host,
      )
    }
  })

  it('refuses a name no grant is answered at, naming it', () => {
    const refused = addressed('https://gist.github.com/you')
    assert.deepStrictEqual(refused, {
      _tag: 'Deny',
      asked: { host: 'gist.github.com' },
      reason: 'gist.github.com is not answered here for this VM',
      status: 421,
    })
    for (const granted of [[], inference]) {
      assert.strictEqual(
        outcome(
          addressed('https://github.com/you/api/info/refs?service=git-upload-pack', 'GET', granted),
        ),
        421,
      )
    }
  })

  it('keeps every git refusal, a push among them', () => {
    assert.strictEqual(
      outcome(addressed('https://github.com/you/api/info/refs?service=git-receive-pack')),
      403,
    )
    assert.strictEqual(
      outcome(addressed('https://github.com/you/api/git-receive-pack', 'POST')),
      403,
    )
    assert.strictEqual(
      outcome(addressed('https://github.com/someone/else/info/refs?service=git-upload-pack')),
      403,
    )
    assert.strictEqual(
      outcome(addressed('https://github.com/you/api%2Fx/info/refs?service=git-upload-pack')),
      400,
    )
  })

  it('cannot reach another grant’s upstream through the path', () => {
    const decided = addressed('https://github.com/api.anthropic.com/v1/messages', 'POST', [
      ...grants,
      ...inference,
    ])
    assert.strictEqual(decided._tag, 'Deny')
    const across = addressed('https://api.runpod.io/api.github.com/repos/you/api', 'GET', [
      ...grants,
      ...runpod,
    ])
    assert.strictEqual(across._tag, 'Deny')
  })

  it('decides a request addressed to one of Runpod’s names for a runpod grant, and not otherwise', () => {
    assert.deepStrictEqual(addressed('https://api.runpod.io/graphql', 'POST', runpod), {
      _tag: 'Profile',
      credential: 'RUNPOD_API_KEY',
      graphql: { withheld: ['registryAuth'] },
      host: 'api.runpod.io',
      profile: 'runpod',
      rule: 'POST graphql',
      send: 'bearer',
      sendsBody: true,
      set: 'read',
      upstream: 'https://api.runpod.io/graphql',
    })
    assert.strictEqual(outcome(addressed('https://api.runpod.io/v2/pods', 'POST', runpod)), 'allow')
    // A name of Runpod's that the profile does not hold is not answered.
    assert.strictEqual(outcome(addressed('https://rest.runpod.io/v1/pods', 'GET', runpod)), 421)
    assert.strictEqual(
      outcome(addressed('https://api.runpod.ai/v2/ep1/run', 'POST', runpod)),
      'allow',
    )
    assert.strictEqual(
      outcome(addressed('https://api.runpod.io/v2/organization/invites', 'POST', runpod)),
      405,
    )
    for (const granted of [grants, inference, [...grants, ...inference, ...servers]]) {
      assert.strictEqual(outcome(addressed('https://api.runpod.io/graphql', 'POST', granted)), 421)
    }
    // GitHub's names are answered for a github grant alone, beside a runpod one.
    assert.strictEqual(
      outcome(
        addressed('https://github.com/you/api/info/refs?service=git-upload-pack', 'GET', runpod),
      ),
      421,
    )
  })
})

describe('GitHub’s API, through its profile', () => {
  /** `you/api` read and fetched, `You/Web.git` given every set, and GraphQL. */
  const writing = (): readonly Broker.Grant[] => [
    github({ 'You/Web.git': writes(), 'you/api': ['fetch', 'read'] }),
  ]
  const api = (path: string, method = 'GET', granted: readonly Broker.Grant[] = grants) =>
    Broker.decideAddressed(granted, method, `https://api.github.com${path}`)
  const upload = (path: string, method = 'POST') =>
    Broker.decideAddressed(writing(), method, `https://uploads.github.com${path}`)

  it('reads under a repository listed for read, with its credential', () => {
    assert.deepStrictEqual(api('/repos/you/api/actions/runs?per_page=100&status=failure'), {
      _tag: 'Profile',
      credential: 'GITHUB_TOKEN',
      host: 'api.github.com',
      pages: 'github',
      profile: 'github',
      redirects: 'return',
      repo: 'you/api',
      rule: 'GET,HEAD repos/{repo}/**',
      send: 'bearer',
      sendsBody: false,
      set: 'read',
      upstream: 'https://api.github.com/repos/you/api/actions/runs?per_page=100&status=failure',
    })
    assert.strictEqual(outcome(api('/repos/you/api', 'HEAD')), 'allow')
    assert.strictEqual(outcome(api('/repos/You/API/releases/latest')), 'allow')
  })

  it('sends the grant’s spelling upstream, and the query encoded', () => {
    assert.strictEqual(
      upstreamOf(
        api('/repos/owner/repo/issues?q=a b&labels=x,y', 'GET', [
          github({ 'Owner/Repo.git': ['read'] }),
        ]),
      ),
      'https://api.github.com/repos/Owner/Repo/issues?q=a+b&labels=x%2Cy',
    )
  })

  it('cannot leave the repository by its path', () => {
    // The URL parser resolves `..` before anything is matched, so each of these
    // asks for a repository the grant does not list.
    const left = api('/repos/you/api/../other/issues')
    assert.deepStrictEqual(left._tag === 'Deny' ? left.asked : undefined, { scope: 'you/other' })
    assert.strictEqual(outcome(left), 403)
    // Resolved to the repository's own hooks, which only read reaches.
    const climbed = api('/repos/you/web/releases/../hooks', 'POST', writing())
    assert.strictEqual(outcome(climbed), 405)
  })

  it('refuses a repository no list names, for each method, naming it', () => {
    const read = api('/repos/someone/else/actions/runs')
    assert.strictEqual(outcome(read), 403)
    const written = api('/repos/someone/else/issues', 'POST', writing())
    assert.deepStrictEqual(written, {
      _tag: 'Deny',
      asked: { scope: 'someone/else' },
      json: true,
      reason:
        'POST /repos/someone/else/issues is not something this VM may do for someone/else through api.github.com',
      status: 403,
    })
  })

  it('refuses what lies outside the repositories, gists and new repositories among them', () => {
    for (const path of [
      '/gists',
      '/user/repos',
      '/search/issues?q=repo:someone/else',
      '/repositories/212613049/issues',
      '/orgs/someone/repos',
      '/repos/you',
    ]) {
      assert.strictEqual(outcome(api(path)), 403, path)
      assert.strictEqual(outcome(api(path, 'POST', writing())), 403, path)
    }
  })

  it('reads the API’s root with its credential, which is where a token’s scopes are given', () => {
    for (const path of ['/', '', '/?x=1']) {
      const root = api(path)
      assert.strictEqual(root._tag === 'Profile' ? root.rule : '', 'GET,HEAD /', path)
      assert.strictEqual(upstreamOf(root), `https://api.github.com/${path.slice(1)}`, path)
    }
    assert.strictEqual(outcome(api('/', 'POST')), 405)
    // The root is read's, granted with a repository listed for read.
    assert.strictEqual(outcome(api('/', 'GET', [github({ 'you/api': ['fetch'] })])), 403)
  })

  it('takes an empty segment as the root only where it ends a host alone', () => {
    for (const path of ['//', '/repos/you/api/', '/repos//api']) {
      assert.notStrictEqual(outcome(api(path)), 'allow', path)
    }
  })

  it('writes what each set allows, for a repository listing it, as the grant spells it', () => {
    assert.strictEqual(
      upstreamOf(api('/repos/you/web/issues?x=a b', 'POST', writing())),
      'https://api.github.com/repos/You/Web/issues?x=a+b',
    )
    for (const [method, path, set] of [
      ['POST', 'issues', 'issues'],
      ['PATCH', 'issues/7', 'issues'],
      ['POST', 'issues/7/comments', 'issues'],
      ['DELETE', 'issues/comments/9', 'issues'],
      ['PUT', 'issues/7/lock', 'issues'],
      ['POST', 'pulls', 'pulls'],
      ['PATCH', 'pulls/3', 'pulls'],
      ['PUT', 'pulls/3/merge', 'pulls'],
      ['POST', 'pulls/3/reviews', 'pulls'],
      ['DELETE', 'pulls/3/requested_reviewers', 'pulls'],
      ['POST', 'releases', 'releases'],
      ['POST', 'releases/generate-notes', 'releases'],
      ['PATCH', 'releases/5', 'releases'],
      ['DELETE', 'releases/5', 'releases'],
      ['DELETE', 'releases/assets/11', 'releases'],
      ['POST', 'actions/runs/8/rerun', 'actions'],
      ['POST', 'actions/runs/8/rerun-failed-jobs', 'actions'],
      ['POST', 'actions/runs/8/cancel', 'actions'],
      ['POST', 'actions/runs/8/force-cancel', 'actions'],
      ['POST', 'actions/jobs/13/rerun', 'actions'],
      ['POST', 'actions/workflows/ci.yml/dispatches', 'actions'],
      ['POST', 'statuses/0123abcd', 'checks'],
      ['POST', 'check-runs', 'checks'],
      ['PATCH', 'check-runs/4', 'checks'],
      ['POST', 'check-runs/4/rerequest', 'checks'],
      ['POST', 'check-suites', 'checks'],
      ['POST', 'check-suites/6/rerequest', 'checks'],
    ] as const) {
      const written = api(`/repos/you/web/${path}`, method, writing())
      assert.strictEqual(written._tag === 'Profile' ? written.set : '', set, `${method} ${path}`)
      // And only where the repository's list holds that set.
      const others = writes().filter(each => each !== set)
      assert.notStrictEqual(
        outcome(api(`/repos/you/web/${path}`, method, [github({ 'you/web': others })])),
        'allow',
        `${method} ${path} without ${set}`,
      )
    }
  })

  it('refuses every other write, though the token may make it', () => {
    for (const [method, path] of [
      ['PATCH', ''],
      ['DELETE', ''],
      ['POST', '/hooks'],
      ['POST', '/keys'],
      ['PUT', '/collaborators/someone'],
      ['PUT', '/actions/secrets/TOKEN'],
      ['POST', '/actions/variables'],
      ['POST', '/actions/runners/registration-token'],
      ['PUT', '/actions/permissions'],
      ['PATCH', '/check-suites/preferences'],
      ['PUT', '/contents/README.md'],
      ['POST', '/git/refs'],
      ['POST', '/forks'],
      ['POST', '/labels'],
      ['DELETE', '/actions/runs/8'],
      ['PUT', '/actions/workflows/ci.yml/enable'],
      ['PUT', '/actions/runs/8/rerun'],
      ['POST', '/statuses'],
      ['POST', '/statuses/0123abcd/x'],
    ] as const) {
      const refused = api(`/repos/you/web${path}`, method, writing())
      assert.include([403, 405], outcome(refused), `${method} ${path}`)
      assert.isTrue(refused._tag === 'Deny' && refused.json === true, `${method} ${path}`)
    }
  })

  it('refuses a Codespace made from a pull request by the profile’s deny rule, whatever is chosen', () => {
    for (const method of ['POST', 'DELETE', 'PATCH', 'PUT']) {
      const refused = api('/repos/you/web/pulls/3/codespaces', method, writing())
      assert.strictEqual(
        refused._tag === 'Deny' ? refused.reason : '',
        `${method} /repos/you/web/pulls/3/codespaces is refused at api.github.com by the github profile's deny rule DELETE,PATCH,POST,PUT repos/*/*/pulls/*/codespaces`,
      )
    }
    // A read of the same path is the read set's.
    assert.strictEqual(outcome(api('/repos/you/web/pulls/3/codespaces', 'GET', writing())), 'allow')
  })

  it('refuses a write to a repository listed for read, by the methods read takes', () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      assert.deepStrictEqual(
        api('/repos/you/api/issues', method),
        {
          _tag: 'Deny',
          asked: { host: 'api.github.com' },
          json: true,
          reason: `${method} /repos/you/api/issues is not something this VM may do through api.github.com, which allows GET, HEAD there`,
          status: 405,
        },
        method,
      )
    }
  })

  it('sends GraphQL unread for a grant choosing it, and refuses it for one that does not', () => {
    // Its body names what it reads and writes, some of it by node IDs, so
    // the token alone bounds it.
    const query = api('/graphql?owner=someone', 'POST')
    assert.strictEqual(query._tag === 'Profile' ? query.set : '', 'graphql')
    assert.isUndefined(query._tag === 'Profile' ? query.graphql : 'read')
    assert.strictEqual(upstreamOf(query), 'https://api.github.com/graphql?owner=someone')
    const without = [github({ 'you/api': writes() }, [])]
    assert.strictEqual(outcome(api('/graphql', 'POST', without)), 403)
    for (const method of ['GET', 'PUT']) {
      assert.notStrictEqual(outcome(api('/graphql', method)), 'allow', method)
    }
    for (const path of ['/graphql/x', '/api/graphql', '/repos/you/web/graphql']) {
      assert.notStrictEqual(outcome(api(path, 'POST', writing())), 'allow', path)
    }
  })

  it('reaches a repository through the sets its own list holds, and no other’s', () => {
    const split = [github({ 'you/api': ['issues'], 'you/web': ['pulls'] }, [])]
    assert.strictEqual(outcome(api('/repos/you/api/issues', 'POST', split)), 'allow')
    assert.strictEqual(outcome(api('/repos/you/web/pulls', 'POST', split)), 'allow')
    assert.notStrictEqual(outcome(api('/repos/you/api/pulls', 'POST', split)), 'allow')
    assert.notStrictEqual(outcome(api('/repos/you/web/issues', 'POST', split)), 'allow')
    // Neither lists read, so neither is read with the key.
    assert.strictEqual(outcome(api('/repos/you/api/issues', 'GET', split)), 405)
  })

  it('uploads to a release of a repository listing releases, keeping the length the guest stated', () => {
    assert.deepStrictEqual(upload('/repos/you/web/releases/42/assets?name=a b.tgz&label='), {
      _tag: 'Profile',
      credential: 'GITHUB_TOKEN',
      host: 'uploads.github.com',
      length: 'kept',
      profile: 'github',
      repo: 'You/Web',
      rule: 'POST repos/{repo}/releases/*/assets',
      send: 'bearer',
      sendsBody: true,
      set: 'releases',
      upstream: 'https://uploads.github.com/repos/You/Web/releases/42/assets?name=a+b.tgz&label=',
    })
  })

  it('refuses an upload for another repository, everything else sent there, and the wrong method', () => {
    for (const path of [
      '/repos/you/api/releases/42/assets',
      '/repos/someone/else/releases/42/assets',
      '/',
      '/repos/you/web',
      '/repos/you/web/releases/42',
      '/repos/you/web/releases/42/assets/7',
      '/repos/you/web/issues',
      '/gists',
    ]) {
      assert.strictEqual(outcome(upload(path)), 403, path)
    }
    for (const method of ['GET', 'PUT', 'DELETE']) {
      assert.strictEqual(outcome(upload('/repos/you/web/releases/42/assets', method)), 405, method)
    }
  })

  it('never sends a write no grant covers on bare, whatever the tunnel reaches', () => {
    const addressed = (url: string, method: string) =>
      Broker.decideAddressed(writing(), method, url, 'any')
    assert.strictEqual(
      addressed('https://api.github.com/repos/you/web/issues', 'POST')._tag,
      'Profile',
    )
    for (const [url, method] of [
      ['https://api.github.com/repos/someone/else/issues', 'POST'],
      ['https://api.github.com/repos/you/api/issues', 'POST'],
      ['https://api.github.com/repos/you/web/hooks', 'POST'],
      ['https://api.github.com/gists', 'POST'],
      ['https://github.com/someone/else/info/refs?service=git-receive-pack', 'GET'],
      ['https://github.com/someone/else/git-receive-pack', 'POST'],
      ['https://github.com/you/api/git-receive-pack', 'POST'],
    ] as const) {
      assert.strictEqual(addressed(url, method)._tag, 'Deny', url)
    }
  })

  it('is not answered without a github grant', () => {
    assert.strictEqual(outcome(api('/repos/you/api', 'GET', inference)), 421)
  })
})

/** The field Runpod's profile withholds from a GraphQL query, a registry's login. */
const registryAuth: ReadonlySet<string> = new Set(['registryAuth'])

describe('Broker.graphqlRefusal', () => {
  it('sends a document whose every operation is a query', () => {
    for (const document of [
      '{ myself { clientBalance currentSpendPerHr spendLimit } }',
      'query { gpuTypes { id displayName } }',
      'query Balance { myself { clientBalance } }',
      'query A { myself { id } } query B { gpuTypes { id } }',
      'query Pods($input: PodFilter = {limit: 5, tags: {a: "}"}}) @live { myself { pods(input: $input) { id } } }',
      'query { ...Me } fragment Me on Query { myself { id } }',
      'query { myself { ...on User { id } } }',
      '# mutation { createApiKey { id } }\n{ myself { id } }',
      'query { pods(name: "mutation { createApiKey }") { id } }',
      'query { pods(name: """a "quoted" mutation \\""" registryAuth""") { id } }',
      'query mutation { myself { mutation: id } }',
      '\uFEFF{ myself { id } }',
      'query { pods(limit: 5, cost: -1.5e3, flag: true, none: null, kind: SPOT, ids: ["a", "b"]) { id } }',
    ]) {
      assert.isUndefined(Broker.graphqlRefusal(document, registryAuth), document)
    }
  })

  it('refuses a mutation and a subscription, alone or beside a query', () => {
    const mutation =
      'a mutation writes, and this VM may only read through GraphQL; write through the REST API instead'
    for (const document of [
      'mutation { createApiKey(input: {name: "x"}) { id rawKey } }',
      'mutation Make { podFindAndDeployOnDemand(input: {}) { id } }',
      'query { myself { id } } mutation { createApiKey { id } }',
      '{ myself { id } }\nmutation { createApiKey { id } }',
      '# a comment\nmutation { createApiKey { id } }',
      'query Q($a: In = {b: "}"}) { x } mutation { createApiKey { id } }',
      'query { a(s: """ """) } mutation { createApiKey { id } }',
    ]) {
      assert.strictEqual(Broker.graphqlRefusal(document, registryAuth), mutation, document)
    }
    assert.strictEqual(
      Broker.graphqlRefusal('subscription { podStatus { id } }', registryAuth),
      'a subscription is not a query, and this VM may only query through GraphQL',
    )
  })

  it('refuses a document naming a field that holds a credential, however it names it', () => {
    const withheld = 'the query names registryAuth, which holds a credential, so it is not sent'
    for (const document of [
      '{ myself { containerRegistryCreds { id registryAuth } } }',
      '{ myself { containerRegistryCreds { auth: registryAuth } } }',
      'query { myself { containerRegistryCreds { ...Creds } } } fragment Creds on ContainerRegistryAuth { registryAuth }',
      'query { myself { containerRegistryCreds { ... @include(if: true) { registryAuth } } } }',
    ]) {
      assert.strictEqual(Broker.graphqlRefusal(document, registryAuth), withheld, document)
    }
  })

  it('refuses what is not a document of operations and fragments, or cannot be read as one', () => {
    for (const document of [
      '',
      '   # nothing but a comment',
      'fragment F on Query { myself { id } }',
      'type Query { x: Int }',
      'schema { query: Query }',
      'Mutation { createApiKey { id } }',
      '{ myself { id }',
      '{ myself { id } } }',
      'query Q) { x }',
      'query Q { x } }',
      '{ a(s: "unterminated) }',
      '{ a(s: "line\nbreak") }',
      '{ a(s: """unterminated) }',
      '{ a(n: 1e) }',
      '{ a(n: 12abc) }',
      '{ a(n: .5) }',
      '{ a(n: - 5) }',
      '{ a } ; mutation { b }',
      '{ a(n: 1) } é',
    ]) {
      assert.isDefined(Broker.graphqlRefusal(document, registryAuth), JSON.stringify(document))
    }
  })
})

describe('Broker.graphqlQuery', () => {
  it('writes the request it read again, and nothing else', () => {
    assert.deepStrictEqual(
      Broker.graphqlQuery(
        '{"query":"{ myself { id } }","variables":{"a":1},"operationName":null}',
        registryAuth,
      ),
      { body: '{"operationName":null,"query":"{ myself { id } }","variables":{"a":1}}' },
    )
    assert.deepStrictEqual(Broker.graphqlQuery('{"query":"{ myself { id } }"}', registryAuth), {
      body: '{"query":"{ myself { id } }"}',
    })
    assert.deepStrictEqual(
      Broker.graphqlQuery(
        '{"variables":null,"query":"query Q { a }","operationName":"Q"}',
        registryAuth,
      ),
      {
        body: '{"operationName":"Q","query":"query Q { a }","variables":null}',
      },
    )
  })

  it('reads a key given twice as the last, and sends that alone', () => {
    // Whatever a second parser would make of the text, the server is sent the
    // object this one read.
    assert.deepStrictEqual(
      Broker.graphqlQuery(
        '{"query":"mutation { createApiKey { id } }","query":"{ a }"}',
        registryAuth,
      ),
      { body: '{"query":"{ a }"}' },
    )
    assert.deepStrictEqual(
      Broker.graphqlQuery(
        '{"query":"{ a }","query":"mutation { createApiKey { id } }"}',
        registryAuth,
      ),
      {
        reason:
          'a mutation writes, and this VM may only read through GraphQL; write through the REST API instead',
      },
    )
  })

  it('refuses a request that is not one JSON object of a query in full', () => {
    const refusals: ReadonlyArray<readonly [string, string]> = [
      ['query { a }', 'a GraphQL request is sent as JSON, and this one is not'],
      ['', 'a GraphQL request is sent as JSON, and this one is not'],
      ['[{"query":"{ a }"}]', 'a GraphQL request is one JSON object, and a batch is not sent'],
      ['"{ a }"', 'a GraphQL request is one JSON object, and a batch is not sent'],
      ['null', 'a GraphQL request is one JSON object, and a batch is not sent'],
      [
        '{"extensions":{"persistedQuery":{"version":1,"sha256Hash":"ab"}}}',
        'a GraphQL request is sent with query, variables and operationName alone, and this one sets more',
      ],
      [
        '{"query":"{ a }","extensions":{"persistedQuery":{"version":1,"sha256Hash":"ab"}}}',
        'a GraphQL request is sent with query, variables and operationName alone, and this one sets more',
      ],
      ['{}', 'a GraphQL request is sent with its query in full, and this one has none'],
      ['{"query":null}', 'a GraphQL request is sent with its query in full, and this one has none'],
      ['{"query":"{ a }","variables":[1]}', 'a GraphQL request’s variables are an object'],
      ['{"query":"{ a }","variables":"{}"}', 'a GraphQL request’s variables are an object'],
      ['{"query":"{ a }","operationName":1}', 'a GraphQL request’s operationName is a string'],
    ]
    for (const [text, reason] of refusals) {
      assert.deepStrictEqual(Broker.graphqlQuery(text, registryAuth), { reason }, text)
    }
  })
})

describe('Broker.decideAddressed, on how a refusal is written', () => {
  const granted = (): readonly Broker.Grant[] => [
    github({ 'you/api': ['fetch', 'read'], 'you/web': writes() }),
    { name: 'llama-swap', port: 8080, profile: 'model-server' },
  ]
  /** Whether a refusal is set to be written in JSON, or `undefined` for no refusal. */
  const json = (decision: Broker.Decision): boolean | undefined =>
    decision._tag === 'Deny' ? decision.json === true : undefined
  const addressed = (url: string, method = 'GET') => Broker.decideAddressed(granted(), method, url)

  it('sets every refusal at a profile’s host to JSON, whichever rule refused it', () => {
    for (const [method, url] of [
      ['POST', 'https://api.github.com/repos/you/web/labels'],
      ['POST', 'https://api.github.com/repos/you/api/issues'],
      ['GET', 'https://api.github.com/repos/someone/else'],
      ['GET', 'https://API.GitHub.com/user/repos'],
      ['GET', 'https://api.github.com/repos/you'],
      ['GET', 'https://api.github.com/graphql'],
      ['OPTIONS', 'https://api.github.com/repos/you/api'],
      ['DELETE', 'https://api.github.com/repos/you/web/git/refs/tags%2Fv1'],
      ['GET', 'https://api.github.com/repos//api'],
      ['POST', 'https://api.github.com/repos/you/web/pulls/1/codespaces'],
      ['POST', 'https://uploads.github.com/repos/you/api/releases/1/assets'],
      ['GET', 'https://uploads.github.com/repos/you/web/releases/1/assets'],
      ['POST', 'https://uploads.github.com/repos/you/web/issues'],
      ['GET', 'https://github.com/someone/tool/releases/download/v1/x.tgz'],
    ] as const) {
      assert.isTrue(json(addressed(url, method)), `${method} ${url}`)
    }
  })

  it('leaves git’s refusals and a model server’s as text', () => {
    for (const [method, url] of [
      ['GET', 'https://github.com/you/api/info/refs?service=git-receive-pack'],
      ['POST', 'https://github.com/someone/else/git-upload-pack'],
      ['GET', 'https://github.com/you/api%2Fx/info/refs?service=git-upload-pack'],
      ['GET', 'https://github.com/you/api/info/refs'],
    ] as const) {
      assert.isFalse(json(addressed(url, method)), `${method} ${url}`)
    }
    for (const [method, path] of [
      ['POST', '/local/llama-swap/slots'],
      ['GET', '/elsewhere.example/'],
    ] as const) {
      assert.isFalse(json(Broker.decide(granted(), method, `${base}${path}`)), `${method} ${path}`)
    }
  })
})

describe('Broker.heldTo', () => {
  const stream = (...sizes: number[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const size of sizes) controller.enqueue(new Uint8Array(size).fill(0x61))
        controller.close()
      },
    })
  /** The bytes read before the stream ended, and how it ended. */
  const drain = async (held: ReadableStream<Uint8Array>) => {
    let bytes = 0
    try {
      for await (const chunk of held) bytes += chunk.byteLength
      return { bytes, failed: false }
    } catch {
      return { bytes, failed: true }
    }
  }

  it('passes on a body of exactly its length', async () => {
    assert.deepStrictEqual(await drain(Broker.heldTo(stream(3, 4), 7)), { bytes: 7, failed: false })
    assert.deepStrictEqual(await drain(Broker.heldTo(stream(), 0)), { bytes: 0, failed: false })
  })

  it('fails a body that runs past its length before passing on a byte beyond it', async () => {
    assert.deepStrictEqual(await drain(Broker.heldTo(stream(3, 4, 5), 7)), {
      bytes: 7,
      failed: true,
    })
    assert.deepStrictEqual(await drain(Broker.heldTo(stream(8), 7)), { bytes: 0, failed: true })
  })

  it('fails a body that ends short of its length', async () => {
    assert.deepStrictEqual(await drain(Broker.heldTo(stream(3), 7)), { bytes: 3, failed: true })
  })
})

describe('Broker.pagesOf', () => {
  it('puts a page named by the repository’s number back in the form the grant matches', () => {
    assert.strictEqual(
      Broker.pagesOf(
        '<https://api.github.com/repositories/212613049/actions/runs?per_page=100&page=2>; rel="next", ' +
          '<https://api.github.com/repositories/212613049/actions/runs?per_page=100&page=362>; rel="last"',
        'api.github.com',
        'you/api',
      ),
      '<https://api.github.com/repos/you/api/actions/runs?per_page=100&page=2>; rel="next", ' +
        '<https://api.github.com/repos/you/api/actions/runs?per_page=100&page=362>; rel="last"',
    )
    assert.strictEqual(
      Broker.pagesOf(
        '<https://api.github.com/repositories/1?page=2>; rel="next"',
        'api.github.com',
        'you/api',
      ),
      '<https://api.github.com/repos/you/api?page=2>; rel="next"',
    )
  })

  it('leaves every other link as it was', () => {
    for (const link of [
      '<https://api.github.com/repos/you/api/issues?page=2>; rel="next"',
      '<https://api.github.com/repositories/12x/issues>; rel="next"',
      '<https://elsewhere.example/repositories/1/issues>; rel="next"',
      '<https://api.github.com/user/repositories/1>; rel="next"',
    ]) {
      assert.strictEqual(Broker.pagesOf(link, 'api.github.com', 'you/api'), link)
    }
  })
})

describe('Broker.decideAddressed, on a read no grant covers', () => {
  const read = (url: string, method = 'GET', reach: Broker.TunnelScope = ['github.com']) =>
    Broker.decideAddressed(grants, method, url, reach)

  it('sends it on without a credential when the tunnel reaches the name', () => {
    assert.deepStrictEqual(read('https://github.com/someone/tool/releases/download/v1/tool.tgz'), {
      _tag: 'Anonymous',
      host: 'github.com',
      operation: 'read',
      upstream: 'https://github.com/someone/tool/releases/download/v1/tool.tgz',
    })
    for (const reach of [['GitHub.com'], 'any'] as const) {
      assert.strictEqual(read('https://github.com/someone/tool', 'HEAD', reach)._tag, 'Anonymous')
    }
  })

  it('fetches a repository no grant lists that way, as git asks for it', () => {
    const advertised = read('https://github.com/someone/else/info/refs?service=git-upload-pack')
    assert.strictEqual(advertised._tag === 'Anonymous' ? advertised.operation : '', 'ls-refs')
    assert.strictEqual(
      advertised._tag === 'Anonymous' ? advertised.upstream : '',
      'https://github.com/someone/else/info/refs?service=git-upload-pack',
    )
    const fetched = read('https://github.com/someone/else.git/git-upload-pack', 'POST')
    assert.strictEqual(fetched._tag === 'Anonymous' ? fetched.operation : '', 'fetch')
  })

  it('carries its path as the guest sent it, escapes included', () => {
    const decided = read('https://github.com/someone/tool/releases/download/v1/a%20b.tgz?x=1')
    assert.strictEqual(
      decided._tag === 'Anonymous' ? decided.upstream : '',
      'https://github.com/someone/tool/releases/download/v1/a%20b.tgz?x=1',
    )
  })

  it('still sends what a grant covers with its credential', () => {
    assert.strictEqual(
      read('https://github.com/you/api/info/refs?service=git-upload-pack')._tag,
      'Profile',
    )
  })

  it('refuses it when the tunnel does not reach the name', () => {
    for (const reach of [[], ['example.com'], ['github.com.example']] as const) {
      const decided = read(
        'https://github.com/someone/else/info/refs?service=git-upload-pack',
        'GET',
        reach,
      )
      assert.deepStrictEqual(decided, {
        _tag: 'Deny',
        asked: { scope: 'someone/else' },
        reason: 'someone/else is not a repository this VM may fetch',
        status: 403,
      })
    }
  })

  it('refuses anything that is not a read, whatever the tunnel reaches', () => {
    for (const [method, url] of [
      ['GET', 'https://github.com/someone/else/info/refs?service=git-receive-pack'],
      ['POST', 'https://github.com/someone/else.git/git-receive-pack'],
      ['POST', 'https://github.com/login'],
      ['PUT', 'https://github.com/someone/else'],
      ['DELETE', 'https://github.com/someone/else'],
      ['GET', 'https://github.com/you/api/info/refs?service=git-receive-pack'],
    ] as const) {
      assert.strictEqual(read(url, method, 'any')._tag, 'Deny', `${method} ${url}`)
    }
  })

  it('reads GitHub’s API the same way, for a repository no grant lists', () => {
    const latest = 'https://api.github.com/repos/someone/tool/releases/latest'
    assert.deepStrictEqual(read(latest, 'GET', ['api.github.com']), {
      _tag: 'Anonymous',
      host: 'api.github.com',
      operation: 'read',
      upstream: latest,
    })
    // Each name is reached in its own right.
    assert.strictEqual(read(latest, 'GET', ['github.com'])._tag, 'Deny')
    assert.strictEqual(
      read('https://api.github.com/repos/you/api/releases/latest')._tag === 'Profile',
      true,
    )
    assert.strictEqual(read('https://api.github.com/gists', 'POST', 'any')._tag, 'Deny')
  })

  it('sends a read the deny rules refuse without a credential, as one no rule covers', () => {
    const codespaces = 'https://api.github.com/repos/someone/else/pulls/1/codespaces'
    assert.strictEqual(read(codespaces, 'GET', ['api.github.com'])._tag, 'Anonymous')
    assert.strictEqual(read(codespaces, 'POST', 'any')._tag, 'Deny')
  })

  it('sends a GraphQL query with the grant’s credential, and none on github.com', () => {
    const query = read('https://api.github.com/graphql', 'POST', [])
    assert.strictEqual(query._tag === 'Profile' ? query.set : '', 'graphql')
    assert.strictEqual(read('https://github.com/graphql', 'POST', 'any')._tag, 'Deny')
  })

  it('reads the API’s root with the grant’s credential, reached or not', () => {
    assert.strictEqual(
      upstreamOf(read('https://api.github.com/', 'GET', [])),
      'https://api.github.com/',
    )
    assert.strictEqual(read('https://github.com/', 'GET', 'any')._tag, 'Anonymous')
  })

  it('answers no other name, reached or not', () => {
    assert.strictEqual(outcome(read('https://example.com/', 'GET', 'any')), 421)
  })
})

describe('Broker.upstreamHeaders, for git’s reader', () => {
  const allowed = {
    _tag: 'Profile',
    credential: 'GITHUB_TOKEN',
    git: 'ls-refs',
    host: 'github.com',
    profile: 'github',
    repo: 'you/api',
    rule: 'git fetch',
    send: { basic: 'x-access-token' },
    sendsBody: false,
    set: 'fetch',
    upstream: 'https://github.com/you/api.git/info/refs?service=git-upload-pack',
  } as const

  const headersFor = (git: Broker.GitOperation, guest: Record<string, string>) =>
    Broker.upstreamHeaders({ ...allowed, git }, 'ghp_secret', new Headers(guest))

  it('injects the token the way git sends one over HTTPS', () => {
    const headers = headersFor('ls-refs', {})
    assert.strictEqual(headers.get('Authorization'), `Basic ${btoa('x-access-token:ghp_secret')}`)
  })

  it('drops a guest’s own Authorization rather than merging with it', () => {
    // Built from nothing, so a colliding header is not a case to handle.
    const headers = headersFor('ls-refs', { Authorization: 'Basic Z3Vlc3Q6', 'X-Smuggled': 'yes' })
    assert.strictEqual(headers.get('Authorization'), `Basic ${btoa('x-access-token:ghp_secret')}`)
    assert.isNull(headers.get('X-Smuggled'))
  })

  it('forwards none of the headers an inference request carries', () => {
    const headers = headersFor('ls-refs', { 'anthropic-beta': 'b', 'x-session-id': 'ses_1' })
    assert.isNull(headers.get('anthropic-beta'))
    assert.isNull(headers.get('x-session-id'))
  })

  it('asks for no transfer encoding', () => {
    // `fetch` decodes a compressed response but leaves `Content-Encoding` on the
    // headers, so a forwarded one would describe the body as something it is not.
    assert.strictEqual(headersFor('ls-refs', {}).get('Accept-Encoding'), 'identity')
  })

  it('carries the request body’s own encoding, since the body is passed through', () => {
    assert.strictEqual(
      headersFor('fetch', { 'Content-Encoding': 'gzip' }).get('Content-Encoding'),
      'gzip',
    )
    assert.isNull(headersFor('fetch', { 'Content-Encoding': 'br' }).get('Content-Encoding'))
    assert.isNull(headersFor('ls-refs', { 'Content-Encoding': 'gzip' }).get('Content-Encoding'))
  })

  it('forwards a git protocol version, bounded', () => {
    // The one header that is a negotiation between the guest's git and the
    // upstream. Anything else in it is not a version. A value carrying CRLF
    // cannot be tested here because `Headers` refuses to hold one — which is
    // where that particular defence lives, not in this pattern.
    assert.strictEqual(
      headersFor('ls-refs', { 'Git-Protocol': 'version=2' }).get('Git-Protocol'),
      'version=2',
    )
    for (const value of ['version=two', 'version=2, version=1', '']) {
      assert.isNull(headersFor('ls-refs', { 'Git-Protocol': value }).get('Git-Protocol'))
    }
  })

  it('names the content type itself on a fetch', () => {
    assert.strictEqual(
      headersFor('fetch', { 'Content-Type': 'text/plain' }).get('Content-Type'),
      'application/x-git-upload-pack-request',
    )
  })

  it('names a push’s types as git does, and its advertisement’s none', () => {
    const pushed = headersFor('push', { 'Content-Type': 'text/plain' })
    assert.strictEqual(pushed.get('Content-Type'), 'application/x-git-receive-pack-request')
    assert.strictEqual(pushed.get('Accept'), 'application/x-git-receive-pack-result')
    assert.strictEqual(pushed.get('Authorization'), `Basic ${btoa('x-access-token:ghp_secret')}`)
    const advertised = headersFor('push-refs', { 'Content-Type': 'text/plain' })
    assert.isNull(advertised.get('Content-Type'))
    assert.strictEqual(advertised.get('Accept'), '*/*')
  })

  it('sends a body with the length it declared at a rule keeping it, and no other with one', () => {
    const through = (kept: boolean, guest: Record<string, string>) =>
      Broker.upstreamHeaders(
        {
          _tag: 'Profile',
          credential: 'GITHUB_TOKEN',
          host: 'uploads.github.com',
          ...(kept ? { length: 'kept' } : {}),
          profile: 'github',
          repo: 'you/web',
          rule: 'POST repos/{repo}/releases/*/assets',
          send: 'bearer',
          sendsBody: true,
          set: 'releases',
          upstream: 'https://uploads.github.com/repos/you/web/releases/1/assets?name=a',
        },
        'ghp_secret',
        new Headers(guest),
      )
    const sized = through(true, {
      'Content-Length': '1024',
      'Content-Type': 'application/gzip',
    })
    assert.strictEqual(sized.get('Content-Length'), '1024')
    assert.strictEqual(sized.get('Content-Type'), 'application/gzip')
    assert.strictEqual(sized.get('Authorization'), 'Bearer ghp_secret')
    for (const guest of [
      {},
      { 'Content-Length': '10', 'Transfer-Encoding': 'chunked' },
      { 'Content-Length': '1e3' },
      { 'Content-Length': '-1' },
      { 'Content-Length': '10, 12' },
    ]) {
      assert.isNull(through(true, guest).get('Content-Length'), JSON.stringify(guest))
    }
    assert.isNull(through(false, { 'Content-Length': '1024' }).get('Content-Length'))
  })
})

describe('Broker.relay', () => {
  const allowed = {
    credential: 'GITHUB_TOKEN',
    git: true,
    host: 'github.com',
    kind: 'Profile',
    redirects: false,
    scope: 'you/api',
  } as const

  it('does not pass a 401 back as a 401', () => {
    // git prompts for a username on a 401, inside the guest, for a credential
    // the guest does not have and must not be given. Dropping
    // `WWW-Authenticate` does not prevent it — the status is the trigger — so
    // the broker reports its own credential being refused instead.
    const refused = Broker.relay(allowed, 401)
    assert.strictEqual(refused?.status, 502)
    assert.include(refused?.reason ?? '', 'GITHUB_TOKEN')
  })

  it('answers a model call’s refused credential with a 403, which a client does not retry', () => {
    // A model client retries a 502 as an outage, for minutes, and stops at a
    // 403 with the reason shown.
    const refused = Broker.relay(
      {
        credential: 'ANTHROPIC_API_KEY',
        git: false,
        host: 'api.anthropic.com',
        kind: 'Profile',
        redirects: false,
        scope: undefined,
      },
      401,
    )
    assert.strictEqual(refused?.status, 403)
    assert.include(refused?.reason ?? '', 'refused ANTHROPIC_API_KEY')
  })

  it('does not pass a redirect back either', () => {
    for (const status of [301, 302, 307, 308]) {
      assert.strictEqual(Broker.relay(allowed, status)?.status, 502)
    }
  })

  it('passes everything else through untouched', () => {
    // A 403 or a 404 is an answer about the repository, which is the guest's to
    // see; neither makes git ask for a credential.
    for (const status of [200, 304, 403, 404, 429, 500]) {
      assert.isUndefined(Broker.relay(allowed, status))
    }
  })

  it('passes a redirect back at a host returning them, and answers its refused credential with a final 403', () => {
    const read = {
      credential: 'GITHUB_TOKEN',
      git: false,
      host: 'api.github.com',
      kind: 'Profile',
      redirects: true,
      scope: 'you/api',
    } as const
    // A log or an asset is a signed URL elsewhere, which needs no credential.
    for (const status of [302, 307]) assert.isUndefined(Broker.relay(read, status))
    const refused = Broker.relay(read, 401)
    assert.strictEqual(refused?.status, 403)
    assert.include(refused?.reason ?? '', 'refused GITHUB_TOKEN')
    assert.include(refused?.reason ?? '', 'you/api')
  })

  it('passes an anonymous read’s redirect back, and answers its 401 with a final 403', () => {
    const anonymous = {
      credential: undefined,
      git: false,
      host: 'github.com',
      kind: 'Anonymous',
      redirects: false,
      scope: undefined,
    } as const
    // Nothing the broker holds goes with it, wherever it leads.
    for (const status of [200, 301, 302, 307, 308, 404]) {
      assert.isUndefined(Broker.relay(anonymous, status))
    }
    const refused = Broker.relay(anonymous, 401)
    assert.strictEqual(refused?.status, 403)
    assert.include(refused?.reason ?? '', "no grant of this VM's covers it")
  })
})

/** The model providers' profiles, as igloo ships them, with every set chosen. */
const inference: readonly Broker.Grant[] = [
  shippedGrant('anthropic-messages', 'ANTHROPIC_API_KEY'),
  shippedGrant('openrouter', 'OPENROUTER_API_KEY'),
]

/**
 * A request to a provider, by default a `POST`: `path` is its name and then
 * its own path, addressed by name as the provider's own client sends it.
 */
const call = (path: string, method = 'POST') =>
  Broker.decideAddressed(inference, method, `https:/${path}`)

describe('Broker.upstreamHeaders, for a model provider’s profile', () => {
  const decision = call('/api.anthropic.com/v1/messages')
  const openrouter = call('/openrouter.ai/api/v1/chat/completions')
  const listing = call('/openrouter.ai/api/v1/models', 'GET')

  const headersFor = (routed: Broker.Decision, guest: Record<string, string> = {}) =>
    routed._tag === 'Profile'
      ? Broker.upstreamHeaders(routed, 'sk-secret', new Headers(guest))
      : new Headers()

  it('injects each provider’s own credential header', () => {
    assert.strictEqual(headersFor(decision).get('x-api-key'), 'sk-secret')
    assert.strictEqual(headersFor(openrouter).get('Authorization'), 'Bearer sk-secret')
  })

  it('sends OpenRouter its own credential header whatever shape the call takes', () => {
    // An Anthropic client sends its key as `x-api-key`; OpenRouter takes a
    // bearer token on every endpoint, its Messages one included.
    for (const path of ['/openrouter.ai/api/v1/messages', '/openrouter.ai/api/v1/responses']) {
      const headers = headersFor(call(path), {
        'anthropic-version': '2023-06-01',
        'x-api-key': 'guest-key',
      })
      assert.strictEqual(headers.get('Authorization'), 'Bearer sk-secret', path)
      assert.isNull(headers.get('x-api-key'), path)
      assert.strictEqual(headers.get('anthropic-version'), '2023-06-01', path)
    }
  })

  it('carries the guest’s own headers, so a harness reaches its provider as from the host', () => {
    const guest = {
      'anthropic-beta': 'context-management-2025-06-27,interleaved-thinking-2025-05-14',
      'anthropic-version': '2023-06-01',
      'HTTP-Referer': 'https://example.org/harness',
      'user-agent': 'claude-cli/2.1.282',
      'x-openrouter-cache': 'true',
      'x-session-id': 'ses_0a1b2c3d4e5f',
      'x-stainless-lang': 'js',
    }
    for (const routed of [decision, openrouter]) {
      const headers = headersFor(routed, guest)
      for (const [name, value] of Object.entries(guest)) {
        assert.strictEqual(headers.get(name), value, name)
      }
    }
  })

  it('drops the guest’s credentials, whichever header carries them', () => {
    const guest = {
      Authorization: 'Bearer guest-key',
      Cookie: 'session=guest',
      'Proxy-Authorization': 'Basic Z3Vlc3Q6',
      'x-api-key': 'guest-key',
    }
    const anthropic = headersFor(decision, guest)
    assert.strictEqual(anthropic.get('x-api-key'), 'sk-secret')
    assert.isNull(anthropic.get('Authorization'))
    const viaOpenRouter = headersFor(openrouter, guest)
    assert.strictEqual(viaOpenRouter.get('Authorization'), 'Bearer sk-secret')
    assert.isNull(viaOpenRouter.get('x-api-key'))
    for (const headers of [anthropic, viaOpenRouter]) {
      assert.isNull(headers.get('Cookie'))
      assert.isNull(headers.get('Proxy-Authorization'))
    }
  })

  it('drops what describes the guest’s connection, and the length of its body', () => {
    const headers = headersFor(decision, {
      Connection: 'keep-alive, x-hop',
      'Content-Length': '12',
      Expect: '100-continue',
      Host: '127.0.0.1:3128',
      'Keep-Alive': 'timeout=5',
      TE: 'trailers',
      'Transfer-Encoding': 'chunked',
      Upgrade: 'h2c',
      'x-hop': 'named by Connection',
    })
    for (const name of [
      'Connection',
      'Content-Length',
      'Expect',
      'Host',
      'Keep-Alive',
      'TE',
      'Transfer-Encoding',
      'Upgrade',
      'x-hop',
    ]) {
      assert.isNull(headers.get(name), name)
    }
  })

  it('describes a body as the guest did, and a listing, which sends none, not at all', () => {
    // The body goes as it arrived, so its type and encoding go with it; its
    // length is stated afresh by what sends it.
    const described = { 'Content-Encoding': 'gzip', 'Content-Type': 'text/plain' }
    for (const routed of [decision, openrouter]) {
      const headers = headersFor(routed, described)
      assert.strictEqual(headers.get('Content-Encoding'), 'gzip')
      assert.strictEqual(headers.get('Content-Type'), 'text/plain')
    }
    const listed = headersFor(listing, described)
    assert.isNull(listed.get('Content-Encoding'))
    assert.isNull(listed.get('Content-Type'))
  })

  it('asks for no transfer encoding, so a token stream arrives as it is sent', () => {
    assert.strictEqual(
      headersFor(decision, { 'Accept-Encoding': 'gzip, br' }).get('Accept-Encoding'),
      'identity',
    )
  })
})

describe('Broker.responseHeaders', () => {
  const upstream = () =>
    new Headers([
      ['alt-svc', 'h3=":443"'],
      ['anthropic-ratelimit-requests-remaining', '49'],
      ['connection', 'keep-alive'],
      ['content-encoding', 'gzip'],
      ['content-length', '120'],
      ['content-type', 'text/event-stream'],
      ['keep-alive', 'timeout=5'],
      ['proxy-authenticate', 'Basic'],
      ['request-id', 'req_011CTest'],
      ['retry-after', '7'],
      ['set-cookie', '__cf_bm=1; Path=/'],
      ['set-cookie', '_cfuvid=2; Path=/'],
      ['transfer-encoding', 'chunked'],
      ['www-authenticate', 'Bearer'],
      ['x-request-id', 'gen-1760000000-abc'],
    ])

  it('passes a provider’s headers back, so a harness reads its retry delay and request id', () => {
    assert.deepStrictEqual(
      [...Broker.responseHeaders(false, upstream())],
      [
        ['anthropic-ratelimit-requests-remaining', '49'],
        ['content-type', 'text/event-stream'],
        ['request-id', 'req_011CTest'],
        ['retry-after', '7'],
        ['x-request-id', 'gen-1760000000-abc'],
      ],
    )
  })

  it('gives git only what git reads', () => {
    assert.deepStrictEqual(
      [...Broker.responseHeaders(true, upstream())],
      [
        ['cache-control', 'no-cache, max-age=0, must-revalidate'],
        ['content-type', 'text/event-stream'],
      ],
    )
  })
})

describe('Broker.guestPlaceholderKey', () => {
  it('holds no value a session variable cannot carry', () => {
    // NixOS writes it inside double quotes, unescaped, so a quote in a value
    // ends it.
    assert.notMatch(Broker.guestPlaceholderKey, /["\\]/)
  })
})

const servers: readonly Broker.Grant[] = [
  { name: 'llama-swap', port: 8080, profile: 'model-server' },
  { credential: 'model-server.ollama', name: 'ollama', port: 11434, profile: 'model-server' },
]

/** A request for a model server, as an OpenAI-shaped client builds it from its base. */
const local = (path: string, method = 'POST') => Broker.decide(servers, method, `${base}${path}`)

describe('Broker.decide, for a model server', () => {
  it('names the server a refused request asked for', () => {
    const asked = (decision: Broker.Decision) =>
      decision._tag === 'Deny' ? decision.asked : decision._tag
    assert.deepStrictEqual(asked(local('/local/elsewhere/v1/models', 'GET')), {
      server: 'elsewhere',
    })
    assert.deepStrictEqual(asked(local('/local/ollama/props', 'GET')), { server: 'ollama' })
  })

  it('routes a model call and the listing to the server’s port on loopback', () => {
    const routed = (decision: Broker.Decision) =>
      decision._tag === 'ModelServer'
        ? { operation: decision.operation, server: decision.server, upstream: decision.upstream }
        : decision
    assert.deepStrictEqual(routed(local('/local/llama-swap/v1/chat/completions')), {
      operation: 'chat-completions',
      server: 'llama-swap',
      upstream: 'http://127.0.0.1:8080/v1/chat/completions',
    })
    assert.deepStrictEqual(routed(local('/local/llama-swap/v1/responses')), {
      operation: 'responses',
      server: 'llama-swap',
      upstream: 'http://127.0.0.1:8080/v1/responses',
    })
    assert.deepStrictEqual(routed(local('/local/llama-swap/v1/embeddings')), {
      operation: 'embeddings',
      server: 'llama-swap',
      upstream: 'http://127.0.0.1:8080/v1/embeddings',
    })
    assert.deepStrictEqual(routed(local('/local/llama-swap/v1/rerank')), {
      operation: 'rerank',
      server: 'llama-swap',
      upstream: 'http://127.0.0.1:8080/v1/rerank',
    })
    assert.deepStrictEqual(routed(local('/local/llama-swap/v1/systemone')), {
      operation: 'systemone',
      server: 'llama-swap',
      upstream: 'http://127.0.0.1:8080/v1/systemone',
    })
    assert.deepStrictEqual(routed(local('/local/ollama/v1/models', 'GET')), {
      operation: 'list-models',
      server: 'ollama',
      upstream: 'http://127.0.0.1:11434/v1/models',
    })
  })

  it('carries the credential only for a server whose grant holds one', () => {
    const credential = (decision: Broker.Decision) =>
      decision._tag === 'ModelServer' ? (decision.credential ?? 'none') : decision._tag
    assert.strictEqual(credential(local('/local/llama-swap/v1/chat/completions')), 'none')
    assert.strictEqual(
      credential(local('/local/ollama/v1/chat/completions')),
      'model-server.ollama',
    )
  })

  it('refuses every endpoint of the server that is not a model call or the listing', () => {
    // A proxy's captures of other clients, its passthrough to the server
    // behind it and its unloading; the server's own settings, slots, model
    // loading and tools; the model calls no harness here makes; and other
    // paths a server serves embeddings and reranking at.
    for (const path of [
      'api/captures/1',
      'logs/stream',
      'running',
      'unload',
      'api/models/unload',
      'upstream/Qwen3.5-2B/props',
      'upstream/Qwen3.5-2B/slots/0',
      'props',
      'models',
      'models/load',
      'slots',
      'tools',
      'metrics',
      'v1/completions',
      'v1/messages',
      'embedding',
      'embeddings',
      'rerank',
      'reranking',
      'v1/reranking',
      'v1/chat/completions/extra',
      'v1',
    ]) {
      assert.strictEqual(outcome(local(`/local/llama-swap/${path}`)), 404, path)
      assert.strictEqual(outcome(local(`/local/llama-swap/${path}`, 'GET')), 404, path)
    }
  })

  it('refuses a server no grant names, and the wrong method on one that is', () => {
    assert.strictEqual(outcome(local('/local/vllm/v1/chat/completions')), 403)
    assert.strictEqual(outcome(local('/local')), 403)
    assert.strictEqual(outcome(local('/local/LLAMA-SWAP/v1/chat/completions')), 403)
    assert.strictEqual(outcome(local('/local/llama-swap/v1/chat/completions', 'GET')), 405)
    assert.strictEqual(outcome(local('/local/llama-swap/v1/embeddings', 'GET')), 405)
    assert.strictEqual(outcome(local('/local/llama-swap/v1/rerank', 'GET')), 405)
    assert.strictEqual(outcome(local('/local/llama-swap/v1/systemone', 'GET')), 405)
    assert.strictEqual(outcome(local('/local/llama-swap/v1/models')), 405)
  })

  it('carries no query, not even a listing’s', () => {
    const decision = local('/local/llama-swap/v1/models?limit=1', 'GET')
    assert.strictEqual(
      decision._tag === 'ModelServer' ? decision.upstream : decision._tag,
      'http://127.0.0.1:8080/v1/models',
    )
  })

  it('cannot be pointed at another address or port by the request', () => {
    for (const target of [
      'http://192.168.1.10:8080/local/llama-swap/v1/chat/completions',
      '/local/llama-swap/v1/../../../127.0.0.1:22/v1/chat/completions',
      '/local/llama-swap/%2e%2e/v1/chat/completions',
    ]) {
      const decision = Broker.decide(servers, 'POST', target)
      if (decision._tag === 'ModelServer') {
        assert.strictEqual(new URL(decision.upstream).host, '127.0.0.1:8080', target)
      }
    }
  })

  it('leaves the other grants’ routes as they were', () => {
    const held = [...grants, ...inference, ...servers]
    assert.strictEqual(
      outcome(
        Broker.decideAddressed(
          held,
          'GET',
          'https://github.com/you/api/info/refs?service=git-upload-pack',
        ),
      ),
      'allow',
    )
    assert.strictEqual(
      outcome(
        Broker.decideAddressed(held, 'POST', 'https://openrouter.ai/api/v1/chat/completions'),
      ),
      'allow',
    )
    assert.strictEqual(
      outcome(Broker.decide(held, 'POST', `${base}/local/llama-swap/v1/chat/completions`)),
      'allow',
    )
    // A git-shaped path under the prefix is still git's to refuse.
    assert.strictEqual(
      outcome(
        Broker.decide(held, 'GET', `${base}/local/you/api/info/refs?service=git-receive-pack`),
      ),
      403,
    )
  })
})

describe('Broker.upstreamHeaders, for a model server', () => {
  const headersFor = (
    routed: Broker.Decision,
    token: string | undefined,
    guest: Record<string, string>,
  ) =>
    routed._tag === 'ModelServer'
      ? Broker.upstreamHeaders(routed, token, new Headers(guest))
      : new Headers()

  it('carries the guest’s headers, less its credentials, and sends a key only if there is one', () => {
    const guest = {
      authorization: 'Bearer not-needed',
      'content-type': 'application/json',
      host: '127.0.0.1:3128',
      'user-agent': 'pi (linux; x64)',
      'x-api-key': 'guest-key',
      'x-stainless-lang': 'js',
    }
    const keyless = headersFor(local('/local/llama-swap/v1/chat/completions'), undefined, guest)
    assert.isNull(keyless.get('authorization'))
    assert.isNull(keyless.get('x-api-key'))
    assert.isNull(keyless.get('host'))
    assert.strictEqual(keyless.get('user-agent'), 'pi (linux; x64)')
    assert.strictEqual(keyless.get('x-stainless-lang'), 'js')
    assert.strictEqual(keyless.get('content-type'), 'application/json')
    assert.strictEqual(keyless.get('accept-encoding'), 'identity')

    const keyed = headersFor(local('/local/ollama/v1/chat/completions'), 'sk-local', guest)
    assert.strictEqual(keyed.get('authorization'), 'Bearer sk-local')
    assert.isNull(keyed.get('x-api-key'))
  })

  it('describes no body for the listing, which sends none', () => {
    const headers = headersFor(local('/local/llama-swap/v1/models', 'GET'), undefined, {
      'content-type': 'application/json',
    })
    assert.isNull(headers.get('content-type'))
  })

  it('describes the body of a decision model’s call, which sends one', () => {
    const headers = headersFor(local('/local/llama-swap/v1/systemone'), undefined, {
      'content-type': 'application/json',
    })
    assert.strictEqual(headers.get('content-type'), 'application/json')
  })
})

describe('Broker.relay, for a model server', () => {
  it('answers a server that wants a key it was not given with a final 403 saying so', () => {
    const refused = Broker.relay(
      {
        credential: undefined,
        git: false,
        host: '127.0.0.1:8080',
        kind: 'ModelServer',
        redirects: false,
        scope: undefined,
      },
      401,
    )
    assert.strictEqual(refused?.status, 403)
    assert.include(refused?.reason, '127.0.0.1:8080 wants a credential')
  })

  it('answers a refused key as it does a provider’s', () => {
    const refused = Broker.relay(
      {
        credential: 'model-server.ollama',
        git: false,
        host: '127.0.0.1:11434',
        kind: 'ModelServer',
        redirects: false,
        scope: undefined,
      },
      401,
    )
    assert.strictEqual(refused?.status, 403)
    assert.include(refused?.reason, 'refused model-server.ollama')
  })

  it('follows no redirect', () => {
    const redirected = Broker.relay(
      {
        credential: undefined,
        git: false,
        host: '127.0.0.1:8080',
        kind: 'ModelServer',
        redirects: false,
        scope: undefined,
      },
      307,
    )
    assert.strictEqual(redirected?.status, 502)
  })
})

describe('Broker, for a model server', () => {
  it('routes each endpoint an OpenAI-shaped client hangs off its base', () => {
    // A client appends these to the base it is given; each has to be a path
    // `decide` routes.
    const baseUrl = 'http://127.0.0.1:3128/local/llama-swap/v1'
    for (const [endpoint, method] of [
      ['chat/completions', 'POST'],
      ['responses', 'POST'],
      ['embeddings', 'POST'],
      ['rerank', 'POST'],
      ['models', 'GET'],
    ] as const) {
      assert.strictEqual(outcome(Broker.decide(servers, method, `${baseUrl}/${endpoint}`)), 'allow')
    }
  })
})

/** The refusal these grants produce, and a failure if they parse after all. */
const message = (json: string): string => {
  const parsed = Broker.parseGrants(json)
  assert.isTrue('message' in parsed)
  return 'message' in parsed ? parsed.message : ''
}

describe('Broker.parseGrants', () => {
  it('reads a grant, as composition sends it', () => {
    assert.deepStrictEqual(Broker.parseGrants(JSON.stringify(grants)), { grants: [...grants] })
  })

  it('reads no grants at all', () => {
    assert.deepStrictEqual(Broker.parseGrants('[]'), { grants: [] })
  })

  it('refuses a grant in the shape github’s code read, which a profile grant replaced', () => {
    // A broker that dropped the grant it could not read would serve a smaller
    // policy than the one written down, which is not a difference anyone
    // notices until the request that should have been refused succeeds.
    for (const grant of [
      { credential: 'T', profile: 'github', repos: ['you/api'] },
      { credential: 'T', profile: 'github', repos: ['you/api'], write: ['you/web'] },
      { credential: 'T', profile: 'gitlab', repos: ['you/api'] },
    ]) {
      assert.isTrue('message' in Broker.parseGrants(JSON.stringify([grant])), JSON.stringify(grant))
    }
    assert.include(
      message(JSON.stringify([{ credential: 'T', profile: 'github', write: ['you/web'] }])),
      'sets write',
    )
  })

  it('refuses malformed input rather than starting without it', () => {
    assert.include(message('not json'), 'not JSON')
    assert.include(message('{}'), 'array')
    const { credential: _, ...nameless } = github()
    assert.include(message(JSON.stringify([nameless])), 'credential')
  })

  it('refuses a grant of a service by its name alone, which reaches no host', () => {
    for (const profile of ['anthropic-messages', 'openrouter', 'runpod', 'github']) {
      assert.include(
        message(JSON.stringify([{ credential: 'K', profile }])),
        `the ${profile} grant reaches no host`,
      )
    }
  })

  it('refuses a field it does not read, rather than serving without the limit', () => {
    for (const grant of [
      { ...shippedGrant('anthropic-messages', 'K'), models: ['m'] },
      { ...shippedGrant('openrouter', 'K'), maxOutputTokens: 64 },
      { ...shippedGrant('runpod', 'R'), ask: ['pods'] },
      { ...github(), models: ['m'] },
    ]) {
      assert.include(message(JSON.stringify([grant])), 'which this broker does not read')
    }
  })

  it('refuses a second grant for one profile, which nothing could choose between', () => {
    assert.include(
      message(
        JSON.stringify([
          shippedGrant('anthropic-messages', 'K'),
          shippedGrant('anthropic-messages', 'L'),
        ]),
      ),
      'two anthropic-messages grants',
    )
    // A request to GitHub's API may name no repository, so its repository
    // cannot pick the grant.
    assert.include(
      message(JSON.stringify([github(), github({ 'you/web': ['fetch'] }, ['graphql'], 'OTHER')])),
      'two github grants',
    )
  })

  it('reads a model server’s grant, with a credential or without one', () => {
    assert.deepStrictEqual(
      Broker.parseGrants(
        '[{"name":"llama-swap","port":8080,"profile":"model-server"},{"credential":"model-server.ollama","name":"ollama","port":11434,"profile":"model-server"}]',
      ),
      { grants: [...servers] },
    )
  })

  it('refuses a model server’s grant that places it anywhere but a port on loopback', () => {
    for (const grant of [
      { host: '192.168.1.10', name: 'gpu', port: 8080, profile: 'model-server' },
      { name: 'gpu', port: 8080, profile: 'model-server', url: 'http://gpu.lan:8080' },
      { name: 'gpu', port: 8080, profile: 'model-server', repos: ['you/api'] },
    ]) {
      assert.include(message(JSON.stringify([grant])), 'which this broker does not read')
    }
  })

  it('refuses a model server’s name or port that is not one', () => {
    for (const name of ['', 'Llama', 'llama/swap', '-swap', 'llama swap', 7]) {
      assert.include(
        message(JSON.stringify([{ name, port: 8080, profile: 'model-server' }])),
        "is not a model server's name",
        String(name),
      )
    }
    for (const port of [0, 65536, 80.5, '8080', -1]) {
      assert.include(
        message(JSON.stringify([{ name: 'llama-swap', port, profile: 'model-server' }])),
        'port',
        String(port),
      )
    }
    assert.include(
      message('[{"credential":"","name":"llama-swap","port":8080,"profile":"model-server"}]'),
      'credential',
    )
  })

  it('refuses two model servers by one name, which a request could not choose between', () => {
    assert.include(
      message(
        '[{"name":"llama-swap","port":8080,"profile":"model-server"},{"name":"llama-swap","port":8081,"profile":"model-server"}]',
      ),
      'two model servers named llama-swap',
    )
  })
})

describe('Broker.parseConnect', () => {
  const target = (line: string) => Broker.parseConnect(line)
  const status = (tunnel: Broker.Tunnel): number | string =>
    tunnel._tag === 'Refuse' ? tunnel.status : 'open'

  it('reads an authority-form target', () => {
    assert.deepStrictEqual(target('CONNECT pypi.org:443 HTTP/1.1'), {
      _tag: 'Open',
      host: 'pypi.org',
      port: 443,
    })
  })

  it('does not parse the target as a URL, because a URL parser reads it as a scheme', () => {
    // `new URL('evil.com:443')` yields protocol `evil.com:` and an empty host,
    // and a base does not rescue it — a target carrying a scheme ignores the
    // base. Anything here reaching for a URL parser would allowlist the empty
    // string, so the host is taken from the text by this rule alone.
    assert.deepStrictEqual(target('CONNECT evil.com:443 HTTP/1.1'), {
      _tag: 'Open',
      host: 'evil.com',
      port: 443,
    })
    assert.strictEqual(new URL('evil.com:443').host, '')
  })

  it('refuses anything carrying more of a URL than an authority', () => {
    for (const line of [
      'CONNECT https://pypi.org:443/x HTTP/1.1',
      'CONNECT pypi.org:443/../evil HTTP/1.1',
      'CONNECT user@pypi.org:443 HTTP/1.1',
      'CONNECT pypi.org:443?a=b HTTP/1.1',
      String.raw`CONNECT pypi.org:443\evil HTTP/1.1`,
    ]) {
      assert.strictEqual(status(target(line)), 400, line)
    }
  })

  it('carries CONNECT only, and only to 443', () => {
    assert.strictEqual(status(target('GET http://pypi.org/ HTTP/1.1')), 405)
    assert.strictEqual(status(target('POST pypi.org:443 HTTP/1.1')), 405)
    assert.strictEqual(status(target('CONNECT pypi.org:22 HTTP/1.1')), 403)
    assert.strictEqual(status(target('CONNECT pypi.org:8443 HTTP/1.1')), 403)
    assert.strictEqual(status(target('CONNECT pypi.org HTTP/1.1')), 400)
  })

  it('takes a hostname and nothing that is not one', () => {
    // An address literal can never match a list of names, but saying so is
    // better than a confusing "not a destination this VM may reach".
    for (const host of ['151.101.64.223', '[::1]', '*.pypi.org', 'pypi..org', '-pypi.org']) {
      assert.strictEqual(status(target(`CONNECT ${host}:443 HTTP/1.1`)), 403, host)
    }
  })

  it('normalises the spellings of one name', () => {
    for (const host of ['PyPI.org', 'pypi.org.']) {
      assert.deepStrictEqual(target(`CONNECT ${host}:443 HTTP/1.1`), {
        _tag: 'Open',
        host: 'pypi.org',
        port: 443,
      })
    }
  })

  it('refuses a request line that is not one', () => {
    assert.strictEqual(status(target('CONNECT pypi.org:443')), 400)
    assert.strictEqual(status(target('CONNECT pypi.org:443 SSH-2.0')), 400)
    assert.strictEqual(status(target('')), 400)
  })
})

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('Broker.splitHead', () => {
  it('waits for the blank line that ends the head', () => {
    for (const sent of [
      '',
      'CONNECT pypi.org:443 HTTP/1.1\r\n',
      'CONNECT pypi.org:443 HTTP/1.1\r\nHost: pypi.org:443\r\n',
      'CONNECT pypi.org:443 HTTP/1.1\r\nHost: pypi.org:443\r\n\r',
    ]) {
      assert.isUndefined(Broker.splitHead(encode(sent)), JSON.stringify(sent))
    }
  })

  it('answers the request line, and drops the headers', () => {
    const split = Broker.splitHead(
      encode('CONNECT pypi.org:443 HTTP/1.1\r\nHost: pypi.org:443\r\nUser-Agent: curl\r\n\r\n'),
    )
    assert.strictEqual(split?.line, 'CONNECT pypi.org:443 HTTP/1.1')
    assert.deepStrictEqual(split?.rest, new Uint8Array())
  })

  it('keeps what followed the head, byte for byte', () => {
    // The start of a TLS hello, with bytes that are not UTF-8 and a CRLF of its own.
    const hello = new Uint8Array([0x16, 0x03, 0x01, 0x02, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x0d, 0x0a])
    const split = Broker.splitHead(
      new Uint8Array([...encode('CONNECT pypi.org:443 HTTP/1.0\r\n\r\n'), ...hello]),
    )
    assert.strictEqual(split?.line, 'CONNECT pypi.org:443 HTTP/1.0')
    assert.deepStrictEqual(split?.rest, hello)
  })
})

describe('Broker.connectPorts', () => {
  it('holds the port of every connection the broker makes', () => {
    // Its launch lets it connect to these ports and no others, so one missing
    // here would fail as a refused connection on the host and in no test.
    const held = [...grants, ...inference, ...servers]
    for (const decision of [
      advertise('/you/api/info/refs'),
      call('/api.anthropic.com/v1/messages'),
      call('/openrouter.ai/api/v1/chat/completions'),
      local('/local/llama-swap/v1/chat/completions'),
      local('/local/ollama/v1/models', 'GET'),
    ]) {
      const upstream = decision._tag === 'Deny' ? '' : decision.upstream
      const url = new URL(upstream)
      const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
      assert.include(Broker.connectPorts(held), port, upstream)
    }
    const tunnel = Broker.allowTunnel(
      ['pypi.org'],
      Broker.parseConnect('CONNECT pypi.org:443 HTTP/1.1'),
    )
    assert.include(Broker.connectPorts([]), tunnel._tag === 'Open' ? tunnel.port : 0)
  })

  it('adds a model server’s port, once, and nothing for any other grant', () => {
    assert.deepStrictEqual(Broker.connectPorts([...grants, ...inference]), [443, 53])
    assert.deepStrictEqual(Broker.connectPorts(servers), [443, 53, 8080, 11434])
    assert.deepStrictEqual(
      Broker.connectPorts([
        { name: 'one', port: 8080, profile: 'model-server' },
        { name: 'two', port: 8080, profile: 'model-server' },
        { name: 'https', port: 443, profile: 'model-server' },
      ]),
      [443, 53, 8080],
    )
  })
})

describe('Broker.allowTunnel', () => {
  const hosts = ['pypi.org', 'files.pythonhosted.org']
  const ask = (host: string) =>
    Broker.allowTunnel(hosts, Broker.parseConnect(`CONNECT ${host}:443 HTTP/1.1`))

  it('allows exactly what is listed, in any case', () => {
    assert.strictEqual(ask('pypi.org')._tag, 'Open')
    assert.strictEqual(ask('files.pythonhosted.org')._tag, 'Open')
    assert.strictEqual(ask('PYPI.ORG')._tag, 'Open')
  })

  it('does not match by suffix, which is how a lookalike gets reached', () => {
    for (const host of ['pypi.org.attacker.example', 'evil-pypi.org', 'a.pypi.org']) {
      assert.strictEqual(ask(host)._tag, 'Refuse', host)
    }
  })

  it('reaches nothing when nothing is listed', () => {
    const refused = Broker.allowTunnel([], Broker.parseConnect('CONNECT pypi.org:443 HTTP/1.1'))
    assert.strictEqual(refused._tag, 'Refuse')
  })

  it('keeps an earlier refusal rather than reconsidering it', () => {
    const refused = Broker.allowTunnel(hosts, Broker.parseConnect('CONNECT pypi.org:22 HTTP/1.1'))
    assert.strictEqual(refused._tag === 'Refuse' ? refused.status : 0, 403)
  })

  it('allows any name under "any", and nothing else about the request', () => {
    const open = Broker.allowTunnel('any', Broker.parseConnect('CONNECT example.com:443 HTTP/1.1'))
    assert.strictEqual(open._tag, 'Open')
    for (const line of ['CONNECT example.com:22 HTTP/1.1', 'CONNECT 203.0.113.9:443 HTTP/1.1']) {
      assert.strictEqual(Broker.allowTunnel('any', Broker.parseConnect(line))._tag, 'Refuse', line)
    }
  })
})

describe('Broker.tunnels', () => {
  it('runs a tunnel for a list with names in it, or for any name', () => {
    assert.isTrue(Broker.tunnels(['pypi.org']))
    assert.isTrue(Broker.tunnels('any'))
    assert.isFalse(Broker.tunnels([]))
  })
})

describe('Broker.isReachableAddress', () => {
  it('accepts an ordinary public address', () => {
    for (const address of ['151.101.64.223', '8.8.8.8', '2606:4700::6810:85e5']) {
      assert.isTrue(Broker.isReachableAddress(address), address)
    }
  })

  it('refuses this machine’s own networks, which is what a name can be pointed at', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // the cloud metadata address
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      'fec0::1',
      'ff02::1',
    ]) {
      assert.isFalse(Broker.isReachableAddress(address), address)
    }
  })

  it('judges a v4 address wearing a v6 spelling as the address it is', () => {
    assert.isFalse(Broker.isReachableAddress('::ffff:127.0.0.1'))
    assert.isFalse(Broker.isReachableAddress('::ffff:10.0.0.1'))
    assert.isTrue(Broker.isReachableAddress('::ffff:8.8.8.8'))
    assert.isFalse(Broker.isReachableAddress('2002:7f00:0001::')) // 6to4
  })

  it('judges the v4 address a v6 one carries however it is spelled', () => {
    // A connection to a mapped address is a connection to the v4 address
    // itself, and one to the others reaches it through a translator, so a
    // name resolving to any of them points inside this machine's networks.
    for (const address of [
      '::ffff:a00:1', // 10.0.0.1, mapped
      '::ffff:7f00:1', // 127.0.0.1, mapped
      '::ffff:a9fe:a9fe', // the cloud metadata address, mapped
      '0:0:0:0:0:ffff:a00:1',
      '0000:0000:0000:0000:0000:FFFF:0A00:0001',
      '::a00:1', // compatible
      '::7f00:1',
      '::10.0.0.1',
      '::ffff:0:a00:1', // translated, for SIIT
      '::ffff:0:10.0.0.1',
      '64:ff9b::a00:1', // NAT64
      '64:ff9b::10.0.0.1',
      '64:ff9b::a9fe:a9fe',
    ]) {
      assert.isFalse(Broker.isReachableAddress(address), address)
    }
    for (const address of ['::ffff:808:808', '::ffff:0:808:808', '64:ff9b::808:808']) {
      assert.isTrue(Broker.isReachableAddress(address), address)
    }
  })

  it('refuses the v6 ranges that carry a v4 address it cannot place', () => {
    for (const address of [
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
      '2001::a00:1',
      '64:ff9b:1::a00:1', // local-use NAT64, which places it as each network chooses
      '64:ff9b:1:a00:1::',
      '2002:a00:1::', // 6to4
    ]) {
      assert.isFalse(Broker.isReachableAddress(address), address)
    }
  })

  it('accepts only global unicast of what carries no v4 address', () => {
    for (const address of ['2001:4860:4860::8888', '2a00:1450:4001:81c::200e', '3fff::1']) {
      assert.isTrue(Broker.isReachableAddress(address), address)
    }
    for (const address of ['100::1', '4000::1', 'fe8::1', 'fc::1', '1::', 'fe80::1%eth0']) {
      assert.isFalse(Broker.isReachableAddress(address), address)
    }
  })

  it('refuses what it cannot read, rather than passing it through', () => {
    for (const address of [
      '',
      'not-an-address',
      '999.1.1.1',
      '1.2.3',
      ':::',
      '2001:db8::1::1',
      '2001:db8:1:2:3:4:5:6:7',
      '2001:db8:1:2::3:4:5:6',
      '2001:db8::12345',
      '2001:db8::g',
      ':2001:db8::1',
      '2001:db8:1:2:3:4:5:',
      '::ffff:10.0.0.256',
      '::ffff:10.0.0',
      '10.0.0.1::',
      '::10.0.0.1:0',
    ]) {
      assert.isFalse(Broker.isReachableAddress(address), address)
    }
  })
})

describe('Broker.reachableAddresses', () => {
  it('keeps every acceptable address, in the resolver’s order', () => {
    assert.deepStrictEqual(
      Broker.reachableAddresses([
        { address: '2a04:4e42:600::223' },
        { address: '151.101.192.223' },
        { address: '151.101.0.223' },
      ]),
      ['2a04:4e42:600::223', '151.101.192.223', '151.101.0.223'],
    )
  })

  it('drops this machine’s own networks without dropping what follows them', () => {
    assert.deepStrictEqual(
      Broker.reachableAddresses([
        { address: '127.0.0.1' },
        { address: '192.168.1.1' },
        { address: '8.8.8.8' },
      ]),
      ['8.8.8.8'],
    )
  })

  it('is empty when a name resolves only inward, which is the refusal case', () => {
    assert.deepStrictEqual(Broker.reachableAddresses([{ address: '127.0.0.1' }]), [])
  })
})

describe('Broker.preferAddressFamily', () => {
  const resolved = ['2a04:4e42:600::223', '2a04:4e42::223', '151.101.192.223', '151.101.0.223']

  it('leaves the resolver’s order alone until something has connected', () => {
    assert.deepStrictEqual(Broker.preferAddressFamily(resolved, undefined), resolved)
  })

  it('moves the family that worked in front, keeping each family’s own order', () => {
    assert.deepStrictEqual(Broker.preferAddressFamily(resolved, 'v4'), [
      '151.101.192.223',
      '151.101.0.223',
      '2a04:4e42:600::223',
      '2a04:4e42::223',
    ])
  })

  it('drops nothing, because a preference is an ordering and not a filter', () => {
    assert.deepStrictEqual(
      [...Broker.preferAddressFamily(resolved, 'v6')].toSorted(),
      [...resolved].toSorted(),
    )
  })
})

describe('Broker.parseTunnelHosts', () => {
  it('reads a list of names', () => {
    assert.deepStrictEqual(Broker.parseTunnelHosts('["PyPI.org","crates.io"]'), {
      hosts: ['pypi.org', 'crates.io'],
    })
    assert.deepStrictEqual(Broker.parseTunnelHosts('[]'), { hosts: [] })
  })

  it('reads "any" as any name, and a host called any as a list of one', () => {
    assert.deepStrictEqual(Broker.parseTunnelHosts('"any"'), { hosts: 'any' })
    assert.deepStrictEqual(Broker.parseTunnelHosts('["any"]'), { hosts: ['any'] })
    assert.isTrue('message' in Broker.parseTunnelHosts('"all"'))
  })

  it('refuses anything that is not a hostname rather than dropping it', () => {
    // A dropped destination is a package manager failing with nothing naming
    // the cause, which is worse than refusing to start.
    for (const json of [
      '["https://pypi.org"]',
      '["pypi.org:443"]',
      '["*.pypi.org"]',
      '[1]',
      '{}',
      'x',
    ]) {
      assert.isTrue('message' in Broker.parseTunnelHosts(json), json)
    }
  })
})

describe('Broker.excludeHostAddresses', () => {
  it('drops the addresses this host holds, keeping the rest in order', async () => {
    const own = new Set(['198.51.100.7', '2001:db8::7'])
    const kept = await Broker.excludeHostAddresses(
      ['203.0.113.1', '198.51.100.7', '2001:db8::1', '2001:db8::7'],
      address => Promise.resolve(own.has(address)),
    )
    assert.deepStrictEqual(kept, ['203.0.113.1', '2001:db8::1'])
  })

  it('drops everything when every address is this host’s', async () => {
    const kept = await Broker.excludeHostAddresses(['203.0.113.1'], () => Promise.resolve(true))
    assert.deepStrictEqual(kept, [])
  })
})

describe('Broker.isHostAddress', () => {
  // Asks the kernel of the machine running the test, so it can only use
  // addresses whose answer is the same everywhere: loopback is always this
  // host's, and the documentation ranges are never anyone's.
  const ipv6 = Object.values(networkInterfaces())
    .flat()
    .some(entry => entry?.address === '::1')

  it('reads loopback as this host’s', async () => {
    assert.isTrue(await Broker.isHostAddress('127.0.0.1'))
    if (ipv6) assert.isTrue(await Broker.isHostAddress('::1'))
  })

  it('reads an address no interface holds as not this host’s', async () => {
    assert.isFalse(await Broker.isHostAddress('192.0.2.1'))
    if (ipv6) assert.isFalse(await Broker.isHostAddress('2001:db8::1'))
  })

  it('reads an address this machine holds as this host’s', async () => {
    const held = Object.values(networkInterfaces())
      .flat()
      .filter(entry => entry !== undefined && !entry.internal && !entry.address.startsWith('fe80'))
      .map(entry => entry?.address ?? '')
    for (const address of held) assert.isTrue(await Broker.isHostAddress(address), address)
  })
})

/** A directory for one test's sockets, removed when `use` settles. */
const withSocketDir = async <A>(use: (dir: string) => Promise<A>): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), 'igloo-broker-'))
  try {
    return await use(dir)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}

/**
 * Connect to the tunnel and send nothing. Answers the status line of whatever
 * the tunnel wrote back, or `'held'` if it wrote nothing within `waitMs` — a
 * connection still waiting for its request line, counted against the cap.
 */
const knock = (
  socketPath: string,
  waitMs = 200,
): Promise<{ readonly answer: string; readonly socket: Bun.Socket }> =>
  new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    Bun.connect({
      socket: {
        data(socket, chunk) {
          clearTimeout(timer)
          resolve({ answer: new TextDecoder().decode(chunk).split('\r\n')[0] ?? '', socket })
        },
        open(socket) {
          timer = setTimeout(() => {
            resolve({ answer: 'held', socket })
          }, waitMs)
        },
      },
      unix: socketPath,
    }).catch(reject)
  })

/** Connect to the tunnel, and collect everything it writes back. */
const dial = async (
  socketPath: string,
): Promise<{ readonly received: () => string; readonly socket: Bun.Socket }> => {
  let received = ''
  const socket = await Bun.connect({
    socket: {
      data(_socket, chunk) {
        received += new TextDecoder().decode(chunk)
      },
    },
    unix: socketPath,
  })
  return { received: () => received, socket }
}

describe('Broker.serveTunnel', () => {
  it('holds every connection the guest opens, however many', () =>
    withSocketDir(async dir => {
      const socketPath = join(dir, 'proxy.sock')
      const listener = Broker.serveTunnel(socketPath, ['example.com'])
      const sockets: Array<Bun.Socket> = []
      try {
        const opened = await Promise.all(Array.from({ length: 64 }, () => knock(socketPath)))
        sockets.push(...opened.map(({ socket }) => socket))
        assert.deepStrictEqual(
          opened.map(({ answer }) => answer),
          opened.map(() => 'held'),
        )
      } finally {
        for (const socket of sockets) socket.end()
        listener.stop(true)
      }
    }))

  it('carries a download whole to a guest that reads slower than it arrives', () =>
    withSocketDir(async dir => {
      // A destination that sends as fast as it is let, and a guest that stops
      // reading for a while: everything the destination sent arrives, because
      // the tunnel stops reading from it rather than buffering it.
      const size = 32 * 1024 * 1024
      const chunk = new Uint8Array(256 * 1024).fill(0x5a)
      let offered = 0
      let stalled = 0
      const feed = (socket: Bun.Socket): void => {
        while (offered < size) {
          const rest = chunk.subarray(offered % chunk.byteLength)
          const written = socket.write(rest)
          offered += Math.max(0, written)
          if (written < rest.byteLength) {
            stalled++
            return
          }
        }
        socket.end()
      }
      const destination = Bun.listen({
        hostname: '127.0.0.1',
        port: 0,
        socket: { drain: feed, open: feed },
      })
      const socketPath = join(dir, 'proxy.sock')
      const listener = Broker.serveTunnel(socketPath, ['example.com'], () =>
        Promise.resolve({ addresses: ['127.0.0.1'], port: destination.port }),
      )
      let received = 0
      let head = ''
      const done = Promise.withResolvers<void>()
      const guest = await Bun.connect({
        socket: {
          close() {
            done.resolve()
          },
          data(_socket, bytes) {
            if (head.includes('\r\n\r\n')) {
              received += bytes.byteLength
              return
            }
            head += new TextDecoder().decode(bytes)
            const end = head.indexOf('\r\n\r\n')
            if (end !== -1) received += head.length - end - 4
          },
        },
        unix: socketPath,
      })
      try {
        guest.write('CONNECT example.com:443 HTTP/1.1\r\n\r\n')
        for (let attempt = 0; attempt < 100 && !head.includes('\r\n\r\n'); attempt++) {
          await Bun.sleep(10)
        }
        assert.strictEqual(head.split('\r\n')[0], 'HTTP/1.1 200 Connection Established')
        guest.pause()
        await Bun.sleep(500)
        guest.resume()
        await done.promise
        assert.strictEqual(received, size)
        assert.isAbove(stalled, 0)
      } finally {
        guest.end()
        listener.stop(true)
        destination.stop(true)
      }
    }))

  it('reads the request head through its blank line, however it arrives', () =>
    withSocketDir(async dir => {
      const socketPath = join(dir, 'proxy.sock')
      const listener = Broker.serveTunnel(socketPath, ['example.com'])
      const { received, socket } = await dial(socketPath)
      try {
        // A destination outside the scope, so the decision is a refusal and
        // nothing is resolved. Each piece is its own write, read on its own.
        for (const piece of [
          'CONNECT elsewhere.example:443 HTTP/1.1\r\n',
          'Host: elsewhere.example:443\r\n',
        ]) {
          socket.write(piece)
          await Bun.sleep(100)
          assert.strictEqual(received(), '', `answered after ${JSON.stringify(piece)}`)
        }
        socket.write('\r\n')
        for (let attempt = 0; attempt < 40 && received() === ''; attempt++) await Bun.sleep(25)
        assert.strictEqual(received().split('\r\n')[0], 'HTTP/1.1 403 Forbidden')
      } finally {
        socket.end()
        listener.stop(true)
      }
    }))

  it('records the destination it refused, once the request has named one', () =>
    auditing(audited =>
      withSocketDir(async dir => {
        const socketPath = join(dir, 'proxy.sock')
        const listener = Broker.serveTunnel(socketPath, ['example.com'])
        try {
          for (const line of ['CONNECT elsewhere.example:443', 'CONNECT elsewhere.example']) {
            const { received, socket } = await dial(socketPath)
            socket.write(`${line} HTTP/1.1\r\n\r\n`)
            for (let attempt = 0; attempt < 40 && received() === ''; attempt++) {
              await Bun.sleep(25)
            }
            socket.end()
          }
          const denied = audited.filter(
            (event): event is Record<string, unknown> =>
              typeof event === 'object' &&
              event !== null &&
              'event' in event &&
              event.event === 'tunnel-deny',
          )
          assert.deepStrictEqual(
            denied.map(event => event['target']),
            ['elsewhere.example:443', undefined],
          )
        } finally {
          listener.stop(true)
        }
      }),
    ))

  it('refuses a head that does not end', () =>
    withSocketDir(async dir => {
      const socketPath = join(dir, 'proxy.sock')
      const listener = Broker.serveTunnel(socketPath, ['example.com'])
      const { received, socket } = await dial(socketPath)
      try {
        socket.write(`CONNECT elsewhere.example:443 HTTP/1.1\r\nX-Pad: ${'a'.repeat(16 * 1024)}`)
        for (let attempt = 0; attempt < 40 && received() === ''; attempt++) await Bun.sleep(25)
        assert.strictEqual(received().split('\r\n')[0], 'HTTP/1.1 400 Bad Request')
      } finally {
        socket.end()
        listener.stop(true)
      }
    }))

  it('joins a name the broker answers to its own listener, whatever the destinations', () =>
    auditing(audited =>
      withSocketDir(async dir => {
        // Stands in for the TLS listener: whatever it is sent, it sends back.
        const listenerPath = join(dir, 'tls.sock')
        const echo = Bun.listen({
          socket: {
            data(socket, chunk) {
              socket.write(chunk)
            },
          },
          unix: listenerPath,
        })
        const socketPath = join(dir, 'proxy.sock')
        const listener = Broker.serveTunnel(socketPath, [], Broker.publicDestinations, {
          names: ['github.com'],
          socket: listenerPath,
        })
        const answered = await dial(socketPath)
        const other = await dial(socketPath)
        try {
          answered.socket.write('CONNECT github.com:443 HTTP/1.1\r\n\r\nhello')
          for (let attempt = 0; attempt < 40 && !answered.received().endsWith('hello'); attempt++) {
            await Bun.sleep(25)
          }
          assert.strictEqual(
            answered.received(),
            'HTTP/1.1 200 Connection Established\r\n\r\nhello',
          )
          const opened = audited.find(
            (event): event is Record<string, unknown> =>
              typeof event === 'object' &&
              event !== null &&
              'event' in event &&
              event.event === 'tunnel-open',
          )
          assert.strictEqual(opened?.['answered'], true)
          assert.strictEqual(opened?.['target'], 'github.com:443')
          assert.notProperty(opened, 'address')

          other.socket.write('CONNECT example.com:443 HTTP/1.1\r\n\r\n')
          for (let attempt = 0; attempt < 40 && other.received() === ''; attempt++) {
            await Bun.sleep(25)
          }
          assert.strictEqual(other.received().split('\r\n')[0], 'HTTP/1.1 403 Forbidden')
        } finally {
          answered.socket.end()
          other.socket.end()
          listener.stop(true)
          echo.stop(true)
        }
      }),
    ))
})

/**
 * A certificate for github.com and its key, as PEM, made by openssl for this
 * run: a key kept in the tree is one a secret scanner reports.
 */
const tlsIdentity = (dir: string, name = 'github.com'): Broker.TlsIdentity => {
  const cert = join(dir, 'certificate.pem')
  const key = join(dir, 'key.pem')
  const made = Bun.spawnSync(
    [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${name}`,
      '-addext',
      `subjectAltName=DNS:${name}`,
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stderr: 'pipe', stdout: 'ignore' },
  )
  if (made.exitCode !== 0) {
    throw new Error(`openssl exited ${String(made.exitCode)}: ${made.stderr.toString()}`)
  }
  return { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') }
}

/**
 * What git does to reach a host through the tunnel: CONNECT, then TLS to the
 * host's name, trusting `ca`, then one request. Answers the whole response, or
 * the tunnel's refusal.
 */
const overTunnel = async (
  proxy: string,
  host: string,
  ca: string,
  request: string,
): Promise<string> => {
  const raw = connect(proxy)
  await new Promise<void>((resolve, reject) => {
    raw.once('connect', resolve)
    raw.once('error', reject)
  })
  raw.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`)
  const head = await new Promise<string>(resolve => {
    raw.once('data', (chunk: Buffer) => {
      resolve(chunk.toString())
    })
  })
  if (!head.startsWith('HTTP/1.1 200 ')) {
    raw.destroy()
    return head
  }
  const secured = connectTls({ ca, servername: host, socket: raw })
  await new Promise<void>((resolve, reject) => {
    secured.once('secureConnect', resolve)
    secured.once('error', reject)
  })
  let response = ''
  secured.on('data', (chunk: Buffer) => {
    response += chunk.toString()
  })
  const closed = new Promise<void>(resolve => {
    secured.once('close', () => {
      resolve()
    })
  })
  secured.write(request)
  await closed
  return response
}

/** A request git would send, addressed to `host`, ending the connection after it. */
const addressedTo = (host: string, path: string): string =>
  `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Basic Z3Vlc3Q6\r\nConnection: close\r\n\r\n`

describe('Broker.serveTls', () => {
  it('serves a request addressed to a granted host, reached the way git reaches it', () =>
    auditing(audited =>
      withSocketDir(async dir => {
        const identity = tlsIdentity(dir)
        const sent: Array<{ readonly init: RequestInit; readonly url: string }> = []
        const send = (url: string, init: RequestInit): Promise<Response> => {
          sent.push({ init, url })
          return Promise.resolve(new Response('refs'))
        }
        const ids = Broker.requestIds()
        const tlsPath = join(dir, 'tls.sock')
        const proxyPath = join(dir, 'proxy.sock')
        const plain = Broker.serveRequests(join(dir, 'http.sock'), grants, held, send, ids)
        const server = Broker.serveTls(tlsPath, grants, held, identity, [], send, ids)
        const tunnel = Broker.serveTunnel(proxyPath, [], Broker.publicDestinations, {
          names: ['github.com'],
          socket: tlsPath,
        })
        try {
          const served = await overTunnel(
            proxyPath,
            'github.com',
            identity.cert,
            addressedTo('github.com', '/you/api/info/refs?service=git-upload-pack'),
          )
          assert.strictEqual(served.split('\r\n')[0], 'HTTP/1.1 200 OK')
          assert.isTrue(served.endsWith('refs'))
          assert.strictEqual(
            sent[0]?.url,
            'https://github.com/you/api.git/info/refs?service=git-upload-pack',
          )
          assert.strictEqual(
            new Headers(sent[0]?.init.headers).get('Authorization'),
            `Basic ${btoa('x-access-token:ghp-test')}`,
          )

          // The name the request is addressed to decides, not the name the
          // connection was made to.
          const misdirected = await overTunnel(
            proxyPath,
            'github.com',
            identity.cert,
            addressedTo('gist.github.com', '/you'),
          )
          assert.match(misdirected.split('\r\n')[0] ?? '', /^HTTP\/1\.1 421 /)
          assert.strictEqual(sent.length, 1)

          // One count across both listeners, so that an id names one request.
          await plain.fetch(new Request(`${base}/local/llama-swap/v1/models`))
          const numbered = audited
            .filter(
              (event): event is Record<string, unknown> =>
                typeof event === 'object' &&
                event !== null &&
                'event' in event &&
                (event.event === 'allow' || event.event === 'deny'),
            )
            .map(event => [event['event'], event['id']])
          assert.deepStrictEqual(numbered, [
            ['allow', 1],
            ['deny', 2],
            ['deny', 3],
          ])
        } finally {
          tunnel.stop(true)
          await server.stop(true)
          await plain.stop(true)
        }
      }),
    ))

  it('sends a read no grant covers on bare, and passes its redirect back', () =>
    auditing(audited =>
      withSocketDir(async dir => {
        const identity = tlsIdentity(dir)
        const sent: Array<{ readonly init: RequestInit; readonly url: string }> = []
        const send = (url: string, init: RequestInit): Promise<Response> => {
          sent.push({ init, url })
          return Promise.resolve(
            new Response(null, {
              headers: { Location: 'https://objects.example/tool.tgz?signature=s' },
              status: 302,
            }),
          )
        }
        const tlsPath = join(dir, 'tls.sock')
        const proxyPath = join(dir, 'proxy.sock')
        const server = Broker.serveTls(tlsPath, grants, held, identity, ['github.com'], send)
        const tunnel = Broker.serveTunnel(proxyPath, ['github.com'], Broker.publicDestinations, {
          names: ['github.com'],
          socket: tlsPath,
        })
        try {
          const answered = await overTunnel(
            proxyPath,
            'github.com',
            identity.cert,
            addressedTo('github.com', '/someone/tool/releases/download/v1/tool.tgz'),
          )
          assert.strictEqual(answered.split('\r\n')[0], 'HTTP/1.1 302 Found')
          assert.match(
            answered,
            /\r\nlocation: https:\/\/objects\.example\/tool\.tgz\?signature=s\r\n/i,
          )
          assert.strictEqual(
            sent[0]?.url,
            'https://github.com/someone/tool/releases/download/v1/tool.tgz',
          )
          // The guest's own credential is dropped, and the broker's is not set.
          assert.isNull(new Headers(sent[0]?.init.headers).get('Authorization'))
          const allowed = audited.find(
            (event): event is Record<string, unknown> =>
              typeof event === 'object' &&
              event !== null &&
              'event' in event &&
              event.event === 'allow',
          )
          assert.strictEqual(allowed?.['operation'], 'read')
          assert.notProperty(allowed, 'credential')
        } finally {
          tunnel.stop(true)
          await server.stop(true)
        }
      }),
    ))
})

/**
 * Run `use` with the audit lines it causes collected rather than printed, each
 * parsed from the JSON it was written as.
 */
const auditing = async <A>(use: (audited: ReadonlyArray<unknown>) => Promise<A>): Promise<A> => {
  const audited: Array<unknown> = []
  const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    if (typeof line === 'string') audited.push(JSON.parse(line))
  })
  try {
    return await use(audited)
  } finally {
    log.mockRestore()
  }
}

// A ClientHello, built field by field, so that each test can break one.
const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff]
const extension = (type: number, data: readonly number[] = []): number[] => [
  ...u16(type),
  ...u16(data.length),
  ...data,
]
const serverNameExtension = (...names: readonly string[]): number[] => {
  const entries = names.flatMap(name => {
    const bytes = [...Buffer.from(name, 'latin1')]
    return [0, ...u16(bytes.length), ...bytes]
  })
  return extension(0, [...u16(entries.length), ...entries])
}
/** The handshake message: a ClientHello with these extensions, or none at all. */
const clientHello = (extensions?: ReadonlyArray<readonly number[]>): number[] => {
  const flat = extensions?.flat() ?? []
  // Version, random, session id, two cipher suites, no compression.
  const body = [
    3,
    3,
    ...Array.from({ length: 32 }, () => 7),
    32,
    ...Array.from({ length: 32 }, () => 9),
    ...u16(4),
    0x13,
    0x01,
    0x13,
    0x02,
    1,
    0,
    ...(extensions === undefined ? [] : [...u16(flat.length), ...flat]),
  ]
  return [1, (body.length >> 16) & 0xff, ...u16(body.length & 0xffff), ...body]
}
/** A handshake message in records of at most `size` bytes each. */
const records = (handshake: readonly number[], size = 16384): Uint8Array => {
  const out: number[] = []
  for (let at = 0; at < handshake.length; at += size) {
    const part = handshake.slice(at, at + size)
    out.push(22, 3, 1, ...u16(part.length), ...part)
  }
  return Uint8Array.from(out)
}
/** As Chromium sends it: GREASE, an ECH extension, and the name. */
const helloFor = (name: string): Uint8Array =>
  records(
    clientHello([
      extension(0x8a8a),
      extension(0xfe0d, [0, 0, 1, 0, 1, 7, 0, 0]),
      serverNameExtension(name),
      extension(0x002b, [2, 3, 4]),
    ]),
  )

describe('Broker.readClientHello', () => {
  it('reads the host_name of the server_name extension', () => {
    assert.deepStrictEqual(Broker.readClientHello(helloFor('pypi.org')), {
      _tag: 'Hello',
      serverName: 'pypi.org',
    })
  })

  it('waits for the whole hello, however it is split into segments and records', () => {
    const hello = clientHello([serverNameExtension('pypi.org')])
    for (const size of [1, 7, 100, hello.length]) {
      const bytes = records(hello, size)
      for (let cut = 0; cut < bytes.byteLength; cut++) {
        assert.deepStrictEqual(Broker.readClientHello(bytes.subarray(0, cut)), { _tag: 'More' })
      }
      assert.deepStrictEqual(Broker.readClientHello(bytes), {
        _tag: 'Hello',
        serverName: 'pypi.org',
      })
    }
  })

  it('reads the hello alone, whatever follows it', () => {
    const bytes = Uint8Array.from([...helloFor('pypi.org'), 23, 3, 3, 0, 2, 1, 2])
    assert.deepStrictEqual(Broker.readClientHello(bytes), {
      _tag: 'Hello',
      serverName: 'pypi.org',
    })
  })

  it('finds no name in a hello without the extension, or without extensions', () => {
    for (const hello of [clientHello([extension(0x002b, [2, 3, 4])]), clientHello()]) {
      assert.deepStrictEqual(Broker.readClientHello(records(hello)), {
        _tag: 'Hello',
        serverName: undefined,
      })
    }
  })

  it('says a session that does not begin with a handshake record is not TLS', () => {
    assert.deepStrictEqual(Broker.readClientHello(Buffer.from('SSH-2.0-OpenSSH_9.9\r\n')), {
      _tag: 'NotTls',
    })
    assert.deepStrictEqual(Broker.readClientHello(Buffer.from('GET / HTTP/1.1\r\n')), {
      _tag: 'NotTls',
    })
  })

  it('refuses a hello two readers could take differently, or one no client sends', () => {
    const hello = clientHello([serverNameExtension('pypi.org')])
    const malformed: ReadonlyArray<readonly [string, Uint8Array]> = [
      [
        'a name extension twice',
        records(
          clientHello([serverNameExtension('pypi.org'), serverNameExtension('evil.example')]),
        ),
      ],
      ['two host names', records(clientHello([serverNameExtension('pypi.org', 'evil.example')]))],
      ['another extension twice', records(clientHello([extension(0x2b), extension(0x2b)]))],
      [
        'an alert inside the hello',
        Uint8Array.from([...records(hello.slice(0, 10)), 21, 3, 3, 0, 2, 2, 40]),
      ],
      ['an empty record', Uint8Array.from([22, 3, 1, 0, 0])],
      ['a record past 2^14', Uint8Array.from([22, 3, 1, ...u16(16385)])],
      ['a record that is not TLS', Uint8Array.from([22, 9, 1, 0, 4, 1, 0, 0, 0])],
      ['a ServerHello', records([2, ...hello.slice(1)])],
      ['a hello past the limit', records([1, 0, 0x80, 0, ...hello.slice(4)])],
      [
        'extensions short of the hello',
        records([...hello.slice(0, 1), 0, ...u16(hello.length - 4 + 1), ...hello.slice(4), 0]),
      ],
      ['a truncated hello', records([1, 0, 0, 10, ...hello.slice(4, 14)])],
    ]
    for (const [what, bytes] of malformed) {
      assert.strictEqual(Broker.readClientHello(bytes)._tag, 'Malformed', what)
    }
  })

  it('holds a name to the host whatever its case, a trailing dot aside', () => {
    assert.isTrue(Broker.sameServerName('PyPI.org.', 'pypi.org'))
    assert.isFalse(Broker.sameServerName('files.pypi.org', 'pypi.org'))
    assert.isFalse(Broker.sameServerName('pypi.org\u0000', 'pypi.org'))
  })
})

/**
 * A destination for a tunnel that records every byte that reaches it and says
 * a greeting to whoever connects, and the tunnel in front of it: under `hosts`,
 * with every name resolving to it.
 */
const fronted = async (
  dir: string,
  hosts: Broker.TunnelScope,
  helloDeadlineMs?: number,
): Promise<{
  readonly reached: () => number
  readonly stop: () => void
  readonly socketPath: string
}> => {
  let reached = 0
  const destination = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(_socket, bytes) {
        reached += bytes.byteLength
      },
      open(socket) {
        socket.write('greeting')
      },
    },
  })
  const socketPath = join(dir, 'proxy.sock')
  const tunnel = Broker.serveTunnel(
    socketPath,
    hosts,
    () => Promise.resolve({ addresses: ['127.0.0.1'], port: destination.port }),
    undefined,
    helloDeadlineMs,
  )
  return {
    reached: () => reached,
    socketPath,
    stop: () => {
      tunnel.stop(true)
      destination.stop(true)
    },
  }
}

/**
 * Open a tunnel to `host` and send `bytes` through it in `chunks` pieces,
 * then wait for the session to settle: what reached the destination, whether
 * the tunnel closed, and what came back.
 */
const session = async (
  socketPath: string,
  host: string,
  bytes: Uint8Array,
  chunks = 1,
  settleMs = 300,
): Promise<{ readonly closed: boolean; readonly received: string }> => {
  let received = ''
  let closed = false
  const socket = await Bun.connect({
    socket: {
      close() {
        closed = true
      },
      data(_socket, chunk) {
        received += new TextDecoder().decode(chunk)
      },
    },
    unix: socketPath,
  })
  socket.write(`CONNECT ${host}:443 HTTP/1.1\r\n\r\n`)
  for (let attempt = 0; attempt < 40 && !received.includes('\r\n\r\n'); attempt++) {
    await Bun.sleep(25)
  }
  const size = Math.ceil(bytes.byteLength / chunks)
  for (let at = 0; at < bytes.byteLength; at += size) {
    socket.write(bytes.subarray(at, at + size))
    await Bun.sleep(20)
  }
  await Bun.sleep(settleMs)
  // Read before ending it, since ending it closes it.
  const ended = closed
  if (!ended) socket.end()
  return { closed: ended, received }
}

const denials = (audited: ReadonlyArray<unknown>): Array<Record<string, unknown>> =>
  audited.filter(
    (event): event is Record<string, unknown> =>
      typeof event === 'object' &&
      event !== null &&
      'event' in event &&
      event.event === 'tunnel-deny',
  )

describe('the tunnel holds a TLS session to its CONNECT host', () => {
  it('splices a hello naming the host, sending the guest bytes on unchanged', () =>
    withSocketDir(async dir => {
      const tunnel = await fronted(dir, ['pypi.org'])
      try {
        const bytes = Uint8Array.from([...helloFor('PyPI.org.'), 23, 3, 3, 0, 1, 0])
        const { closed, received } = await session(tunnel.socketPath, 'pypi.org', bytes)
        assert.isFalse(closed)
        assert.include(received, 'greeting')
        assert.strictEqual(tunnel.reached(), bytes.byteLength)
      } finally {
        tunnel.stop()
      }
    }))

  it('closes a hello naming another host, before any of it reaches the destination', () =>
    auditing(audited =>
      withSocketDir(async dir => {
        const tunnel = await fronted(dir, ['pypi.org'])
        try {
          const { closed } = await session(tunnel.socketPath, 'pypi.org', helloFor('evil.example'))
          assert.isTrue(closed)
          assert.strictEqual(tunnel.reached(), 0)
          assert.deepStrictEqual(
            denials(audited).map(event => [event['target'], event['reason']]),
            [['pypi.org:443', 'the TLS ClientHello names another server than pypi.org']],
          )
        } finally {
          tunnel.stop()
        }
      }),
    ))

  it('reads a hello split across segments and records whole', () =>
    withSocketDir(async dir => {
      const tunnel = await fronted(dir, ['pypi.org'])
      try {
        const bytes = records(clientHello([serverNameExtension('pypi.org')]), 40)
        const { closed } = await session(tunnel.socketPath, 'pypi.org', bytes, 9)
        assert.isFalse(closed)
        assert.strictEqual(tunnel.reached(), bytes.byteLength)
      } finally {
        tunnel.stop()
      }
    }))

  it('closes a hello with no name, a malformed one, and one too large', () =>
    auditing(audited =>
      withSocketDir(async dir => {
        const tunnel = await fronted(dir, ['pypi.org'])
        try {
          const big = clientHello([
            serverNameExtension('pypi.org'),
            extension(
              0x15,
              Array.from({ length: 40_000 }, () => 0),
            ),
          ])
          for (const bytes of [
            records(clientHello([extension(0x2b, [2, 3, 4])])),
            records(clientHello([serverNameExtension('pypi.org', 'evil.example')])),
            records(big),
          ]) {
            const { closed } = await session(tunnel.socketPath, 'pypi.org', bytes)
            assert.isTrue(closed)
          }
          assert.strictEqual(tunnel.reached(), 0)
          assert.lengthOf(denials(audited), 3)
        } finally {
          tunnel.stop()
        }
      }),
    ))

  it('closes a hello that never completes, once its deadline passes', () =>
    auditing(audited =>
      withSocketDir(async dir => {
        const tunnel = await fronted(dir, ['pypi.org'], 200)
        try {
          const partial = helloFor('pypi.org').subarray(0, 20)
          const { closed } = await session(tunnel.socketPath, 'pypi.org', partial, 1, 600)
          assert.isTrue(closed)
          assert.strictEqual(tunnel.reached(), 0)
          assert.deepStrictEqual(
            denials(audited).map(event => event['reason']),
            ['no whole TLS ClientHello arrived'],
          )
        } finally {
          tunnel.stop()
        }
      }),
    ))

  it('splices a session that is not TLS, such as ssh over port 443', () =>
    withSocketDir(async dir => {
      const tunnel = await fronted(dir, ['ssh.github.com'])
      try {
        const bytes = Buffer.from('SSH-2.0-OpenSSH_9.9\r\n')
        const { closed, received } = await session(tunnel.socketPath, 'ssh.github.com', bytes)
        assert.isFalse(closed)
        assert.include(received, 'greeting')
        assert.strictEqual(tunnel.reached(), bytes.byteLength)
      } finally {
        tunnel.stop()
      }
    }))

  it('holds a hello carrying the ECH extension to its outer name, as any other', () =>
    withSocketDir(async dir => {
      const tunnel = await fronted(dir, ['pypi.org'])
      try {
        const matching = await session(tunnel.socketPath, 'pypi.org', helloFor('pypi.org'))
        assert.isFalse(matching.closed)
        const other = await session(tunnel.socketPath, 'pypi.org', helloFor('cloudflare-ech.com'))
        assert.isTrue(other.closed)
        assert.strictEqual(tunnel.reached(), helloFor('pypi.org').byteLength)
      } finally {
        tunnel.stop()
      }
    }))

  it('reads no hello where any public name is allowed', () =>
    withSocketDir(async dir => {
      const tunnel = await fronted(dir, 'any')
      try {
        const bytes = helloFor('evil.example')
        const { closed } = await session(tunnel.socketPath, 'pypi.org', bytes)
        assert.isFalse(closed)
        assert.strictEqual(tunnel.reached(), bytes.byteLength)
      } finally {
        tunnel.stop()
      }
    }))
})

const held: ReadonlyMap<string, string> = new Map([['GITHUB_TOKEN', 'ghp-test']])

/** A guest's request for a repository's refs, as it reaches the broker. */
const refs = (repo: string): string =>
  `https://github.com/${repo}/info/refs?service=git-upload-pack`

/** What `serving` serves a test's requests through. */
interface Served {
  readonly fetch: (request: Request | string) => Promise<Response>
}

/**
 * Serve `granted` with `send` standing in for the provider, for as long as
 * `use` runs. A request in the path form, to `http://broker/…`, is the plain
 * listener's; one addressed to a profile's host by name is the TLS listener's,
 * as the tunnel would hand it over. One count of ids across both.
 */
const serving = <A>(
  granted: readonly Broker.Grant[],
  credentials: ReadonlyMap<string, string>,
  send: NonNullable<Parameters<typeof Broker.serveRequests>[3]>,
  use: (server: Served) => Promise<A>,
): Promise<A> =>
  withSocketDir(async dir => {
    const ids = Broker.requestIds()
    const plain = Broker.serveRequests(join(dir, 'http.sock'), granted, credentials, send, ids)
    const named = granted.some(Broker.isProfileGrant)
      ? Broker.serveTls(
          join(dir, 'tls.sock'),
          granted,
          credentials,
          tlsIdentity(dir),
          [],
          send,
          ids,
        )
      : undefined
    try {
      return await use({
        fetch: async asked => {
          const request = typeof asked === 'string' ? new Request(asked) : asked
          return named === undefined || new URL(request.url).hostname === 'broker'
            ? plain.fetch(request)
            : named.fetch(request)
        },
      })
    } finally {
      await plain.stop(true)
      await named?.stop(true)
    }
  })

/** An upstream's answer that throws when read: a failure nothing in the broker expects. */
const unreadableStatus = (): Response =>
  Object.defineProperty(new Response('refs'), 'status', {
    get() {
      throw new Error('the status could not be read')
    },
  })

describe.concurrent('Broker.serveRequests', () => {
  // Longer than Bun's own idle timeout, which closes a connection that has had
  // nothing written to it for ten seconds, and fires up to two seconds late.
  const silence = 13_000

  it(
    'waits for an answer that takes longer than that to start',
    () =>
      withSocketDir(async dir => {
        const socketPath = join(dir, 'http.sock')
        const server = Broker.serveRequests(
          socketPath,
          [{ name: 'llama-swap', port: 8080, profile: 'model-server' }],
          new Map(),
          async () => {
            await Bun.sleep(silence)
            return new Response('models')
          },
        )
        try {
          const response = await fetch('http://broker/local/llama-swap/v1/models', {
            unix: socketPath,
          })
          assert.strictEqual(response.status, 200)
          assert.strictEqual(await response.text(), 'models')
        } finally {
          await server.stop(true)
        }
      }),
    silence + 10_000,
  )

  it(
    'carries a stream that falls silent for that long',
    () =>
      withSocketDir(async dir => {
        const socketPath = join(dir, 'http.sock')
        const server = Broker.serveRequests(
          socketPath,
          [{ name: 'llama-swap', port: 8080, profile: 'model-server' }],
          new Map(),
          () =>
            Promise.resolve(
              new Response(
                new ReadableStream({
                  async start(controller) {
                    controller.enqueue(new TextEncoder().encode('event: one\n\n'))
                    await Bun.sleep(silence)
                    controller.enqueue(new TextEncoder().encode('event: two\n\n'))
                    controller.close()
                  },
                }),
              ),
            ),
        )
        try {
          const response = await fetch('http://broker/local/llama-swap/v1/chat/completions', {
            body: JSON.stringify({ messages: [], model: 'claude-x', stream: true }),
            method: 'POST',
            unix: socketPath,
          })
          assert.strictEqual(response.status, 200)
          assert.strictEqual(await response.text(), 'event: one\n\nevent: two\n\n')
        } finally {
          await server.stop(true)
        }
      }),
    silence + 10_000,
  )

  it('audits a request that fails unexpectedly under its own id', () => {
    const upstreamCalled = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    return auditing(audited =>
      serving(
        grants,
        held,
        async () => {
          upstreamCalled.resolve()
          await second.promise
          return unreadableStatus()
        },
        async server => {
          // The first is still waiting on its upstream when the second is
          // served, and fails only after that.
          const first = server.fetch(refs('you/api'))
          await upstreamCalled.promise
          assert.strictEqual((await server.fetch(refs('someone/else'))).status, 403)
          second.resolve()
          assert.strictEqual((await first).status, 500)

          const failed = audited.filter(
            (event): event is { readonly id: unknown } =>
              typeof event === 'object' &&
              event !== null &&
              'reason' in event &&
              event.reason === 'Error: the status could not be read',
          )
          assert.deepStrictEqual(
            failed.map(({ id }) => id),
            [1],
          )
        },
      ),
    )
  })
})

describe('Broker.serveRequests, on GitHub’s API', () => {
  const sent: Array<{ readonly init: RequestInit; readonly url: string }> = []
  /** GitHub standing in: a listing with a second page, and a log's redirect. */
  const standIn = (url: string, init: RequestInit): Promise<Response> => {
    sent.push({ init, url })
    return Promise.resolve(
      url.endsWith('/logs')
        ? new Response(null, {
            headers: { Location: 'https://logs.example/run.zip?sig=s' },
            status: 302,
          })
        : new Response('{"total_count":2}', {
            headers: {
              'Content-Type': 'application/json',
              Link: '<https://api.github.com/repositories/42/actions/runs?page=2>; rel="next"',
              'Set-Cookie': 'logged_in=no',
              'X-RateLimit-Remaining': '4999',
            },
          }),
    )
  }

  it('reads with the broker’s token, and keeps the next page on the broker', () =>
    auditing(() =>
      serving(grants, held, standIn, async server => {
        sent.length = 0
        const response = await server.fetch(
          new Request('https://api.github.com/repos/you/api/actions/runs?per_page=1', {
            headers: {
              Accept: 'application/vnd.github+json',
              Authorization: 'token igloo-broker-holds-the-real-key',
              'User-Agent': 'GitHub CLI 2.102.0',
              'X-GitHub-Api-Version': '2022-11-28',
            },
          }),
        )
        assert.strictEqual(response.status, 200)
        assert.strictEqual(await response.text(), '{"total_count":2}')
        assert.strictEqual(
          response.headers.get('Link'),
          '<https://api.github.com/repos/you/api/actions/runs?page=2>; rel="next"',
        )
        assert.strictEqual(response.headers.get('X-RateLimit-Remaining'), '4999')
        assert.isNull(response.headers.get('Set-Cookie'))

        const headers = new Headers(sent[0]?.init.headers)
        assert.strictEqual(headers.get('Authorization'), 'Bearer ghp-test')
        assert.strictEqual(headers.get('X-GitHub-Api-Version'), '2022-11-28')
        assert.strictEqual(headers.get('User-Agent'), 'GitHub CLI 2.102.0')
        assert.strictEqual(sent[0]?.init.redirect, 'manual')
      }),
    ))

  it('sends no method, path or origin the guest names in a header, here or to a provider', () => {
    // A front end that honoured one of these would act on a method or path the
    // grant was not decided on: a read as a delete, or a call to another path.
    const steering = {
      Forwarded: 'for=10.0.0.1;host=elsewhere.example;proto=http',
      'X-Forwarded-For': '10.0.0.1',
      'X-Forwarded-Host': 'elsewhere.example',
      'X-Forwarded-Port': '80',
      'X-Forwarded-Prefix': '/admin',
      'X-Forwarded-Proto': 'http',
      'X-HTTP-Method': 'DELETE',
      'X-HTTP-Method-Override': 'DELETE',
      'X-Method-Override': 'DELETE',
      'X-Original-URL': '/repos/you/api/hooks',
      'X-Real-IP': '10.0.0.1',
      'X-Rewrite-URL': '/repos/you/api/hooks',
    }
    const providers: readonly Broker.Grant[] = [
      ...grants,
      shippedGrant('anthropic-messages', 'ANTHROPIC_KEY'),
    ]
    const keys = new Map([...held, ['ANTHROPIC_KEY', 'sk-test']])
    return auditing(() =>
      serving(providers, keys, standIn, async server => {
        sent.length = 0
        const read = await server.fetch(
          new Request('https://api.github.com/repos/you/api/issues', { headers: steering }),
        )
        const model = await server.fetch(
          new Request('https://api.anthropic.com/v1/messages', {
            body: '{"messages":[],"model":"claude-x"}',
            headers: steering,
            method: 'POST',
          }),
        )
        assert.deepStrictEqual([read.status, model.status], [200, 200])
        assert.deepStrictEqual(
          sent.map(({ init, url }) => [init.method, url]),
          [
            ['GET', 'https://api.github.com/repos/you/api/issues'],
            ['POST', 'https://api.anthropic.com/v1/messages'],
          ],
        )
        for (const { init, url } of sent) {
          const headers = new Headers(init.headers)
          for (const name of Object.keys(steering))
            assert.isNull(headers.get(name), `${url} ${name}`)
        }
      }),
    )
  })

  it('passes a log’s redirect back for the guest to follow, and follows none itself', () =>
    auditing(() =>
      serving(grants, held, standIn, async server => {
        sent.length = 0
        const response = await server.fetch(
          new Request('https://api.github.com/repos/you/api/actions/runs/7/logs'),
        )
        assert.strictEqual(response.status, 302)
        assert.strictEqual(response.headers.get('Location'), 'https://logs.example/run.zip?sig=s')
        assert.strictEqual(sent.length, 1)
      }),
    ))

  it('sends a GraphQL query on with its body and type, and the broker’s token', () =>
    auditing(audited =>
      serving(grants, held, standIn, async server => {
        sent.length = 0
        const query = '{"query":"query{viewer{login}}"}'
        const response = await server.fetch(
          new Request('https://api.github.com/graphql', {
            body: query,
            headers: {
              Authorization: 'bearer igloo-broker-holds-the-real-key',
              'Content-Type': 'application/json; charset=utf-8',
              'GraphQL-Features': 'merge_queue',
            },
            method: 'POST',
          }),
        )
        assert.strictEqual(response.status, 200)
        await response.text()

        assert.strictEqual(sent[0]?.url, 'https://api.github.com/graphql')
        assert.strictEqual(sent[0]?.init.method, 'POST')
        assert.strictEqual(await new Response(sent[0]?.init.body).text(), query)
        const headers = new Headers(sent[0]?.init.headers)
        assert.strictEqual(headers.get('Authorization'), 'Bearer ghp-test')
        assert.strictEqual(headers.get('Content-Type'), 'application/json; charset=utf-8')
        assert.strictEqual(headers.get('GraphQL-Features'), 'merge_queue')
        // Logged with its credential and no repository, since none bounded it.
        const allowed = audited.find(
          (event): event is Record<string, unknown> =>
            typeof event === 'object' &&
            event !== null &&
            'event' in event &&
            event.event === 'allow',
        )
        assert.strictEqual(allowed?.['set'], 'graphql')
        assert.strictEqual(allowed?.['rule'], 'POST graphql')
        assert.strictEqual(allowed?.['credential'], 'GITHUB_TOKEN')
        assert.notProperty(allowed, 'scope')
      }),
    ))

  it('sends a write on with its body and type, and the broker’s token, and logs it as one', () => {
    const writing: readonly Broker.Grant[] = [github({ 'you/web': writes() })]
    return auditing(audited =>
      serving(writing, held, standIn, async server => {
        sent.length = 0
        const issue = '{"title":"from the guest"}'
        const response = await server.fetch(
          new Request('https://api.github.com/repos/you/web/issues', {
            body: issue,
            headers: {
              Authorization: 'token igloo-broker-holds-the-real-key',
              'Content-Type': 'application/json',
            },
            method: 'POST',
          }),
        )
        assert.strictEqual(response.status, 200)
        await response.text()

        assert.strictEqual(sent[0]?.url, 'https://api.github.com/repos/you/web/issues')
        assert.strictEqual(sent[0]?.init.method, 'POST')
        assert.strictEqual(await new Response(sent[0]?.init.body).text(), issue)
        const headers = new Headers(sent[0]?.init.headers)
        assert.strictEqual(headers.get('Authorization'), 'Bearer ghp-test')
        assert.strictEqual(headers.get('Content-Type'), 'application/json')
        const allowed = audited.find(
          (event): event is Record<string, unknown> =>
            typeof event === 'object' &&
            event !== null &&
            'event' in event &&
            event.event === 'allow',
        )
        assert.strictEqual(allowed?.['set'], 'issues')
        assert.strictEqual(allowed?.['rule'], 'DELETE,PATCH,POST,PUT repos/{repo}/issues/**')
        assert.strictEqual(allowed?.['scope'], 'you/web')
      }),
    )
  })
})

/** The audit lines of one event, each without the time it was written at. */
const untimed = (audited: ReadonlyArray<unknown>, event: string): ReadonlyArray<unknown> =>
  audited
    .filter(
      (line): line is Record<string, unknown> =>
        typeof line === 'object' && line !== null && 'event' in line && line.event === event,
    )
    .map(({ t: _t, ...rest }) => rest)

describe('Broker.serveTls, on Runpod’s profile', () => {
  const credentials: ReadonlyMap<string, string> = new Map([['RUNPOD_API_KEY', 'rp-test']])
  const sent: Array<{
    readonly body: string | undefined
    readonly init: RequestInit
    readonly url: string
  }> = []
  /** Runpod standing in: every request answered, and what was sent kept. */
  const runpodApi = async (url: string, init: RequestInit): Promise<Response> => {
    const body =
      init.body === undefined || init.body === null
        ? undefined
        : await new Response(init.body).text()
    sent.push({ body, init, url })
    return new Response('{"data":{"myself":{"clientBalance":25}}}', {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const post = (
    path: string,
    body: NonNullable<RequestInit['body']>,
    headers: Record<string, string> = {},
  ) =>
    new Request(`https:/${path}`, {
      body,
      headers: { Authorization: `Bearer ${Broker.guestPlaceholderKey}`, ...headers },
      method: 'POST',
    })

  it('sends a query with the broker’s key, as the object it read, written again as JSON', () =>
    auditing(audited =>
      serving(runpod, credentials, runpodApi, async server => {
        sent.length = 0
        const response = await server.fetch(
          post(
            '/api.runpod.io/graphql',
            '{ "query" : "query { myself { clientBalance } }", "variables": {} }',
            { 'Content-Type': 'text/plain', 'Content-Encoding': 'identity' },
          ),
        )
        assert.strictEqual(response.status, 200)
        assert.strictEqual(await response.text(), '{"data":{"myself":{"clientBalance":25}}}')
        assert.strictEqual(sent.length, 1)
        assert.strictEqual(sent[0]?.url, 'https://api.runpod.io/graphql')
        assert.strictEqual(
          sent[0]?.body,
          '{"query":"query { myself { clientBalance } }","variables":{}}',
        )
        const headers = new Headers(sent[0]?.init.headers)
        assert.strictEqual(headers.get('Authorization'), 'Bearer rp-test')
        assert.strictEqual(headers.get('Content-Type'), 'application/json')
        assert.isNull(headers.get('Content-Encoding'))
        assert.deepStrictEqual(untimed(audited, 'allow'), [
          {
            credential: 'RUNPOD_API_KEY',
            event: 'allow',
            host: 'api.runpod.io',
            id: 1,
            profile: 'runpod',
            rule: 'POST graphql',
            set: 'read',
          },
        ])
      }),
    ))

  it('refuses a mutation before anything is sent or the key is read, with its reason as the message', () =>
    auditing(audited =>
      serving(runpod, credentials, runpodApi, async server => {
        sent.length = 0
        const response = await server.fetch(
          post(
            '/api.runpod.io/graphql',
            JSON.stringify({
              query: 'mutation { createApiKey(input: {name: "x"}) { id rawKey } }',
            }),
          ),
        )
        assert.strictEqual(response.status, 403)
        assert.deepStrictEqual(await response.json(), {
          message:
            'broker: a mutation writes, and this VM may only read through GraphQL; write through the REST API instead',
        })
        assert.strictEqual(response.headers.get('x-should-retry'), 'false')
        assert.strictEqual(sent.length, 0)
        assert.deepStrictEqual(untimed(audited, 'deny'), [
          {
            event: 'deny',
            host: 'api.runpod.io',
            id: 1,
            reason:
              'a mutation writes, and this VM may only read through GraphQL; write through the REST API instead',
            status: 403,
          },
        ])
        assert.deepStrictEqual(untimed(audited, 'allow'), [])
      }),
    ))

  it('refuses a body past its limit, or one that is not text, without sending either', () =>
    auditing(() =>
      serving(runpod, credentials, runpodApi, async server => {
        sent.length = 0
        const padded = JSON.stringify({
          query: `query { myself { id } }${' '.repeat(Broker.graphqlBodyLimit)}`,
        })
        const large = await server.fetch(post('/api.runpod.io/graphql', padded))
        assert.strictEqual(large.status, 413)
        assert.include(await large.text(), `at most ${String(Broker.graphqlBodyLimit)} bytes`)
        const binary = await server.fetch(
          post('/api.runpod.io/graphql', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])),
        )
        assert.strictEqual(binary.status, 403)
        const empty = await server.fetch(
          new Request('https://api.runpod.io/graphql', { method: 'POST' }),
        )
        assert.strictEqual(empty.status, 403)
        assert.strictEqual(sent.length, 0)
      }),
    ))

  it('streams a REST write and a call of an endpoint as they came, with the broker’s key', () =>
    auditing(() =>
      serving(runpod, credentials, runpodApi, async server => {
        sent.length = 0
        const pod = '{"name":"bench","templateId":"t1","gpu":{"count":1}}'
        const created = await server.fetch(
          post('/api.runpod.io/v2/pods', pod, { 'Content-Type': 'application/json' }),
        )
        assert.strictEqual(created.status, 200)
        const run = await server.fetch(post('/api.runpod.ai/v2/ep1/runsync', '{"input":{}}'))
        assert.strictEqual(run.status, 200)
        const health = await server.fetch(
          new Request('https://api.runpod.ai/v2/ep1/health', {
            headers: { Authorization: 'Bearer igloo-broker-holds-the-real-key' },
          }),
        )
        assert.strictEqual(health.status, 200)

        assert.deepStrictEqual(
          sent.map(each => [each.url, each.body]),
          [
            ['https://api.runpod.io/v2/pods', pod],
            ['https://api.runpod.ai/v2/ep1/runsync', '{"input":{}}'],
            ['https://api.runpod.ai/v2/ep1/health', undefined],
          ],
        )
        for (const each of sent) {
          assert.strictEqual(new Headers(each.init.headers).get('Authorization'), 'Bearer rp-test')
        }
      }),
    ))
})

describe('Broker.serveRequests, on how a refusal is written', () => {
  const granted: readonly Broker.Grant[] = [
    github({ 'you/api': ['fetch', 'read'], 'you/gone': ['fetch', 'read'], 'you/web': writes() }),
    shippedGrant('openrouter', 'OPENROUTER_API_KEY'),
  ]
  const credentials: ReadonlyMap<string, string> = new Map([
    ['GITHUB_TOKEN', 'ghp-test'],
    ['OPENROUTER_API_KEY', 'sk-or-test'],
  ])
  /** Every upstream refusing the broker's credential, but `you/gone`'s, which does not answer. */
  const refusing = (url: string): Promise<Response> =>
    url.includes('/you/gone')
      ? Promise.reject(new Error('ECONNREFUSED'))
      : Promise.resolve(new Response('Bad credentials', { status: 401 }))
  /** A request by `method` to `path`: the name it is addressed to, then its own path. */
  const ask = (server: Served, method: string, path: string) =>
    server.fetch(new Request(`https:/${path}`, { method }))

  it('writes one on GitHub’s API as GitHub writes an error, with its reason as the message', () =>
    auditing(() =>
      serving(granted, credentials, refusing, async server => {
        for (const [method, path, status, reason] of [
          [
            'POST',
            '/api.github.com/repos/you/web/labels',
            405,
            'POST /repos/you/web/labels is not something this VM may do through api.github.com, which allows GET, HEAD there',
          ],
          [
            'POST',
            '/api.github.com/repos/you/api/issues',
            405,
            'POST /repos/you/api/issues is not something this VM may do through api.github.com, which allows GET, HEAD there',
          ],
          [
            'GET',
            '/api.github.com/user/repos',
            403,
            'GET /user/repos is not something this VM may do through api.github.com',
          ],
          [
            'DELETE',
            '/api.github.com/repos/you/web/git/refs/tags%2Fv1',
            400,
            'percent-encoding is not accepted in a path',
          ],
          [
            'POST',
            '/uploads.github.com/repos/you/api/releases/1/assets?name=a',
            403,
            'POST /repos/you/api/releases/1/assets is not something this VM may do for you/api through uploads.github.com',
          ],
          // The upstream's 401, as the broker's own refusal.
          [
            'GET',
            '/api.github.com/repos/you/api',
            403,
            'api.github.com refused GITHUB_TOKEN; the credential the host holds is wrong, expired, or not scoped to you/api',
          ],
          [
            'POST',
            '/uploads.github.com/repos/you/web/releases/1/assets?name=a',
            403,
            'uploads.github.com refused GITHUB_TOKEN; the credential the host holds is wrong, expired, or not scoped to you/web',
          ],
        ] as const) {
          const response = await ask(server, method, path)
          assert.strictEqual(response.status, status, path)
          assert.strictEqual(
            response.headers.get('Content-Type'),
            'application/json; charset=utf-8',
            path,
          )
          assert.strictEqual(response.headers.get('x-should-retry'), 'false', path)
          assert.strictEqual(
            await response.text(),
            `${JSON.stringify({ message: `broker: ${reason}` })}\n`,
            path,
          )
        }

        // An upstream that did not answer may answer next time.
        const gone = await ask(server, 'GET', '/api.github.com/repos/you/gone')
        assert.strictEqual(gone.status, 502)
        assert.isNull(gone.headers.get('x-should-retry'))
        assert.deepStrictEqual(await gone.json(), {
          message: 'broker: api.github.com did not answer',
        })
      }),
    ))

  it('writes git’s as text', () =>
    auditing(() =>
      serving(granted, credentials, refusing, async server => {
        for (const [method, path, status, reason] of [
          [
            'GET',
            '/github.com/you/api/info/refs?service=git-receive-pack',
            403,
            'this VM may fetch you/api, not push to it',
          ],
          [
            'GET',
            '/github.com/you/api/info/refs?service=git-upload-pack',
            502,
            'github.com refused GITHUB_TOKEN; the credential the host holds is wrong, expired, or not scoped to you/api',
          ],
        ] as const) {
          const response = await ask(server, method, path)
          assert.strictEqual(response.status, status, path)
          assert.strictEqual(
            response.headers.get('Content-Type'),
            'text/plain; charset=utf-8',
            path,
          )
          assert.strictEqual(response.headers.get('x-should-retry'), 'false', path)
          assert.strictEqual(await response.text(), `broker: ${reason}\n`, path)
        }
      }),
    ))
})

describe('Broker.serveRequests, on a push', () => {
  it('streams the pack to the repository in write, with the broker’s token, and logs it as a push', () => {
    const sent: Array<{ readonly body: string; readonly init: RequestInit; readonly url: string }> =
      []
    const pushing: readonly Broker.Grant[] = [github({ 'you/web': writes() })]
    return auditing(audited =>
      serving(
        pushing,
        held,
        async (url, init) => {
          sent.push({ body: await new Response(init.body).text(), init, url })
          return new Response('000eunpack ok\n0000', {
            headers: { 'Content-Type': 'application/x-git-receive-pack-result' },
          })
        },
        async server => {
          const response = await server.fetch(
            new Request('https://github.com/you/web.git/git-receive-pack', {
              body: 'the pack',
              headers: { 'Content-Type': 'application/x-git-receive-pack-request' },
              method: 'POST',
            }),
          )
          assert.strictEqual(response.status, 200)
          assert.strictEqual(await response.text(), '000eunpack ok\n0000')
          assert.strictEqual(
            response.headers.get('Content-Type'),
            'application/x-git-receive-pack-result',
          )

          assert.strictEqual(sent[0]?.url, 'https://github.com/you/web.git/git-receive-pack')
          assert.strictEqual(sent[0]?.body, 'the pack')
          assert.strictEqual(
            new Headers(sent[0]?.init.headers).get('Authorization'),
            `Basic ${btoa('x-access-token:ghp-test')}`,
          )
          const allowed = audited.find(
            (event): event is Record<string, unknown> =>
              typeof event === 'object' &&
              event !== null &&
              'event' in event &&
              event.event === 'allow',
          )
          assert.strictEqual(allowed?.['set'], 'push')
          assert.strictEqual(allowed?.['rule'], 'git push')
          assert.strictEqual(allowed?.['operation'], 'push')
          assert.strictEqual(allowed?.['scope'], 'you/web')
        },
      ),
    )
  })
})

describe('Broker.serveRequests, request by request', () => {
  const granted: readonly Broker.Grant[] = [
    github(
      Object.fromEntries(
        ['you/api', 'you/gone', 'you/refused', 'you/moved', 'you/broken', 'you/endless'].map(
          repo => [repo, ['fetch']],
        ),
      ),
      [],
    ),
    // A grant whose credential the broker was never given, at a forge of its own.
    {
      credential: 'OTHER_TOKEN',
      hosts: {
        'git.example.com': {
          allow: [{ git: 'fetch', set: 'fetch' }],
          deny: [],
          send: { basic: 'x-access-token' },
        },
      },
      profile: 'mirror',
      repos: { 'you/other': ['fetch'] },
      repository: { ignoreCase: true, segments: 2 },
    },
  ]
  const otherRefs = 'https://git.example.com/you/other/info/refs?service=git-upload-pack'

  /** A provider standing in for each repository: what asking it does. */
  const upstream = (url: string): Promise<Response> => {
    const repo = /github\.com\/(.+)\.git\//.exec(url)?.[1]
    switch (repo) {
      case 'you/gone':
        return Promise.reject(new Error('ECONNREFUSED'))
      case 'you/refused':
        return Promise.resolve(new Response('Bad credentials', { status: 401 }))
      case 'you/moved':
        return Promise.resolve(
          new Response(null, { headers: { Location: 'https://elsewhere.example/' }, status: 302 }),
        )
      case 'you/broken':
        return Promise.resolve(unreadableStatus())
      case 'you/endless':
        // One chunk, and then nothing, ever: only the guest can end it.
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encode('refs'))
              },
            }),
          ),
        )
      default:
        return Promise.resolve(new Response('refs'))
    }
  }

  it('sends the request its grant constructs, and nothing the guest added to it', () => {
    const sent: Array<{ readonly init: RequestInit; readonly url: string }> = []
    return auditing(() =>
      serving(
        granted,
        held,
        (url, init) => {
          sent.push({ init, url })
          return Promise.resolve(new Response('refs'))
        },
        async server => {
          const response = await server.fetch(
            new Request(refs('you/api'), {
              headers: {
                Authorization: 'Basic Z3Vlc3Q6',
                Cookie: 'session=guest',
                'X-Forwarded-Host': 'elsewhere.example',
              },
            }),
          )
          assert.strictEqual(await response.text(), 'refs')
          assert.strictEqual(sent.length, 1)
          const [first] = sent
          assert.strictEqual(
            first?.url,
            'https://github.com/you/api.git/info/refs?service=git-upload-pack',
          )
          assert.strictEqual(first?.init.method, 'GET')
          // A redirect is the upstream choosing a destination the grant did not.
          assert.strictEqual(first?.init.redirect, 'manual')
          const headers = new Headers(first?.init.headers)
          assert.strictEqual(
            headers.get('Authorization'),
            `Basic ${btoa('x-access-token:ghp-test')}`,
          )
          assert.isNull(headers.get('Cookie'))
          assert.isNull(headers.get('X-Forwarded-Host'))
        },
      ),
    )
  })

  it('sends nothing for a grant whose credential it was not given', () => {
    let calls = 0
    return auditing(() =>
      serving(
        granted,
        held,
        () => {
          calls++
          return Promise.resolve(new Response('refs'))
        },
        async server => {
          const response = await server.fetch(otherRefs)
          assert.strictEqual(response.status, 500)
          assert.include(await response.text(), 'OTHER_TOKEN was not delivered')
          assert.strictEqual(calls, 0)
        },
      ),
    )
  })

  it('passes on neither a refused credential nor a redirect as the upstream gave them', () =>
    auditing(() =>
      serving(granted, held, upstream, async server => {
        const refused = await server.fetch(refs('you/refused'))
        assert.strictEqual(refused.status, 502)
        assert.include(await refused.text(), 'refused GITHUB_TOKEN')

        const moved = await server.fetch(refs('you/moved'))
        assert.strictEqual(moved.status, 502)
        assert.isNull(moved.headers.get('Location'))
        assert.include(await moved.text(), 'redirected')
      }),
    ))

  it('tells a client that its own refusals are final, and an unreachable upstream is not', () =>
    auditing(() =>
      serving(granted, held, upstream, async server => {
        for (const [repo, status] of [
          ['someone/else', 403],
          ['you/refused', 502],
          ['you/moved', 502],
          ['you/broken', 500],
          [otherRefs, 500],
        ] as const) {
          const response = await server.fetch(repo.startsWith('https:') ? repo : refs(repo))
          assert.strictEqual(response.status, status, repo)
          assert.strictEqual(response.headers.get('x-should-retry'), 'false', repo)
        }
        const gone = await server.fetch(refs('you/gone'))
        assert.strictEqual(gone.status, 502)
        assert.isNull(gone.headers.get('x-should-retry'))
      }),
    ))

  it('answers a model call whose credential the provider refused with a final 403', () =>
    auditing(() =>
      serving(
        [shippedGrant('anthropic-messages', 'ANTHROPIC_API_KEY')],
        new Map([['ANTHROPIC_API_KEY', 'sk-ant-revoked']]),
        () =>
          Promise.resolve(
            new Response('{"type":"error","error":{"type":"authentication_error"}}', {
              headers: { 'www-authenticate': 'Bearer' },
              status: 401,
            }),
          ),
        async server => {
          const response = await server.fetch(
            new Request('https://api.anthropic.com/v1/messages', {
              body: JSON.stringify({ messages: [], model: 'claude-opus-5' }),
              method: 'POST',
            }),
          )
          assert.strictEqual(response.status, 403)
          assert.strictEqual(response.headers.get('x-should-retry'), 'false')
          assert.isNull(response.headers.get('www-authenticate'))
          assert.include(await response.text(), 'api.anthropic.com refused ANTHROPIC_API_KEY')
        },
      ),
    ))

  it('audits what a response carried, once the guest has read it', () =>
    auditing(audited =>
      serving(
        granted,
        held,
        () =>
          Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(encode('one '))
                  controller.enqueue(encode('two'))
                  controller.close()
                },
              }),
            ),
          ),
        async server => {
          assert.strictEqual(await (await server.fetch(refs('you/api'))).text(), 'one two')
          const responses = audited.filter(
            (event): event is { readonly bytes: unknown } =>
              typeof event === 'object' &&
              event !== null &&
              'event' in event &&
              event.event === 'response' &&
              'bytes' in event,
          )
          assert.deepStrictEqual(
            responses.map(({ bytes }) => bytes),
            [7],
          )
        },
      ),
    ))

  it('reads a model listing with the credential attached and no body', () => {
    const sent: Array<{ readonly init: RequestInit; readonly url: string }> = []
    return auditing(audited =>
      serving(
        [shippedGrant('openrouter', 'OPENROUTER_API_KEY')],
        new Map([['OPENROUTER_API_KEY', 'sk-or-test']]),
        (url, init) => {
          sent.push({ init, url })
          return Promise.resolve(
            new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } }),
          )
        },
        async server => {
          const response = await server.fetch(
            new Request('https://openrouter.ai/api/v1/models?output_modalities=rerank'),
          )
          assert.strictEqual(await response.text(), '{"data":[]}')
          const [first] = sent
          assert.strictEqual(
            first?.url,
            'https://openrouter.ai/api/v1/models?output_modalities=rerank',
          )
          assert.strictEqual(first?.init.method, 'GET')
          assert.isUndefined(first?.init.body)
          const headers = new Headers(first?.init.headers)
          assert.strictEqual(headers.get('Authorization'), 'Bearer sk-or-test')
          assert.isNull(headers.get('Content-Type'))
          const allowed = audited.filter(
            (event): event is Record<string, unknown> =>
              typeof event === 'object' &&
              event !== null &&
              'event' in event &&
              event.event === 'allow',
          )
          assert.deepStrictEqual(
            allowed.map(event => [event['set'], event['rule'], 'scope' in event]),
            [['models', 'GET api/v1/models', false]],
          )
        },
      ),
    )
  })

  it('sends a model call’s body as it arrived, whatever it asks the provider to do', () => {
    // A provider-side tool, an image the provider downloads, OpenRouter's
    // plugins and a model that searches the web: each has the provider reach
    // the network on the model's behalf, which is the provider's to do. What
    // the broker decides is where a request goes and which credential it
    // carries. A body that is not JSON at all is the provider's to refuse.
    const calls = [
      [
        'api.anthropic.com/v1/messages',
        '{"model":"claude-opus-5","messages":[],"tools":[{"type":"web_fetch_20260209","name":"web_fetch"}]}',
      ],
      [
        'api.anthropic.com/v1/messages',
        '{"model":"claude-opus-5","messages":[{"role":"user","content":[{"type":"image","source":{"type":"url","url":"https://elsewhere.example/a.png"}}]}]}',
      ],
      [
        'openrouter.ai/api/v1/chat/completions',
        '{"model":"openai/gpt-5","messages":[],"plugins":[{"id":"web"}]}',
      ],
      ['openrouter.ai/api/v1/chat/completions', '{"model":"openai/gpt-5:online","messages":[]}'],
      ['api.anthropic.com/v1/messages/count_tokens', 'not JSON'],
    ] as const
    const sent: Array<readonly [string, string]> = []
    return auditing(audited =>
      serving(
        inference,
        new Map([
          ['ANTHROPIC_API_KEY', 'sk-ant-test'],
          ['OPENROUTER_API_KEY', 'sk-or-test'],
        ]),
        async (url, init) => {
          sent.push([url, await new Response(init.body).text()])
          return new Response('{}')
        },
        async server => {
          for (const [path, body] of calls) {
            const response = await server.fetch(
              new Request(`https://${path}`, { body, method: 'POST' }),
            )
            assert.strictEqual(response.status, 200, path)
          }
          assert.deepStrictEqual(
            sent,
            calls.map(([path, body]) => [`https://${path}`, body]),
          )
          // A model is named only in the body, so the audit line names none.
          const allowed = audited.filter(
            (event): event is Record<string, unknown> =>
              typeof event === 'object' &&
              event !== null &&
              'event' in event &&
              event.event === 'allow',
          )
          assert.strictEqual(allowed.length, calls.length)
          for (const event of allowed) assert.notProperty(event, 'scope')
        },
      ),
    )
  })

  it('carries a model call’s headers both ways, less credentials and cookies', () => {
    const sent: Array<Headers> = []
    return auditing(() =>
      serving(
        [shippedGrant('anthropic-messages', 'ANTHROPIC_API_KEY')],
        new Map([['ANTHROPIC_API_KEY', 'sk-ant-test']]),
        async (_url, init) => {
          sent.push(new Headers(init.headers))
          return new Response('{}', {
            headers: {
              'content-type': 'application/json',
              'request-id': 'req_011CTest',
              'retry-after': '7',
              'set-cookie': '__cf_bm=1; Path=/',
            },
            status: 429,
          })
        },
        async server => {
          const response = await server.fetch(
            new Request('https://api.anthropic.com/v1/messages', {
              body: JSON.stringify({ messages: [], model: 'claude-opus-5' }),
              headers: {
                'anthropic-beta': 'context-management-2025-06-27',
                Cookie: 'session=guest',
                'x-api-key': Broker.guestPlaceholderKey,
              },
              method: 'POST',
            }),
          )
          assert.strictEqual(response.status, 429)
          assert.strictEqual(response.headers.get('retry-after'), '7')
          assert.strictEqual(response.headers.get('request-id'), 'req_011CTest')
          assert.isNull(response.headers.get('set-cookie'))

          const [headers] = sent
          assert.strictEqual(headers?.get('anthropic-beta'), 'context-management-2025-06-27')
          assert.strictEqual(headers?.get('x-api-key'), 'sk-ant-test')
          assert.isNull(headers?.get('Cookie'))
        },
      ),
    )
  })

  it('serves every request the guest sends at once, however many', () => {
    const release = Promise.withResolvers<void>()
    const allWaiting = Promise.withResolvers<void>()
    let waiting = 0
    return auditing(() =>
      serving(
        granted,
        held,
        async () => {
          waiting++
          if (waiting === 64) allWaiting.resolve()
          await release.promise
          return new Response('refs')
        },
        async server => {
          const holding = Array.from({ length: 64 }, () =>
            Promise.resolve(server.fetch(refs('you/api'))),
          )
          // Every one reaches the upstream while all of them are still open.
          await allWaiting.promise
          release.resolve()
          for (const response of await Promise.all(holding)) {
            assert.strictEqual(response.status, 200)
          }
        },
      ),
    )
  })
})

/**
 * Serve on a socket and send to it over HTTP, as the guest's requests arrive:
 * with `Content-Length` for a body in hand, and in chunks for a stream.
 */
const overHttp = <A>(
  granted: readonly Broker.Grant[],
  credentials: ReadonlyMap<string, string>,
  send: NonNullable<Parameters<typeof Broker.serveRequests>[3]>,
  use: (
    post: (path: string, body: Uint8Array | ReadableStream<Uint8Array>) => Promise<Response>,
  ) => Promise<A>,
): Promise<A> =>
  withSocketDir(async dir => {
    const socketPath = join(dir, 'http.sock')
    const server = Broker.serveRequests(socketPath, granted, credentials, send)
    try {
      return await use((path, body) =>
        fetch(`http://broker${path}`, { body, method: 'POST', unix: socketPath }),
      )
    } finally {
      await server.stop(true)
    }
  })

/**
 * `overHttp`, through the TLS listener: `post` takes a path whose first
 * segment is the name the request is addressed to, `host`, which the
 * listener's certificate is for.
 */
const overTls = <A>(
  granted: readonly Broker.Grant[],
  credentials: ReadonlyMap<string, string>,
  send: NonNullable<Parameters<typeof Broker.serveRequests>[3]>,
  host: string,
  use: (
    post: (path: string, body: Uint8Array | ReadableStream<Uint8Array>) => Promise<Response>,
  ) => Promise<A>,
): Promise<A> =>
  withSocketDir(async dir => {
    const socketPath = join(dir, 'tls.sock')
    const identity = tlsIdentity(dir, host)
    const server = Broker.serveTls(socketPath, granted, credentials, identity, [], send)
    try {
      return await use((path, body) =>
        fetch(`https://${host}${path}`, {
          body,
          method: 'POST',
          tls: { ca: identity.cert },
          unix: socketPath,
        }),
      )
    } finally {
      await server.stop(true)
    }
  })

/** A JSON object of exactly `bytes` bytes. */
const bodyOf = (bytes: number): Uint8Array => {
  const head = encode('{"messages":[],"model":"m","pad":"')
  const body = new Uint8Array(bytes).fill(0x61)
  body.set(head)
  body.set(encode('"}'), bytes - 2)
  return body
}

/** `body`, as a stream of chunks, which a client sends with no length. */
const chunked = (body: Uint8Array): ReadableStream<Uint8Array> => {
  let at = 0
  return new ReadableStream({
    pull(controller) {
      if (at >= body.byteLength) {
        controller.close()
        return
      }
      controller.enqueue(body.subarray(at, at + 1024 * 1024))
      at += 1024 * 1024
    },
  })
}

type Send = NonNullable<Parameters<typeof Broker.serveRequests>[3]>

/** One connection to a provider on loopback: every byte it sent, and whether it has closed. */
interface Connection {
  readonly closed: boolean
  readonly received: Buffer
}

/**
 * A provider listening on loopback, and a `send` that reaches it the way
 * `fetch` reaches a provider. `answer` is shown all a connection has sent so
 * far, each time more arrives, and returns what to write back once it has
 * decided: all at once, or in parts as they are yielded, for as long as the
 * connection is open.
 */
const onLoopback = <A>(
  answer: (received: Buffer) => string | AsyncIterable<string> | undefined,
  use: (send: Send, connections: ReadonlyArray<Connection>) => Promise<A>,
): Promise<A> => {
  const connections: Array<{ closed: boolean; received: Buffer }> = []
  const server = createServer(socket => {
    const connection = { closed: false, received: Buffer.alloc(0) }
    connections.push(connection)
    let answered = false
    socket.on('error', () => undefined)
    socket.on('close', () => {
      connection.closed = true
    })
    socket.on('data', (chunk: Buffer) => {
      connection.received = Buffer.concat([connection.received, chunk])
      if (answered) return
      const reply = answer(connection.received)
      if (reply === undefined) return
      answered = true
      if (typeof reply === 'string') {
        socket.write(reply)
        return
      }
      void (async () => {
        for await (const part of reply) {
          if (socket.destroyed) return
          socket.write(part)
        }
      })()
    })
  })
  return new Promise<number>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('not listening on TCP')
      resolve(address.port)
    })
  })
    .then(port =>
      use(
        (url, init) => fetch(url.replace(/^https?:\/\/[^/]+\//, `http://127.0.0.1:${port}/`), init),
        connections,
      ),
    )
    .finally(() => {
      server.close()
    })
}

/** An HTTP response of `status` that closes its connection, as a provider writes it. */
const reply = (status: number, body: string): string =>
  `HTTP/1.1 ${String(status)} Status\r\ncontent-type: application/json\r\ncontent-length: ${String(body.length)}\r\nconnection: close\r\n\r\n${body}`

/**
 * A request as a provider's socket received it: its head, its body taken out
 * of its chunks, and how many bytes followed the last chunk. Undefined until
 * the last chunk has arrived, or for a body not sent in chunks.
 */
const unchunked = (
  received: Buffer,
): { readonly after: number; readonly body: Buffer; readonly head: string } | undefined => {
  const headEnd = received.indexOf('\r\n\r\n')
  if (headEnd < 0) return undefined
  const head = received.subarray(0, headEnd).toString('latin1')
  if (!/^transfer-encoding: chunked$/im.test(head)) return undefined
  const chunks: Buffer[] = []
  let at = headEnd + 4
  for (;;) {
    const lineEnd = received.indexOf('\r\n', at)
    if (lineEnd < 0) return undefined
    const size = Number.parseInt(received.subarray(at, lineEnd).toString('latin1'), 16)
    // The last chunk is empty, and an empty line ends the trailers after it.
    const end = size === 0 ? lineEnd + 4 : lineEnd + 2 + size + 2
    if (received.length < end) return undefined
    if (size === 0) return { after: received.length - end, body: Buffer.concat(chunks), head }
    chunks.push(received.subarray(lineEnd + 2, lineEnd + 2 + size))
    at = end
  }
}

/** The body a provider was sent, which the broker streams rather than reads. */
const streamed = (init: RequestInit): ReadableStream<Uint8Array> => {
  if (init.body instanceof ReadableStream) return init.body
  throw new Error('the body was not streamed')
}

/** Poll `ready` until it holds, for at most `ms`. */
const eventually = async (ready: () => boolean, ms = 2000): Promise<boolean> => {
  for (let waited = 0; waited < ms && !ready(); waited += 20) await Bun.sleep(20)
  return ready()
}

describe('Broker.serveRequests, on a request body', () => {
  // A model server with a key: the listener is the same for every grant, and
  // this one is reached by its path, over the plain listener.
  const anthropic: readonly Broker.Grant[] = [
    { credential: 'ANTHROPIC_API_KEY', name: 'llama-swap', port: 8080, profile: 'model-server' },
  ]
  const key = new Map([['ANTHROPIC_API_KEY', 'sk-ant-test']])
  const messages = '/local/llama-swap/v1/chat/completions'

  it('sends a body on as it arrives, before the guest has sent the last of it', () => {
    const order: Array<string> = []
    const first = Promise.withResolvers<void>()
    // The last chunk waits for the upstream to have the first, for long enough
    // that a broker holding the body back is seen to.
    const guest = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await Promise.race([first.promise, Bun.sleep(2000)])
        order.push('guest sent the last chunk')
        controller.enqueue(encode('"messages":[]}'))
        controller.close()
      },
      start(controller) {
        controller.enqueue(encode('{"model":"m",'))
      },
    })
    return auditing(() =>
      overHttp(
        anthropic,
        key,
        async (_url, init) => {
          const reader = streamed(init).getReader()
          let text = ''
          for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            if (text === '') {
              order.push('upstream had the first chunk')
              first.resolve()
            }
            text += new TextDecoder().decode(chunk.value)
          }
          return new Response(text)
        },
        async post => {
          const response = await post(messages, guest)
          assert.strictEqual(await response.text(), '{"model":"m","messages":[]}')
          assert.deepStrictEqual(order, [
            'upstream had the first chunk',
            'guest sent the last chunk',
          ])
        },
      ),
    )
  })

  it('refuses no body for its size', () => {
    // Past Bun's own default limit for a request body, as well as past any
    // provider's limit.
    const mib = 129
    const megabyte = new Uint8Array(1024 * 1024).fill(0x61)
    let sent = 0
    const guest = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === mib) {
          controller.close()
          return
        }
        sent++
        controller.enqueue(megabyte)
      },
    })
    return auditing(() =>
      overHttp(
        anthropic,
        key,
        async (_url, init) => {
          let bytes = 0
          for await (const chunk of streamed(init)) bytes += chunk.byteLength
          return new Response(String(bytes))
        },
        async post => {
          const response = await post(messages, guest)
          assert.strictEqual(response.status, 200)
          assert.strictEqual(await response.text(), String(mib * 1024 * 1024))
        },
      ),
    )
  }, 30_000)

  it('frames a body in chunks upstream however the guest framed it, with nothing after it', () => {
    const body = bodyOf(3 * 1024 * 1024)
    return auditing(() =>
      onLoopback(
        // Answered at once if the body is not in chunks, so that a test which
        // fails does so by its assertions rather than by waiting.
        received => {
          const headEnd = received.indexOf('\r\n\r\n')
          if (headEnd < 0) return undefined
          if (unchunked(received) !== undefined) return reply(200, '{}')
          const head = received.subarray(0, headEnd).toString('latin1')
          return /^transfer-encoding: chunked$/im.test(head) ? undefined : reply(200, '{}')
        },
        (send, connections) =>
          overHttp(anthropic, key, send, async post => {
            // With `Content-Length`, then in chunks.
            for (const sent of [body, chunked(body)]) {
              const response = await post(messages, sent)
              assert.strictEqual(response.status, 200)
              await response.text()
            }
            await Bun.sleep(100)
            assert.strictEqual(connections.length, 2)
            for (const { received } of connections) {
              const request = unchunked(received)
              assert.isDefined(request, received.subarray(0, 300).toString('latin1'))
              assert.notMatch(request?.head ?? '', /^content-length:/im)
              assert.isTrue(request?.body.equals(body))
              assert.strictEqual(request?.after, 0)
            }
          }),
      ),
    )
  })

  it('sends an asset with the length it was sent with, and nothing after it, or in chunks', () => {
    const writing: readonly Broker.Grant[] = [github({ 'you/web': writes() })]
    const asset = bodyOf(3 * 1024 * 1024)
    /** A request framed by its length: its head, its body, and how many bytes followed. */
    const sized = (received: Buffer) => {
      const headEnd = received.indexOf('\r\n\r\n')
      if (headEnd < 0) return undefined
      const head = received.subarray(0, headEnd).toString('latin1')
      const length = /^content-length: (\d+)$/im.exec(head)?.[1]
      if (length === undefined) return undefined
      const end = headEnd + 4 + Number(length)
      if (received.length < end) return undefined
      return { after: received.length - end, body: received.subarray(headEnd + 4, end), head }
    }
    return auditing(() =>
      onLoopback(
        received =>
          sized(received) !== undefined || unchunked(received) !== undefined
            ? reply(201, '{}')
            : undefined,
        (send, connections) =>
          overTls(writing, held, send, 'uploads.github.com', async post => {
            for (const sent of [asset, chunked(asset)]) {
              const response = await post('/repos/you/web/releases/1/assets?name=a.bin', sent)
              assert.strictEqual(response.status, 201)
              await response.text()
            }
            await Bun.sleep(100)
            assert.strictEqual(connections.length, 2)
            const [withLength, inChunks] = connections
            const first = sized(withLength?.received ?? Buffer.alloc(0))
            assert.isDefined(first)
            assert.match(
              first?.head ?? '',
              /^POST \/repos\/you\/web\/releases\/1\/assets\?name=a\.bin /,
            )
            assert.match(first?.head ?? '', /^content-length: 3145728$/im)
            assert.notMatch(first?.head ?? '', /^transfer-encoding:/im)
            assert.isTrue(first?.body.equals(asset))
            assert.strictEqual(first?.after, 0)
            const second = unchunked(inChunks?.received ?? Buffer.alloc(0))
            assert.isDefined(second)
            assert.notMatch(second?.head ?? '', /^content-length:/im)
            assert.isTrue(second?.body.equals(asset))
          }),
      ),
    )
  })

  it('passes on an answer the provider gives before it has the whole body, its 413 included', () => {
    const tooLarge = '{"type":"error","error":{"type":"request_too_large"}}'
    return auditing(audited =>
      onLoopback(
        received => (received.length > 64 * 1024 ? reply(413, tooLarge) : undefined),
        (send, connections) =>
          overHttp(anthropic, key, send, async post => {
            for (const sent of [bodyOf(8 * 1024 * 1024), chunked(bodyOf(8 * 1024 * 1024))]) {
              const response = await post(messages, sent)
              assert.strictEqual(response.status, 413)
              assert.strictEqual(await response.text(), tooLarge)
            }
            // The provider answered before the body ended.
            for (const { received } of connections) assert.isUndefined(unchunked(received))
            const responses = audited.filter(
              (event): event is Record<string, unknown> =>
                typeof event === 'object' &&
                event !== null &&
                'event' in event &&
                event.event === 'response',
            )
            assert.deepStrictEqual(
              responses.map(event => event['status']),
              [413, 413],
            )
          }),
      ),
    )
  })

  it('records a guest that leaves mid-body as gone, and ends the body there', () =>
    auditing(audited =>
      onLoopback(
        () => undefined,
        (send, connections) =>
          withSocketDir(async dir => {
            const socketPath = join(dir, 'http.sock')
            const server = Broker.serveRequests(socketPath, anthropic, key, send)
            const guest = connect(socketPath)
            try {
              await new Promise(resolve => guest.once('connect', resolve))
              guest.write(
                `POST ${messages} HTTP/1.1\r\nHost: broker\r\nContent-Length: ${String(3 * 1024 * 1024)}\r\n\r\n`,
              )
              guest.write(bodyOf(1024 * 1024))
              assert.isTrue(
                await eventually(() => (connections[0]?.received.length ?? 0) > 1024 * 1024),
              )
              guest.destroy()
              const gone = () =>
                audited.some(
                  event =>
                    typeof event === 'object' &&
                    event !== null &&
                    'reason' in event &&
                    event.reason === 'guest disconnected',
                )
              assert.isTrue(await eventually(gone), JSON.stringify(audited))
              // Closed with the body unfinished, so the provider cannot take
              // part of a body for the whole of it.
              assert.isTrue(await eventually(() => connections[0]?.closed === true))
              assert.isUndefined(unchunked(connections[0]?.received ?? Buffer.alloc(0)))
            } finally {
              guest.destroy()
              await server.stop(true)
            }
          }),
      ),
    ))
})

describe('Broker.serveRequests, on the guest’s connection', () => {
  // A model server with a key: the listener is the same for every grant, and
  // this one is reached by its path, over the plain listener.
  const anthropic: readonly Broker.Grant[] = [
    { credential: 'ANTHROPIC_API_KEY', name: 'llama-swap', port: 8080, profile: 'model-server' },
  ]
  const key = new Map([['ANTHROPIC_API_KEY', 'sk-ant-test']])
  const messages = '/local/llama-swap/v1/chat/completions'
  const body = '{"messages":[],"model":"m"}'
  const request = `POST ${messages} HTTP/1.1\r\nHost: broker\r\nContent-Length: ${String(body.length)}\r\n\r\n${body}`

  /** The audit lines of one kind of event. */
  const lines = (audited: ReadonlyArray<unknown>, event: string): Array<Record<string, unknown>> =>
    audited.filter(
      (line): line is Record<string, unknown> =>
        typeof line === 'object' && line !== null && 'event' in line && line.event === event,
    )

  /**
   * A response as the guest's socket received it, framed in chunks or by its
   * length as the broker chose: its head, its body, and how many bytes followed
   * it. Undefined until the whole of it has arrived.
   */
  const responseIn = (
    received: Buffer,
  ): { readonly after: number; readonly body: Buffer; readonly head: string } | undefined => {
    const inChunks = unchunked(received)
    if (inChunks !== undefined) return inChunks
    const headEnd = received.indexOf('\r\n\r\n')
    if (headEnd < 0) return undefined
    const head = received.subarray(0, headEnd).toString('latin1')
    const length = /^content-length: (\d+)$/im.exec(head)?.[1]
    if (length === undefined) return undefined
    const end = headEnd + 4 + Number(length)
    if (received.length < end) return undefined
    return { after: received.length - end, body: received.subarray(headEnd + 4, end), head }
  }

  it('ends the call when the guest leaves before the provider answers, and records no answer', () => {
    // Held back until the guest has gone, then written if the connection is
    // still there to take it.
    const release = Promise.withResolvers<void>()
    return auditing(audited =>
      onLoopback(
        received =>
          unchunked(received) === undefined
            ? undefined
            : (async function* () {
                await release.promise
                yield reply(200, '{}')
              })(),
        (send, connections) =>
          withSocketDir(async dir => {
            const socketPath = join(dir, 'http.sock')
            const server = Broker.serveRequests(socketPath, anthropic, key, send)
            const guest = connect(socketPath)
            try {
              await new Promise(resolve => guest.once('connect', resolve))
              guest.write(request)
              assert.isTrue(
                await eventually(
                  () => unchunked(connections[0]?.received ?? Buffer.alloc(0)) !== undefined,
                ),
              )
              guest.destroy()
              assert.isTrue(await eventually(() => connections[0]?.closed === true, 1000))
              assert.isTrue(
                await eventually(() =>
                  lines(audited, 'error').some(line => line['reason'] === 'guest disconnected'),
                ),
                JSON.stringify(audited),
              )
              // The provider's answer now has nowhere to go, and is not recorded as given.
              release.resolve()
              await Bun.sleep(100)
              assert.deepStrictEqual(lines(audited, 'response'), [])
            } finally {
              release.resolve()
              // However the call ended, in this test's audit rather than the next one's.
              await eventually(
                () => lines(audited, 'response').length + lines(audited, 'error').length > 0,
              )
              guest.destroy()
              await server.stop(true)
            }
          }),
      ),
    )
  })

  it('carries a streamed answer to its end', () => {
    const events = ['one', 'two', 'three', 'four'].map(name => `event: ${name}\n\n`)
    return auditing(audited =>
      onLoopback(
        received =>
          unchunked(received) === undefined
            ? undefined
            : (async function* () {
                yield 'HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n'
                for (const event of events) {
                  await Bun.sleep(200)
                  yield `${event.length.toString(16)}\r\n${event}\r\n`
                }
                yield '0\r\n\r\n'
              })(),
        send =>
          overHttp(anthropic, key, send, async post => {
            const response = await post(messages, encode(body))
            assert.strictEqual(response.status, 200)
            assert.strictEqual(await response.text(), events.join(''))
            assert.isTrue(await eventually(() => lines(audited, 'response').length > 0))
            assert.deepStrictEqual(
              lines(audited, 'response').map(line => line['bytes']),
              [events.join('').length],
            )
            assert.deepStrictEqual(lines(audited, 'error'), [])
          }),
      ),
    )
  })

  it('answers a second request on the connection that carried the first', () => {
    let answers = 0
    return auditing(audited =>
      onLoopback(
        received =>
          unchunked(received) === undefined
            ? undefined
            : (async function* () {
                // Held back, so that the broker waits on each call, the second included.
                await Bun.sleep(200)
                answers++
                yield reply(200, `{"answer":${String(answers)}}`)
              })(),
        send =>
          withSocketDir(async dir => {
            const socketPath = join(dir, 'http.sock')
            const server = Broker.serveRequests(socketPath, anthropic, key, send)
            const guest = connect(socketPath)
            let received = Buffer.alloc(0)
            guest.on('data', (chunk: Buffer) => {
              received = Buffer.concat([received, chunk])
            })
            try {
              await new Promise(resolve => guest.once('connect', resolve))
              /** Send the request, and answer the body of the response it gets. */
              const exchange = async (): Promise<string> => {
                received = Buffer.alloc(0)
                guest.write(request)
                assert.isTrue(await eventually(() => responseIn(received) !== undefined))
                const answer = responseIn(received)
                assert.match(answer?.head ?? '', /^HTTP\/1\.1 200 /)
                assert.strictEqual(answer?.after, 0)
                return answer?.body.toString() ?? ''
              }
              assert.strictEqual(await exchange(), '{"answer":1}')
              assert.strictEqual(await exchange(), '{"answer":2}')
              assert.isTrue(await eventually(() => lines(audited, 'response').length === 2))
              assert.deepStrictEqual(lines(audited, 'error'), [])
            } finally {
              guest.destroy()
              await server.stop(true)
            }
          }),
      ),
    )
  })
})

describe('Broker, run as a program', () => {
  const program = new URL('broker.ts', import.meta.url).pathname

  /** Start the broker the way its unit does, with these credentials loaded. */
  const start = (
    dir: string,
    args: readonly string[],
    credentials: Record<string, string> = {},
  ) => {
    const loaded = mkdtempSync(join(dir, 'credentials-'))
    for (const [name, value] of Object.entries(credentials)) {
      writeFileSync(join(loaded, name), value)
    }
    return Bun.spawn([process.execPath, program, ...args], {
      env: { CREDENTIALS_DIRECTORY: loaded },
      stderr: 'pipe',
      stdout: 'pipe',
    })
  }

  it('refuses to start on arguments it cannot read', () =>
    withSocketDir(async dir => {
      const socket = join(dir, 'http.sock')
      for (const [args, code] of [
        [[], 64],
        [['--grants', '[]'], 64],
        [[socket, '--grants'], 64],
        [[socket, '--listen', 'everywhere'], 64],
        [[socket, '--grants', '[{"credential":"T","profile":"github","repos":["you/api"]}]'], 78],
        [[socket, '--tunnel', 'everywhere'], 78],
      ] as const) {
        assert.strictEqual(await start(dir, args).exited, code, JSON.stringify(args))
      }
      assert.isFalse(existsSync(socket))
    }))

  it('refuses to start without a credential one of its grants needs', () =>
    withSocketDir(async dir => {
      const socket = join(dir, 'http.sock')
      const broker = start(dir, [socket, '--grants', JSON.stringify(grants)])
      assert.strictEqual(await broker.exited, 78)
      assert.include(await new Response(broker.stderr).text(), 'GITHUB_TOKEN')
      assert.isFalse(existsSync(socket))
    }))

  it('starts again where a broker killed outright left its sockets', () =>
    withSocketDir(async dir => {
      // What the kernel does when memory runs out, and what its unit does next.
      const socket = join(dir, 'http.sock')
      const proxy = join(dir, 'proxy.sock')
      const args = [
        socket,
        '--grants',
        JSON.stringify(grants),
        '--proxy',
        proxy,
        '--tunnel',
        '["pypi.org"]',
      ]
      const listening = async (): Promise<boolean> => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (existsSync(socket) && existsSync(proxy)) return true
          await Bun.sleep(50)
        }
        return false
      }
      const first = start(dir, args, { GITHUB_TOKEN: 'ghp-test' })
      assert.isTrue(await listening())
      first.kill('SIGKILL')
      await first.exited
      assert.isTrue(existsSync(socket) && existsSync(proxy))

      const second = start(dir, args, { GITHUB_TOKEN: 'ghp-test' })
      try {
        await Bun.sleep(500)
        const response = await fetch('http://broker/local/llama-swap/v1/models', {
          unix: socket,
        })
        assert.strictEqual(response.status, 403)
        assert.strictEqual((await knock(proxy)).answer, 'held')
      } finally {
        second.kill()
      }
    }))

  it('serves both listeners, names what it holds but never the value, and stops on SIGTERM', () =>
    withSocketDir(async dir => {
      const socket = join(dir, 'http.sock')
      const proxy = join(dir, 'proxy.sock')
      const broker = start(
        dir,
        [socket, '--grants', JSON.stringify(grants), '--proxy', proxy, '--tunnel', '["pypi.org"]'],
        { GITHUB_TOKEN: 'ghp-never-written' },
      )
      try {
        for (
          let attempt = 0;
          attempt < 100 && !(existsSync(socket) && existsSync(proxy));
          attempt++
        ) {
          await Bun.sleep(50)
        }
        const { received, socket: connection } = await dial(socket)
        connection.write(
          'GET /local/llama-swap/v1/models HTTP/1.1\r\n' +
            'Host: broker\r\nConnection: close\r\n\r\n',
        )
        for (let attempt = 0; attempt < 40 && received() === ''; attempt++) await Bun.sleep(25)
        connection.end()
        assert.strictEqual(received().split('\r\n')[0], 'HTTP/1.1 403 Forbidden')

        broker.kill('SIGTERM')
        assert.strictEqual(await broker.exited, 0)
        const stdout = await new Response(broker.stdout).text()
        const output = stdout + (await new Response(broker.stderr).text())
        assert.notInclude(output, 'ghp-never-written')
        // Every line is an event, the startup lines included, so what each
        // names is a field rather than a phrase to be found in a sentence.
        const events = stdout
          .trim()
          .split('\n')
          .map((line): Record<string, unknown> => JSON.parse(line))
        const { t: _tunnelAt, ...tunnel } = events.find(e => e['event'] === 'tunnel-listening')!
        assert.deepStrictEqual(tunnel, {
          destinations: ['pypi.org'],
          event: 'tunnel-listening',
          socket: proxy,
        })
        const { t: _listeningAt, ...listening } = events.find(e => e['event'] === 'listening')!
        assert.deepStrictEqual(listening, {
          credentials: ['GITHUB_TOKEN'],
          event: 'listening',
          grants: [
            {
              credential: 'GITHUB_TOKEN',
              hosts: ['api.github.com', 'github.com'],
              profile: 'github',
              repos: ['you/api'],
              sets: ['fetch', 'graphql', 'read'],
            },
          ],
          socket,
        })
        const denied = events.find(e => e['event'] === 'deny')
        assert.strictEqual(denied?.['server'], 'llama-swap')
      } finally {
        broker.kill()
      }
    }))

  it('answers its git grants’ host over TLS through the tunnel, naming neither half of its identity as a credential', () =>
    withSocketDir(async dir => {
      const identity = tlsIdentity(dir)
      const socket = join(dir, 'http.sock')
      const proxy = join(dir, 'proxy.sock')
      const tls = join(dir, 'tls.sock')
      const broker = start(
        dir,
        [
          socket,
          '--grants',
          JSON.stringify(grants),
          '--proxy',
          proxy,
          '--tunnel',
          '[]',
          '--tls',
          tls,
        ],
        {
          GITHUB_TOKEN: 'ghp-never-written',
          [Broker.tlsCertificateCredential]: identity.cert,
          [Broker.tlsKeyCredential]: identity.key,
        },
      )
      try {
        for (
          let attempt = 0;
          attempt < 100 && ![socket, proxy, tls].every(path => existsSync(path));
          attempt++
        ) {
          await Bun.sleep(50)
        }
        const response = await overTunnel(
          proxy,
          'github.com',
          identity.cert,
          addressedTo('github.com', '/someone/else/info/refs?service=git-upload-pack'),
        )
        assert.strictEqual(response.split('\r\n')[0], 'HTTP/1.1 403 Forbidden')
        assert.include(response, 'not a repository this VM may fetch')

        broker.kill('SIGTERM')
        assert.strictEqual(await broker.exited, 0)
        const stdout = await new Response(broker.stdout).text()
        const output = stdout + (await new Response(broker.stderr).text())
        const keyBody = identity.key.split('\n')[1] ?? identity.key
        assert.notInclude(output, keyBody)
        const events = stdout
          .trim()
          .split('\n')
          .map((line): Record<string, unknown> => JSON.parse(line))
        const { t: _tlsAt, ...listeningTls } = events.find(e => e['event'] === 'tls-listening')!
        assert.deepStrictEqual(listeningTls, {
          event: 'tls-listening',
          names: ['api.github.com', 'github.com'],
          socket: tls,
        })
        const listening = events.find(e => e['event'] === 'listening')
        assert.deepStrictEqual(listening?.['credentials'], ['GITHUB_TOKEN'])
      } finally {
        broker.kill()
      }
    }))

  it('refuses to answer TLS without its certificate and key, and lends neither to a grant', () =>
    withSocketDir(async dir => {
      const identity = tlsIdentity(dir)
      const socket = join(dir, 'http.sock')
      const tls = join(dir, 'tls.sock')

      const withoutKey = start(dir, [socket, '--grants', JSON.stringify(grants), '--tls', tls], {
        GITHUB_TOKEN: 'ghp-test',
        [Broker.tlsCertificateCredential]: identity.cert,
      })
      assert.strictEqual(await withoutKey.exited, 78)
      assert.include(await new Response(withoutKey.stderr).text(), Broker.tlsKeyCredential)

      const lending = start(
        dir,
        [
          socket,
          '--grants',
          JSON.stringify([{ ...github(), credential: Broker.tlsKeyCredential }]),
        ],
        {
          [Broker.tlsCertificateCredential]: identity.cert,
          [Broker.tlsKeyCredential]: identity.key,
        },
      )
      assert.strictEqual(await lending.exited, 78)
      assert.include(await new Response(lending.stderr).text(), 'which was not loaded')
      assert.isFalse(existsSync(socket))
      assert.isFalse(existsSync(tls))
    }))
})

describe('Broker.serveRequests, for a model server', () => {
  const sent: Array<{ readonly body: string; readonly init: RequestInit; readonly url: string }> =
    []
  const server = async (url: string, init: RequestInit): Promise<Response> => {
    sent.push({ body: init.body ? await new Response(init.body).text() : '', init, url })
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }

  const allowed = (audited: ReadonlyArray<unknown>) =>
    audited.filter(
      (event): event is Record<string, unknown> =>
        typeof event === 'object' && event !== null && 'event' in event && event.event === 'allow',
    )

  it('sends a model call to the server’s port, with no credential for a server that takes none', () => {
    sent.length = 0
    return auditing(audited =>
      serving(servers, new Map([['model-server.ollama', 'sk-local']]), server, async broker => {
        const body = JSON.stringify({ messages: [], model: 'Qwen3.5-2B', stream: true })
        const response = await broker.fetch(
          new Request('http://broker/local/llama-swap/v1/chat/completions', {
            body,
            headers: { authorization: 'Bearer not-needed', 'content-type': 'application/json' },
            method: 'POST',
          }),
        )
        assert.strictEqual(await response.text(), 'data: [DONE]\n\n')
        assert.strictEqual(response.headers.get('content-type'), 'text/event-stream')
        const [first] = sent
        assert.strictEqual(first?.url, 'http://127.0.0.1:8080/v1/chat/completions')
        assert.strictEqual(first?.body, body)
        assert.strictEqual(first?.init.redirect, 'manual')
        assert.isNull(new Headers(first?.init.headers).get('authorization'))
        assert.deepStrictEqual(
          allowed(audited).map(({ credential, host, operation, server: name }) => ({
            credential,
            host,
            name,
            operation,
          })),
          [
            {
              credential: undefined,
              host: '127.0.0.1:8080',
              name: 'llama-swap',
              operation: 'chat-completions',
            },
          ],
        )
      }),
    )
  })

  it('sends a server’s key as a bearer token when its grant holds one', () => {
    sent.length = 0
    return auditing(() =>
      serving(servers, new Map([['model-server.ollama', 'sk-local']]), server, async broker => {
        await (await broker.fetch(new Request('http://broker/local/ollama/v1/models'))).text()
        const [first] = sent
        assert.strictEqual(first?.url, 'http://127.0.0.1:11434/v1/models')
        assert.strictEqual(first?.init.method, 'GET')
        assert.strictEqual(new Headers(first?.init.headers).get('authorization'), 'Bearer sk-local')
      }),
    )
  })

  it('sends nothing for a key it was not given', () => {
    sent.length = 0
    return auditing(() =>
      serving(servers, new Map(), server, async broker => {
        const response = await broker.fetch(
          new Request('http://broker/local/ollama/v1/chat/completions', {
            body: '{}',
            method: 'POST',
          }),
        )
        assert.strictEqual(response.status, 500)
        assert.strictEqual(sent.length, 0)
      }),
    )
  })

  it('tells the guest a server wants a key, and that asking again will not help', () =>
    auditing(() =>
      serving(
        servers,
        new Map(),
        () => Promise.resolve(new Response('{"error":"Invalid API Key"}', { status: 401 })),
        async broker => {
          const response = await broker.fetch(
            new Request('http://broker/local/llama-swap/v1/chat/completions', {
              body: '{}',
              method: 'POST',
            }),
          )
          assert.strictEqual(response.status, 403)
          assert.strictEqual(response.headers.get('x-should-retry'), 'false')
          assert.include(await response.text(), '127.0.0.1:8080 wants a credential')
        },
      ),
    ))
})

/** A profile grant at two hosts, with a rule of each kind the format has. */
const example: Broker.ProfileGrant = {
  credential: 'EXAMPLE_KEY',
  hosts: {
    'api.example.com': {
      allow: [
        { method: ['GET', 'HEAD'], path: 'v1/**', set: 'read' },
        { method: ['GET'], path: '', set: 'read' },
        { method: ['POST'], path: 'v1/items', set: 'write' },
        { method: ['DELETE', 'PATCH'], path: 'v1/items/*', set: 'write' },
        { method: '*', path: 'open/**', set: 'open' },
        { graphql: { withheld: ['apiKeys'] }, method: ['POST'], path: 'graphql', set: 'read' },
      ],
      deny: [{ method: '*', path: 'v1/items/*/keys/**' }],
      send: 'bearer',
    },
    'uploads.example.com': {
      allow: [{ method: ['POST'], path: 'files', set: 'write' }],
      deny: [],
      send: { header: 'X-Example-Key' },
    },
  },
  profile: 'example',
}
const exampleGrants: readonly Broker.Grant[] = [example]

/** `decideAddressed` for a request to `url`, as the TLS listener reads one. */
const addressed = (method: string, url: string, reach: Broker.TunnelScope = []) =>
  Broker.decideAddressed(exampleGrants, method, url, reach)

describe('Broker.parseGrants, for a profile grant', () => {
  const grantJson = (change: Record<string, unknown> = {}, host: Record<string, unknown> = {}) =>
    JSON.stringify([
      {
        credential: 'K',
        hosts: {
          'api.example.com': {
            allow: [{ method: ['GET'], path: 'v1/**', set: 'read' }],
            deny: [],
            send: 'bearer',
            ...host,
          },
        },
        profile: 'example',
        ...change,
      },
    ])

  it('reads one, every field as it was sent', () => {
    assert.deepStrictEqual(Broker.parseGrants(JSON.stringify(exampleGrants)), {
      grants: [...exampleGrants],
    })
  })

  it('refuses a field it does not read, on the grant, a host or a rule', () => {
    assert.include(message(grantJson({ ask: ['read'] })), 'sets ask')
    assert.include(message(grantJson({}, { cache: 'none' })), 'sets cache')
    assert.include(
      message(grantJson({}, { allow: [{ mcp: {}, method: ['GET'], path: 'v1', set: 'r' }] })),
      'sets mcp',
    )
    assert.include(
      message(grantJson({}, { deny: [{ method: ['GET'], path: 'v1', set: 'read' }] })),
      'sets set',
    )
    assert.include(
      message(grantJson({}, { deny: [{ length: 'kept', method: ['POST'], path: 'v1' }] })),
      'sets length',
    )
  })

  it('refuses a host option or a length that is not one, and pages without a repository', () => {
    assert.include(message(grantJson({}, { redirects: 'follow' })), 'redirects is "return"')
    assert.include(message(grantJson({}, { pages: 'gitlab' })), 'pages is "github"')
    assert.include(message(grantJson({}, { pages: 'github' })), 'the grant has none')
    assert.include(
      message(
        grantJson({}, { allow: [{ length: 'all', method: ['POST'], path: 'v1', set: 'r' }] }),
      ),
      'length at "v1" is "kept"',
    )
    assert.include(
      message(
        grantJson(
          {},
          {
            allow: [
              {
                graphql: { withheld: [] },
                length: 'kept',
                method: ['POST'],
                path: 'graphql',
                set: 'r',
              },
            ],
          },
        ),
      ),
      'no length the guest stated',
    )
  })

  it('refuses a host that is an address, a single label, or not lowercase', () => {
    for (const host of ['10.0.0.1', 'localhost', 'API.example.com']) {
      const json = JSON.stringify([
        {
          credential: 'K',
          hosts: {
            [host]: { allow: [{ method: ['GET'], path: '', set: 'r' }], deny: [], send: 'bearer' },
          },
          profile: 'example',
        },
      ])
      assert.include(message(json), 'not a lowercase hostname', host)
    }
  })

  it('refuses a host with no rule, or one sending its key in a header the broker owns', () => {
    assert.include(message(grantJson({}, { allow: [] })), 'allows nothing')
    assert.include(message(grantJson({}, { send: { header: 'Content-Length' } })), 'frames')
    assert.include(message(grantJson({}, { send: { basic: 'a:b' } })), 'username')
    assert.include(message(grantJson({}, { send: 'query' })), 'bearer')
  })

  it('refuses a rule whose path or methods are not a rule’s', () => {
    for (const path of [
      'v1/**/x',
      '/v1',
      'v1/',
      'v1//x',
      'v1/a*',
      'v1/..',
      'v1/%2e',
      'repos/{repo}/**',
    ]) {
      const json = grantJson({}, { allow: [{ method: ['GET'], path, set: 'read' }] })
      assert.isTrue('message' in Broker.parseGrants(json), path)
    }
    for (const method of [[], ['FETCH'], 'GET', ['*']]) {
      const json = grantJson({}, { allow: [{ method, path: 'v1', set: 'read' }] })
      assert.isTrue('message' in Broker.parseGrants(json), JSON.stringify(method))
    }
    assert.include(
      message(
        grantJson(
          {},
          {
            allow: [{ graphql: { withheld: [] }, method: ['GET'], path: 'graphql', set: 'read' }],
          },
        ),
      ),
      'POST alone',
    )
  })

  it('refuses two grants for one profile, and a host two grants name', () => {
    const one = grantJson().slice(1, -1)
    assert.include(message(`[${one},${one}]`), 'two example grants')
    const other = grantJson({ profile: 'other' }).slice(1, -1)
    assert.include(message(`[${one},${other}]`), 'api.example.com')
  })

  it('refuses the name a model server’s grant is read by', () => {
    assert.include(message(grantJson({ profile: 'model-server' })), 'model-server')
  })
})

describe('Broker.parseGrants, for a grant with a repository', () => {
  /** A grant with a repository of two segments, `fetch` at its git host and `write` at its API. */
  const slotted = (change: Record<string, unknown> = {}) =>
    JSON.stringify([
      {
        credential: 'K',
        hosts: {
          'api.example.com': {
            allow: [
              { method: ['GET'], path: '', set: 'write' },
              { method: ['POST'], path: 'repos/{repo}/issues', set: 'write' },
              { method: ['POST'], path: 'graphql', set: 'graphql' },
            ],
            deny: [],
            pages: 'github',
            send: 'bearer',
          },
          'git.example.com': {
            allow: [{ git: 'fetch', set: 'fetch' }],
            deny: [],
            send: { basic: 'x-access-token' },
          },
        },
        profile: 'forge',
        repos: { 'You/API': ['fetch', 'write'] },
        repository: { ignoreCase: true, segments: 2 },
        ...change,
      },
    ])

  it('reads one, its repository and repos as they were sent', () => {
    const parsed = Broker.parseGrants(slotted())
    assert.isTrue('grants' in parsed)
    if (!('grants' in parsed)) return
    const [grant] = parsed.grants
    assert.isTrue(grant !== undefined && Broker.isProfileGrant(grant))
    if (grant === undefined || !Broker.isProfileGrant(grant)) return
    assert.deepStrictEqual(grant.repository, { ignoreCase: true, segments: 2 })
    assert.deepStrictEqual(grant.repos, { 'You/API': ['fetch', 'write'] })
    assert.deepStrictEqual(grant.hosts['git.example.com']?.allow, [{ git: 'fetch', set: 'fetch' }])
    assert.strictEqual(grant.hosts['api.example.com']?.pages, 'github')
  })

  it('refuses a repository that is not one, and repos without one', () => {
    for (const repository of [
      { ignoreCase: true, segments: 0 },
      { ignoreCase: true, segments: 2.5 },
      { segments: 2 },
      { ignoreCase: 'yes', segments: 2 },
      { ignoreCase: true, segments: 2, separator: '/' },
    ]) {
      assert.include(
        message(slotted({ repository })),
        'a repository is { segments; ignoreCase; }',
        JSON.stringify(repository),
      )
    }
    assert.include(message(slotted({ repository: undefined })), 'and the grant has none')
    assert.include(
      message(
        JSON.stringify([
          {
            credential: 'K',
            hosts: {
              'api.example.com': {
                allow: [{ method: ['GET'], path: '', set: 'read' }],
                deny: [],
                send: 'bearer',
              },
            },
            profile: 'example',
            repos: { 'you/api': ['read'] },
          },
        ]),
      ),
      'lists repos, and has no repository',
    )
    assert.include(message(slotted({ repos: undefined })), 'no repos listing them')
  })

  it('refuses a repository listed in another shape, or twice by spellings one service reads as one', () => {
    for (const repo of ['you', 'you/api/x', 'you/../api', '-you/api', 'you/a%2fb']) {
      assert.include(
        message(slotted({ repos: { [repo]: ['fetch'] } })),
        'is not a repository',
        repo,
      )
    }
    assert.include(
      message(slotted({ repos: { 'you/api': ['fetch'], 'You/Api.git': ['write'] } })),
      'lists you/api twice',
    )
    assert.isTrue(
      'grants' in
        Broker.parseGrants(
          slotted({
            repos: { 'you/api': ['fetch'], 'You/Api': ['write'] },
            repository: { ignoreCase: false, segments: 2 },
          }),
        ),
    )
  })

  it('refuses a repository listing a set no rule of which names one, or no set', () => {
    assert.include(
      message(slotted({ repos: { 'you/api': ['fetch', 'graphql'] } })),
      'lists graphql for you/api, and none of its rules names a repository',
    )
    assert.include(message(slotted({ repos: { 'you/api': [] } })), 'lists no sets')
  })

  it('refuses a rule naming a repository whose set no repository lists', () => {
    assert.include(
      message(slotted({ repos: { 'you/api': ['fetch'] } })),
      'names a repository, and no repository lists write',
    )
  })

  it('refuses a git rule with more beside it, of another access, or without a repository', () => {
    const git = (rule: Record<string, unknown>, repository?: unknown) =>
      JSON.stringify([
        {
          credential: 'K',
          hosts: { 'git.example.com': { allow: [rule], deny: [], send: 'bearer' } },
          profile: 'forge',
          ...(repository === undefined ? {} : { repos: { 'you/api': ['fetch'] }, repository }),
        },
      ])
    const slot = { ignoreCase: true, segments: 2 }
    assert.include(
      message(git({ git: 'fetch', method: ['GET'], set: 'fetch' }, slot)),
      'takes git alone',
    )
    assert.include(message(git({ git: 'clone', set: 'fetch' }, slot)), 'git is "fetch" or "push"')
    assert.include(message(git({ git: 'fetch', set: 'fetch' })), 'the grant has none')
    assert.include(message(git({ git: 'fetch' }, slot)), 'names no set')
  })

  it('refuses {repo} in a deny rule, or twice in one path', () => {
    assert.include(
      message(
        slotted({
          hosts: {
            'git.example.com': {
              allow: [{ git: 'fetch', set: 'fetch' }],
              deny: [{ method: ['POST'], path: 'repos/{repo}/hooks' }],
              send: 'bearer',
            },
          },
          repos: { 'you/api': ['fetch'] },
        }),
      ),
      'which a rule of no set cannot',
    )
    assert.include(
      message(
        slotted({
          hosts: {
            'api.example.com': {
              allow: [{ method: ['GET'], path: '{repo}/{repo}', set: 'write' }],
              deny: [],
              send: 'bearer',
            },
          },
          repos: { 'you/api': ['write'] },
        }),
      ),
      'names {repo} twice',
    )
  })
})

describe('Broker.decideAddressed, for a profile grant', () => {
  it('allows what a chosen rule matches, sending the path and the query rebuilt', () => {
    assert.deepStrictEqual(addressed('GET', 'https://api.example.com/v1/items?b=2&a=x%20y'), {
      _tag: 'Profile',
      credential: 'EXAMPLE_KEY',
      host: 'api.example.com',
      profile: 'example',
      rule: 'GET,HEAD v1/**',
      send: 'bearer',
      sendsBody: false,
      set: 'read',
      upstream: 'https://api.example.com/v1/items?b=2&a=x+y',
    })
    const written = addressed('POST', 'https://API.Example.com/v1/items')
    assert.strictEqual(written._tag === 'Profile' ? written.set : written._tag, 'write')
    assert.strictEqual(written._tag === 'Profile' ? written.sendsBody : undefined, true)
    const uploaded = addressed('POST', 'https://uploads.example.com/files?name=a.txt')
    assert.strictEqual(
      uploaded._tag === 'Profile' ? uploaded.upstream : uploaded._tag,
      'https://uploads.example.com/files?name=a.txt',
    )
  })

  it('refuses what a deny rule matches, whatever set allows it', () => {
    const denied = addressed('GET', 'https://api.example.com/v1/items/7/keys')
    assert.strictEqual(outcome(denied), 403)
    assert.include(denied._tag === 'Deny' ? denied.reason : '', 'deny rule * v1/items/*/keys/**')
    assert.strictEqual(
      outcome(addressed('DELETE', 'https://api.example.com/v1/items/7/keys/1')),
      403,
    )
    assert.strictEqual(outcome(addressed('DELETE', 'https://api.example.com/v1/items/7')), 'allow')
  })

  it('refuses what no chosen rule matches, by its path or by its method', () => {
    assert.strictEqual(outcome(addressed('POST', 'https://api.example.com/v2/other')), 403)
    assert.strictEqual(outcome(addressed('POST', 'https://api.example.com/v1/other')), 405)
    const other = addressed('POST', 'https://api.example.com/v1/other')
    assert.strictEqual(
      other._tag === 'Deny' ? other.reason : '',
      'POST /v1/other is not something this VM may do through api.example.com, which allows GET, HEAD there',
    )
    assert.strictEqual(outcome(addressed('PUT', 'https://api.example.com/v1/items')), 405)
    assert.strictEqual(outcome(addressed('GET', 'https://uploads.example.com/files')), 405)
    assert.strictEqual(outcome(addressed('GET', 'https://api.example.com/v2/items')), 403)
  })

  it('takes any method for a rule whose method is "*"', () => {
    for (const method of ['GET', 'PUT', 'OPTIONS', 'PROPFIND']) {
      assert.strictEqual(outcome(addressed(method, 'https://api.example.com/open/a/b')), 'allow')
    }
    assert.strictEqual(outcome(addressed('GET', 'https://api.example.com/open')), 'allow')
  })

  it('matches the host’s root by "" alone, with its query', () => {
    const root = addressed('GET', 'https://api.example.com/?page=2')
    assert.strictEqual(
      root._tag === 'Profile' ? root.upstream : root._tag,
      'https://api.example.com/?page=2',
    )
    assert.strictEqual(root._tag === 'Profile' ? root.rule : root._tag, 'GET /')
    assert.strictEqual(outcome(addressed('HEAD', 'https://api.example.com/')), 405)
    assert.strictEqual(outcome(addressed('GET', 'https://api.example.com/x')), 403)
  })

  it('refuses a percent-escape, and sends a path with every dot segment resolved', () => {
    assert.strictEqual(outcome(addressed('GET', 'https://api.example.com/v1/a%2Fb')), 400)
    const resolved = addressed('POST', 'https://api.example.com/v1/x/../items')
    assert.strictEqual(
      resolved._tag === 'Profile' ? resolved.upstream : resolved._tag,
      'https://api.example.com/v1/items',
    )
    assert.strictEqual(outcome(addressed('POST', 'https://api.example.com/v1/../v2/items')), 403)
  })

  it('reads a path ending in a git endpoint as the profile’s, not as git', () => {
    const advertised = addressed(
      'GET',
      'https://api.example.com/v1/a/b/info/refs?service=git-upload-pack',
    )
    assert.strictEqual(
      advertised._tag === 'Profile' ? advertised.upstream : advertised._tag,
      'https://api.example.com/v1/a/b/info/refs?service=git-upload-pack',
    )
    const push = addressed('POST', 'https://api.example.com/a/b/git-receive-pack')
    assert.strictEqual(outcome(push), 403)
    assert.include(push._tag === 'Deny' ? push.reason : '', 'through api.example.com')
  })

  it('sends a GraphQL rule’s request without its query', () => {
    const query = addressed(
      'POST',
      'https://api.example.com/graphql?query=mutation%20%7B%20x%20%7D',
    )
    assert.deepStrictEqual(
      query._tag === 'Profile' ? [query.upstream, query.graphql] : query._tag,
      ['https://api.example.com/graphql', { withheld: ['apiKeys'] }],
    )
  })

  it('answers only the hosts the grant names, and not in the path form', () => {
    assert.strictEqual(outcome(addressed('GET', 'https://www.example.com/v1/items')), 421)
    assert.deepStrictEqual(Broker.tlsNames(exampleGrants), [
      'api.example.com',
      'uploads.example.com',
    ])
    assert.strictEqual(
      outcome(Broker.decide(exampleGrants, 'GET', '/api.example.com/v1/items')),
      404,
    )
  })

  it('writes its refusals in JSON', () => {
    const refused = addressed('POST', 'https://api.example.com/v1/other')
    assert.isTrue(refused._tag === 'Deny' && refused.json === true)
  })
})

describe('Broker.decideAddressed, on a read no profile rule covers', () => {
  it('sends it without the key where the tunnel reaches the host, a read a deny rule matches too', () => {
    for (const path of ['/docs/start', '/v1/items/7/keys']) {
      assert.deepStrictEqual(
        addressed('GET', `https://api.example.com${path}?q=1`, ['api.example.com']),
        {
          _tag: 'Anonymous',
          host: 'api.example.com',
          operation: 'read',
          upstream: `https://api.example.com${path}?q=1`,
        },
      )
    }
    assert.strictEqual(outcome(addressed('GET', 'https://api.example.com/docs', 'any')), 'allow')
  })

  it('refuses it where the tunnel does not reach the host, and refuses a write either way', () => {
    assert.strictEqual(outcome(addressed('GET', 'https://api.example.com/docs')), 403)
    assert.strictEqual(
      outcome(addressed('GET', 'https://api.example.com/docs', ['example.com'])),
      403,
    )
    assert.strictEqual(outcome(addressed('POST', 'https://api.example.com/docs', 'any')), 403)
    assert.strictEqual(
      outcome(addressed('DELETE', 'https://api.example.com/v1/items/7/keys/1', 'any')),
      403,
    )
  })
})

describe('Broker.upstreamHeaders, for a profile grant', () => {
  const decision = (send: Broker.Send) => {
    const decided = addressed('POST', 'https://api.example.com/v1/items')
    if (decided._tag !== 'Profile') throw new Error('not allowed')
    return { ...decided, send }
  }
  const guest = {
    Authorization: 'Bearer igloo-broker-holds-the-real-key',
    'Content-Type': 'application/json',
    'X-Example-Key': 'igloo-broker-holds-the-real-key',
    'X-Request-Id': 'r1',
  }

  it('sends the key as a bearer token, replacing the guest’s', () => {
    const headers = Broker.upstreamHeaders(decision('bearer'), 'k-real', new Headers(guest))
    assert.strictEqual(headers.get('Authorization'), 'Bearer k-real')
    assert.strictEqual(headers.get('X-Request-Id'), 'r1')
    assert.strictEqual(headers.get('Content-Type'), 'application/json')
  })

  it('sends the key as a named header’s one value, replacing the guest’s copy of it', () => {
    const headers = Broker.upstreamHeaders(
      decision({ header: 'x-example-key' }),
      'k-real',
      new Headers(guest),
    )
    assert.strictEqual(headers.get('X-Example-Key'), 'k-real')
    assert.isNull(headers.get('Authorization'))
  })

  it('sends the key as a Basic password under the profile’s username', () => {
    const headers = Broker.upstreamHeaders(
      decision({ basic: 'x-access-token' }),
      'k-real',
      new Headers(guest),
    )
    assert.strictEqual(headers.get('Authorization'), `Basic ${btoa('x-access-token:k-real')}`)
  })

  it('sends no body’s headers for a read', () => {
    const read = addressed('GET', 'https://api.example.com/v1/items')
    if (read._tag !== 'Profile') throw new Error('not allowed')
    const headers = Broker.upstreamHeaders(read, 'k-real', new Headers(guest))
    assert.isNull(headers.get('Content-Type'))
  })
})

describe('Broker.serveTls, for a profile grant', () => {
  const credentials: ReadonlyMap<string, string> = new Map([['EXAMPLE_KEY', 'k-real']])
  const sent: Array<{
    readonly body: string | undefined
    readonly init: RequestInit
    readonly url: string
  }> = []
  const upstream =
    (status = 200) =>
    async (url: string, init: RequestInit): Promise<Response> => {
      const body =
        init.body === undefined || init.body === null
          ? undefined
          : await new Response(init.body).text()
      sent.push({ body, init, url })
      return new Response('{"ok":true}', {
        headers: { 'Content-Type': 'application/json' },
        status,
      })
    }
  const servingTls = <A>(
    send: (url: string, init: RequestInit) => Promise<Response>,
    use: (server: ReturnType<typeof Broker.serveTls>) => Promise<A>,
  ): Promise<A> =>
    withSocketDir(async dir => {
      const server = Broker.serveTls(
        join(dir, 'tls.sock'),
        exampleGrants,
        credentials,
        tlsIdentity(dir, 'api.example.com'),
        [],
        send,
      )
      try {
        return await use(server)
      } finally {
        await server.stop(true)
      }
    })
  const graphql = (query: string) =>
    new Request('https://api.example.com/graphql', {
      body: JSON.stringify({ query }),
      method: 'POST',
    })

  it('reads a GraphQL rule’s body with the rule’s own withheld fields', () =>
    servingTls(upstream(), async server => {
      sent.length = 0
      assert.strictEqual((await server.fetch(graphql('{ me { registryAuth } }'))).status, 200)
      assert.strictEqual(sent[0]?.body, '{"query":"{ me { registryAuth } }"}')
      assert.strictEqual(new Headers(sent[0]?.init.headers).get('Content-Type'), 'application/json')
      const withheld = await server.fetch(graphql('{ me { apiKeys { value } } }'))
      assert.strictEqual(withheld.status, 403)
      assert.include(await withheld.text(), 'apiKeys')
      assert.strictEqual((await server.fetch(graphql('mutation { a }'))).status, 403)
      assert.strictEqual(sent.length, 1)
    }))

  it('logs the profile, the set and the rule that allowed a request', () =>
    auditing(audited =>
      servingTls(upstream(), async server => {
        await server.fetch(
          new Request('https://api.example.com/v1/items', { method: 'POST', body: '{}' }),
        )
        assert.deepStrictEqual(untimed(audited, 'allow'), [
          {
            credential: 'EXAMPLE_KEY',
            event: 'allow',
            host: 'api.example.com',
            id: 1,
            profile: 'example',
            rule: 'POST v1/items',
            set: 'write',
          },
        ])
      }),
    ))

  it('makes the host’s 401 the broker’s 403, naming the credential, and refuses its redirect', () =>
    servingTls(upstream(401), async server => {
      const refused = await server.fetch(new Request('https://api.example.com/v1/items'))
      assert.strictEqual(refused.status, 403)
      assert.strictEqual(refused.headers.get('Content-Type'), 'application/json; charset=utf-8')
      assert.include(await refused.text(), 'refused EXAMPLE_KEY')
    }).then(() =>
      servingTls(upstream(302), async server => {
        assert.strictEqual(
          (await server.fetch(new Request('https://api.example.com/v1/items'))).status,
          502,
        )
      }),
    ))

  it('answers a profile host through the tunnel for its grant, and not without one', () =>
    withSocketDir(async dir => {
      sent.length = 0
      const identity = tlsIdentity(dir, 'api.example.com')
      const tlsPath = join(dir, 'tls.sock')
      const proxyPath = join(dir, 'proxy.sock')
      const server = Broker.serveTls(tlsPath, exampleGrants, credentials, identity, [], upstream())
      const tunnel = Broker.serveTunnel(proxyPath, [], Broker.publicDestinations, {
        names: Broker.tlsNames(exampleGrants),
        socket: tlsPath,
      })
      try {
        const served = await overTunnel(
          proxyPath,
          'api.example.com',
          identity.cert,
          addressedTo('api.example.com', '/v1/items'),
        )
        assert.strictEqual(served.split('\r\n')[0], 'HTTP/1.1 200 OK')
        assert.strictEqual(sent[0]?.url, 'https://api.example.com/v1/items')
        assert.strictEqual(new Headers(sent[0]?.init.headers).get('Authorization'), 'Bearer k-real')
      } finally {
        tunnel.stop(true)
        await server.stop(true)
      }
      const without = Broker.serveTls(
        join(dir, 'other.sock'),
        grants,
        held,
        identity,
        [],
        upstream(),
      )
      try {
        const refused = await without.fetch(new Request('https://api.example.com/v1/items'))
        assert.strictEqual(refused.status, 421)
      } finally {
        await without.stop(true)
      }
    }))
})

/** What a request came to: refused, or what reached the upstream. */
type Reached = 'refused' | { readonly body?: string; readonly key: string; readonly url: string }

/** A request of the corpus, by the name it is addressed to, and what it should come to. */
interface Case {
  readonly body?: string
  readonly expected: Reached
  readonly method: string
  readonly url: string
}

/** The key each profile sends, and how, as the upstream sees it. */
const keys = {
  'anthropic-messages': { credential: 'ANTHROPIC_KEY', header: 'x-api-key: an-k', value: 'an-k' },
  github: { credential: 'GITHUB_TOKEN', header: 'authorization: Bearer gh-k', value: 'gh-k' },
  openrouter: { credential: 'OPENROUTER_KEY', header: 'authorization: Bearer or-k', value: 'or-k' },
  runpod: { credential: 'RUNPOD_API_KEY', header: 'authorization: Bearer rp-k', value: 'rp-k' },
} as const

const sentTo = (url: string, profile: keyof typeof keys, body?: string): Reached => ({
  ...(body === undefined ? {} : { body }),
  key: keys[profile].header,
  url,
})

const runpodRest = 'https://api.runpod.io'
const runpodInvoke = 'https://api.runpod.ai'
const sentToRunpod = (path: string): Reached => sentTo(`${runpodRest}${path}`, 'runpod')
const graphqlBody = (query: string) => JSON.stringify({ query })

/**
 * What `runpod` serves, and refuses: each write its sets allow, reads,
 * GraphQL queries and mutations, a serverless endpoint's calls, the areas
 * refused by design, and writes nothing lists.
 */
const runpodCorpus: readonly Case[] = [
  ...[
    ['POST', '/v2/account/secrets'],
    ['DELETE', '/v2/account/secrets/s1'],
    ['PATCH', '/v2/account/secrets/s1'],
    ['POST', '/v2/clusters'],
    ['DELETE', '/v2/clusters/c1'],
    ['PATCH', '/v2/clusters/c1'],
    ['POST', '/v2/global-volumes'],
    ['DELETE', '/v2/global-volumes/g1'],
    ['PATCH', '/v2/global-volumes/g1'],
    ['POST', '/v2/network-volumes'],
    ['DELETE', '/v2/network-volumes/n1'],
    ['PATCH', '/v2/network-volumes/n1'],
    ['POST', '/v2/pods'],
    ['DELETE', '/v2/pods/p1'],
    ['PATCH', '/v2/pods/p1'],
    ['POST', '/v2/pods/p1/action'],
    ['POST', '/v2/pods/p1/exec'],
    ['DELETE', '/v2/queued-pods/q1'],
    ['POST', '/v2/registries'],
    ['DELETE', '/v2/registries/r1'],
    ['PATCH', '/v2/registries/r1'],
    ['POST', '/v2/serverless'],
    ['DELETE', '/v2/serverless/e1'],
    ['PATCH', '/v2/serverless/e1'],
    ['POST', '/v2/templates'],
    ['DELETE', '/v2/templates/t1'],
    ['PATCH', '/v2/templates/t1'],
  ].map(([method = '', path = '']) => ({
    body: '{}',
    expected: sentTo(`${runpodRest}${path}`, 'runpod', '{}'),
    method,
    url: `${runpodRest}${path}`,
  })),
  { expected: sentToRunpod('/v2/pods'), method: 'GET', url: `${runpodRest}/v2/pods` },
  {
    expected: sentToRunpod('/v2/pods?computeType=GPU&name=a+b'),
    method: 'GET',
    url: `${runpodRest}/v2/pods?computeType=GPU&name=a%20b`,
  },
  {
    expected: sentToRunpod('/v2/templates/t1'),
    method: 'HEAD',
    url: `${runpodRest}/v2/templates/t1`,
  },
  { expected: sentToRunpod('/v2'), method: 'GET', url: `${runpodRest}/v2` },
  {
    expected: sentToRunpod('/v2/user/ssh-keys'),
    method: 'GET',
    url: `${runpodRest}/v2/user/ssh-keys`,
  },
  ...[
    // Refused by design: who may use the account, and how.
    ['POST', '/v2/organization/members'],
    ['PATCH', '/v2/organization'],
    ['POST', '/v2/user/ssh-keys'],
    ['DELETE', '/v2/user/ssh-keys/k1'],
    ['POST', '/v2/signup/attempts'],
    ['POST', '/v2/tags'],
    ['PATCH', '/v2/tags/t1'],
    ['POST', '/v2/cost-centers'],
    ['POST', '/v2/ecr-delegations'],
    // Writes nothing lists: a method, a shape, a version.
    ['PUT', '/v2/pods/p1'],
    ['DELETE', '/v2/pods'],
    ['POST', '/v2/pods/p1/action/more'],
    ['POST', '/v2/pods/p1/start'],
    ['POST', '/v1/pods'],
    ['OPTIONS', '/v2/pods'],
    ['GET', '/v1/pods'],
    ['GET', '/'],
    ['GET', '/graphql'],
  ].map(([method = '', path = '']) => ({
    ...(method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? {} : { body: '{}' }),
    expected: 'refused' as const,
    method,
    url: `${runpodRest}${path}`,
  })),
  // GraphQL: queries alone, sent as written again, and without the URL's query.
  ...[
    ['{ myself { clientBalance } }', true],
    ['query Pods { myself { pods { id } } }', true],
    ['query { myself { id } } fragment F on Pod { id }', true],
    ['mutation { createApiKey(input: {name: "x"}) { rawKey } }', false],
    ['{ myself { containerRegistryCreds { registryAuth } } }', false],
    ['subscription { podStatus { id } }', false],
  ].map(([query, sent]) => ({
    body: graphqlBody(String(query)),
    expected:
      sent === true
        ? sentTo(`${runpodRest}/graphql`, 'runpod', graphqlBody(String(query)))
        : ('refused' as const),
    method: 'POST',
    url: `${runpodRest}/graphql?query=${encodeURIComponent('mutation { a }')}`,
  })),
  {
    body: '[{"query":"{ a }"}]',
    expected: 'refused',
    method: 'POST',
    url: `${runpodRest}/graphql`,
  },
  // A serverless endpoint's own calls.
  ...[
    ['POST', '/v2/ep1/run'],
    ['POST', '/v2/ep1/runsync?wait=60'],
    ['GET', '/v2/ep1/status/job-1'],
    ['HEAD', '/v2/ep1/health'],
  ].map(([method = '', path = '']) => ({
    ...(method === 'POST' ? { body: '{"input":{}}' } : {}),
    expected: sentTo(
      `${runpodInvoke}${path}`,
      'runpod',
      method === 'POST' ? '{"input":{}}' : undefined,
    ),
    method,
    url: `${runpodInvoke}${path}`,
  })),
  ...[
    ['POST', '/v2/ep1'],
    ['PUT', '/v2/ep1/run'],
    ['DELETE', '/v2/ep1/run'],
    ['POST', '/v1/ep1/run'],
    ['GET', '/v2'],
  ].map(([method = '', path = '']) => ({
    ...(method === 'GET' ? {} : { body: '{}' }),
    expected: 'refused' as const,
    method,
    url: `${runpodInvoke}${path}`,
  })),
]

/** What `openrouter` and `anthropic-messages` serve, and refuse: each endpoint, an unlisted one, a wrong method. */
const inferenceCorpus: readonly (Case & {
  readonly profile: 'anthropic-messages' | 'openrouter'
})[] = [
  ...[
    ['POST', '/api/v1/chat/completions'],
    ['POST', '/api/v1/messages'],
    ['POST', '/api/v1/responses'],
    ['GET', '/api/v1/models'],
    ['GET', '/api/v1/models?category=programming'],
    ['GET', '/api/v1/embeddings/models'],
    ['GET', '/api/v1/images/models'],
    ['GET', '/api/v1/videos/models'],
  ].map(([method = '', path = '']) => ({
    ...(method === 'POST' ? { body: '{"model":"m"}' } : {}),
    expected: sentTo(
      `https://openrouter.ai${path}`,
      'openrouter',
      method === 'POST' ? '{"model":"m"}' : undefined,
    ),
    method,
    profile: 'openrouter' as const,
    url: `https://openrouter.ai${path}`,
  })),
  ...[
    ['GET', '/api/v1/chat/completions'],
    ['POST', '/api/v1/models'],
    ['POST', '/api/v1/keys'],
    ['GET', '/api/v1/credits'],
    ['POST', '/api/v1/completions'],
    ['GET', '/api/v1'],
  ].map(([method = '', path = '']) => ({
    ...(method === 'POST' ? { body: '{}' } : {}),
    expected: 'refused' as const,
    method,
    profile: 'openrouter' as const,
    url: `https://openrouter.ai${path}`,
  })),
  ...['/v1/messages', '/v1/messages/count_tokens'].map(path => ({
    body: '{"model":"m"}',
    expected: sentTo(`https://api.anthropic.com${path}`, 'anthropic-messages', '{"model":"m"}'),
    method: 'POST',
    profile: 'anthropic-messages' as const,
    url: `https://api.anthropic.com${path}`,
  })),
  ...[
    ['GET', '/v1/messages'],
    ['POST', '/v1/messages/batches'],
    ['GET', '/v1/models'],
    ['POST', '/v1/files'],
  ].map(([method = '', path = '']) => ({
    ...(method === 'POST' ? { body: '{}' } : {}),
    expected: 'refused' as const,
    method,
    profile: 'anthropic-messages' as const,
    url: `https://api.anthropic.com${path}`,
  })),
]

/**
 * Each case through a listener serving `served`, and what reached the
 * upstream. `pathForm` sends it as the plain listener takes it, with the host
 * as the path's first segment, where the TLS listener takes it by name.
 */
const reachedBy = async (
  served: readonly Broker.Grant[],
  cases: readonly Case[],
  pathForm: boolean,
): Promise<readonly Reached[]> =>
  auditing(() =>
    withSocketDir(async dir => {
      const reached: Array<{ body?: string; key: string; url: string }> = []
      const send = async (url: string, init: RequestInit): Promise<Response> => {
        const headers = new Headers(init.headers)
        const key =
          headers.get('x-api-key') === null
            ? `authorization: ${headers.get('authorization') ?? ''}`
            : `x-api-key: ${headers.get('x-api-key') ?? ''}`
        const body =
          init.body === undefined || init.body === null
            ? undefined
            : await new Response(init.body).text()
        reached.push({ ...(body === undefined || body === '' ? {} : { body }), key, url })
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
      }
      const credentials = new Map(Object.values(keys).map(each => [each.credential, each.value]))
      const server = pathForm
        ? Broker.serveRequests(join(dir, 'http.sock'), served, credentials, send)
        : Broker.serveTls(join(dir, 'tls.sock'), served, credentials, tlsIdentity(dir), [], send)
      try {
        const outcomes: Array<Reached> = []
        for (const each of cases) {
          const url = new URL(each.url)
          const target = pathForm
            ? `http://broker/${url.host}${url.pathname}${url.search}`
            : each.url
          const before = reached.length
          const response = await server.fetch(
            new Request(target, {
              method: each.method,
              ...(each.body === undefined ? {} : { body: each.body }),
            }),
          )
          await response.arrayBuffer()
          const sent = reached[before]
          outcomes.push(response.status >= 400 || sent === undefined ? 'refused' : sent)
        }
        return outcomes
      } finally {
        await server.stop(true)
      }
    }),
  )

describe('the shipped profiles, against what each serves', () => {
  it('runpod: every set chosen serves and refuses what the corpus expects', async () => {
    const reached = await reachedBy([shippedGrant('runpod', 'RUNPOD_API_KEY')], runpodCorpus, false)
    runpodCorpus.forEach((each, at) => {
      assert.deepStrictEqual(reached[at], each.expected, `${each.method} ${each.url}`)
    })
  })

  it('openrouter and anthropic-messages: each endpoint, and nothing else', async () => {
    const grantsOf = [
      shippedGrant('openrouter', 'OPENROUTER_KEY'),
      shippedGrant('anthropic-messages', 'ANTHROPIC_KEY'),
    ]
    const reached = await reachedBy(grantsOf, inferenceCorpus, false)
    inferenceCorpus.forEach((each, at) => {
      assert.deepStrictEqual(reached[at], each.expected, `${each.method} ${each.url}`)
    })
  })

  it('carries a model call’s query, which nothing needs and nothing was sent with before', async () => {
    const queried: Case = {
      body: '{}',
      expected: sentTo('https://openrouter.ai/api/v1/chat/completions?x=1', 'openrouter', '{}'),
      method: 'POST',
      url: 'https://openrouter.ai/api/v1/chat/completions?x=1',
    }
    const [reached] = await reachedBy(
      [shippedGrant('openrouter', 'OPENROUTER_KEY')],
      [queried],
      false,
    )
    assert.deepStrictEqual(reached, queried.expected)
  })
})

/** GitHub's profile, as igloo ships it, granted as `repos.read` and `repos.write` were. */
const githubGrant = (): Broker.ProfileGrant =>
  github({ 'You/Write': writes(), 'you/read': ['fetch', 'read'] })

/** The key as git sends it to GitHub: a token in the username slot git uses for one. */
const gitKey = `authorization: Basic ${btoa('x-access-token:gh-k')}`

const githubGit = 'https://github.com'
const githubApi = 'https://api.github.com'
const githubUploads = 'https://uploads.github.com'
const sentToGithub = (url: string, body?: string): Reached => sentTo(url, 'github', body)
const sentByGit = (url: string, body?: string): Reached => ({
  ...(body === undefined ? {} : { body }),
  key: gitKey,
  url,
})

/** A write through GitHub's API at each path its sets list, by each method there. */
const githubWrites: readonly (readonly [string, string])[] = [
  ['POST', 'actions/jobs/7/rerun'],
  ['POST', 'actions/runs/7/cancel'],
  ['POST', 'actions/runs/7/force-cancel'],
  ['POST', 'actions/runs/7/rerun'],
  ['POST', 'actions/runs/7/rerun-failed-jobs'],
  ['POST', 'actions/workflows/ci.yml/dispatches'],
  ['POST', 'check-runs'],
  ['PATCH', 'check-runs/7'],
  ['POST', 'check-runs/7/rerequest'],
  ['POST', 'check-suites'],
  ['POST', 'check-suites/7/rerequest'],
  ...['DELETE', 'PATCH', 'POST', 'PUT'].flatMap(method => [
    [method, 'issues'] as const,
    [method, 'issues/7/comments'] as const,
    [method, 'pulls/7/merge'] as const,
    [method, 'releases/7'] as const,
  ]),
  ['POST', 'pulls'],
  ['POST', 'statuses/abc123'],
]

/**
 * What `github` serves, and refuses, for a repository read (`you/read`) and
 * one written (`you/write`, granted as `You/Write`): git's four endpoints,
 * reads, every write its sets list, GraphQL, an upload, and what reaches past
 * a repository, the Codespace among it.
 */
const githubCorpus: readonly Case[] = [
  // git: a fetch of either, a push of the written one alone, each spelled as granted.
  {
    expected: sentByGit(`${githubGit}/you/read.git/info/refs?service=git-upload-pack`),
    method: 'GET',
    url: `${githubGit}/You/Read.git/info/refs?service=git-upload-pack`,
  },
  {
    body: '0000',
    expected: sentByGit(`${githubGit}/you/read.git/git-upload-pack`, '0000'),
    method: 'POST',
    url: `${githubGit}/you/read/git-upload-pack`,
  },
  {
    expected: sentByGit(`${githubGit}/You/Write.git/info/refs?service=git-receive-pack`),
    method: 'GET',
    url: `${githubGit}/you/write/info/refs?service=git-receive-pack`,
  },
  {
    body: '0000',
    expected: sentByGit(`${githubGit}/You/Write.git/git-receive-pack`, '0000'),
    method: 'POST',
    url: `${githubGit}/you/write.git/git-receive-pack`,
  },
  {
    body: '0000',
    expected: sentByGit(`${githubGit}/You/Write.git/git-upload-pack`, '0000'),
    method: 'POST',
    url: `${githubGit}/you/write/git-upload-pack`,
  },
  ...[
    ['GET', '/you/read/info/refs?service=git-receive-pack'],
    ['POST', '/you/read/git-receive-pack'],
    ['GET', '/other/repo/info/refs?service=git-upload-pack'],
    ['POST', '/other/repo/git-upload-pack'],
    ['GET', '/you/read/info/refs'],
    ['GET', '/you/read/info/refs?service=git-upload-archive'],
    ['POST', '/you/read/info/refs?service=git-upload-pack'],
    ['GET', '/you/read/git-upload-pack'],
    ['GET', '/you/read/sub/info/refs?service=git-upload-pack'],
    ['GET', '/you/info/refs?service=git-upload-pack'],
    ['GET', '/you/read'],
  ].map(([method = '', path = '']) => ({
    expected: 'refused' as const,
    method,
    url: `${githubGit}${path}`,
  })),

  // The API: its root, and reads under either repository, the query carried.
  { expected: sentToGithub(`${githubApi}/`), method: 'GET', url: `${githubApi}/` },
  { expected: sentToGithub(`${githubApi}/`), method: 'HEAD', url: `${githubApi}/` },
  {
    expected: sentToGithub(`${githubApi}/repos/you/read`),
    method: 'GET',
    url: `${githubApi}/repos/you/read`,
  },
  {
    expected: sentToGithub(`${githubApi}/repos/you/read/issues?state=open&labels=a+b`),
    method: 'GET',
    url: `${githubApi}/repos/YOU/read/issues?state=open&labels=a%20b`,
  },
  {
    expected: sentToGithub(`${githubApi}/repos/You/Write/pulls/7/files`),
    method: 'HEAD',
    url: `${githubApi}/repos/you/write/pulls/7/files`,
  },
  ...[
    ['GET', '/repos/other/repo'],
    ['GET', '/repos/you/read.git'],
    ['GET', '/repos/you'],
    ['GET', '/user'],
    ['GET', '/user/repos'],
    ['GET', '/orgs/you/repos'],
    ['OPTIONS', '/repos/you/read'],
    ['GET', '/graphql'],
  ].map(([method = '', path = '']) => ({
    expected: 'refused' as const,
    method,
    url: `${githubApi}${path}`,
  })),

  // GraphQL, unread.
  {
    body: '{"query":"mutation { x }"}',
    expected: sentToGithub(`${githubApi}/graphql`, '{"query":"mutation { x }"}'),
    method: 'POST',
    url: `${githubApi}/graphql`,
  },

  // Each write the sets list: made for the written repository, refused for the read one.
  ...githubWrites.flatMap(([method, path]) => [
    {
      body: '{}',
      expected: sentToGithub(`${githubApi}/repos/You/Write/${path}`, '{}'),
      method,
      url: `${githubApi}/repos/you/write/${path}`,
    },
    {
      body: '{}',
      expected: 'refused' as const,
      method,
      url: `${githubApi}/repos/you/read/${path}`,
    },
  ]),

  // What reaches past a repository, and a write nothing lists.
  ...[
    ['POST', '/repos/you/write/pulls/7/codespaces'],
    ['DELETE', '/repos/you/write/pulls/7/codespaces'],
    ['POST', '/repos/you/write/hooks'],
    ['PUT', '/repos/you/write/collaborators/someone'],
    ['POST', '/repos/you/write/keys'],
    ['PUT', '/repos/you/write/actions/secrets/TOKEN'],
    ['POST', '/repos/you/write/actions/runners/registration-token'],
    ['PATCH', '/repos/you/write'],
    ['DELETE', '/repos/you/write'],
    ['POST', '/repos/you/write/merges'],
    ['POST', '/repos/you/write/statuses'],
    ['POST', '/user/repos'],
  ].map(([method = '', path = '']) => ({
    body: '{}',
    expected: 'refused' as const,
    method,
    url: `${githubApi}${path}`,
  })),

  // An asset's upload, for the written repository alone.
  {
    body: 'asset',
    expected: sentToGithub(
      `${githubUploads}/repos/You/Write/releases/7/assets?name=a.txt&label=A+b`,
      'asset',
    ),
    method: 'POST',
    url: `${githubUploads}/repos/you/write/releases/7/assets?name=a.txt&label=A%20b`,
  },
  ...[
    ['POST', '/repos/you/read/releases/7/assets?name=a.txt'],
    ['PUT', '/repos/you/write/releases/7/assets?name=a.txt'],
    ['POST', '/repos/you/write/releases/7/assets/a.txt'],
    ['POST', '/repos/you/write/releases'],
    ['GET', '/repos/you/write/releases/7/assets'],
  ].map(([method = '', path = '']) => ({
    body: 'asset',
    expected: 'refused' as const,
    method,
    url: `${githubUploads}${path}`,
  })),
]

/**
 * One request through a TLS listener serving `served`, to an upstream that
 * answers `answer`: what the guest got back, and the headers the upstream
 * was sent.
 */
const answeredBy = (
  served: readonly Broker.Grant[],
  request: Request,
  answer: () => Response,
): Promise<{ readonly response: Response; readonly sent: Headers | undefined }> =>
  auditing(() =>
    withSocketDir(async dir => {
      let sent: Headers | undefined
      const send = async (_url: string, init: RequestInit): Promise<Response> => {
        sent = new Headers(init.headers)
        if (init.body !== undefined && init.body !== null) await new Response(init.body).text()
        return answer()
      }
      const server = Broker.serveTls(
        join(dir, 'tls.sock'),
        served,
        new Map([['GITHUB_TOKEN', 'gh-k']]),
        tlsIdentity(dir),
        [],
        send,
      )
      try {
        const response = await server.fetch(request)
        await response.clone().arrayBuffer()
        return { response, sent }
      } finally {
        await server.stop(true)
      }
    }),
  )

/** The headers of `headers` named in `names`, as one record, for comparing two answers. */
const picked = (headers: Headers | undefined, names: readonly string[]) =>
  Object.fromEntries(names.map(name => [name, headers?.get(name) ?? null]))

/**
 * Each check of what the shipped `github` does, run against `served`: the
 * corpus, then git's headers, a page link, a returned redirect, a kept
 * upload length, and a 401. Each is what came of it, what should have, and
 * what it was.
 */
const githubChecks = async (
  served: readonly Broker.Grant[],
): Promise<readonly (readonly [unknown, unknown, string])[]> => {
  const checks: Array<readonly [unknown, unknown, string]> = []
  const check = (actual: unknown, expected: unknown, what = ''): void => {
    checks.push([actual, expected, what])
  }
  const reached = await reachedBy(served, githubCorpus, false)
  githubCorpus.forEach((each, at) => {
    check(reached[at], each.expected, `${each.method} ${each.url}`)
  })

  const fetched = await answeredBy(
    served,
    new Request(`${githubGit}/you/read/git-upload-pack`, {
      body: '0000',
      headers: {
        'Content-Encoding': 'gzip',
        Cookie: 'a=b',
        'Git-Protocol': 'version=2',
        'X-Forwarded-Host': 'elsewhere.example',
      },
      method: 'POST',
    }),
    () =>
      new Response('pack', {
        headers: {
          'Content-Type': 'application/x-git-upload-pack-result',
          'Set-Cookie': 'a=b',
          'X-Other': '1',
        },
      }),
  )
  check(
    [...(fetched.sent ?? new Headers())],
    [
      ['accept', 'application/x-git-upload-pack-result'],
      ['accept-encoding', 'identity'],
      ['authorization', `Basic ${btoa('x-access-token:gh-k')}`],
      ['content-encoding', 'gzip'],
      ['content-type', 'application/x-git-upload-pack-request'],
      ['git-protocol', 'version=2'],
      ['user-agent', 'igloo-broker'],
    ],
  )
  check(
    [...fetched.response.headers],
    [
      ['cache-control', 'no-cache, max-age=0, must-revalidate'],
      ['content-type', 'application/x-git-upload-pack-result'],
    ],
  )

  const paged = await answeredBy(
    served,
    new Request(`${githubApi}/repos/you/write/issues?per_page=2`),
    () =>
      new Response('[]', {
        headers: {
          Link: '<https://api.github.com/repositories/42/issues?per_page=2&page=2>; rel="next", <https://api.github.com/repositories/42/issues?per_page=2&page=5>; rel="last"',
        },
      }),
  )
  check(
    paged.response.headers.get('link'),
    '<https://api.github.com/repos/You/Write/issues?per_page=2&page=2>; rel="next", <https://api.github.com/repos/You/Write/issues?per_page=2&page=5>; rel="last"',
  )

  const redirected = await answeredBy(
    served,
    new Request(`${githubApi}/repos/you/read/actions/runs/7/logs`),
    () =>
      new Response(null, {
        headers: { Location: 'https://results.example.net/logs?sig=x' },
        status: 302,
      }),
  )
  check(redirected.response.status, 302)
  check(redirected.response.headers.get('location'), 'https://results.example.net/logs?sig=x')

  const uploaded = await answeredBy(
    served,
    new Request(`${githubUploads}/repos/you/write/releases/7/assets?name=a.txt`, {
      body: 'asset',
      headers: { 'Content-Length': '5', 'Content-Type': 'text/plain' },
      method: 'POST',
    }),
    () => new Response('{}', { status: 201 }),
  )
  check(uploaded.response.status, 201)
  check(picked(uploaded.sent, ['content-length', 'content-type']), {
    'content-length': '5',
    'content-type': 'text/plain',
  })

  for (const [request, status] of [
    [new Request(`${githubGit}/you/read/info/refs?service=git-upload-pack`), 502],
    [new Request(`${githubApi}/repos/you/read`), 403],
  ] as const) {
    const refused = await answeredBy(served, request, () => new Response('', { status: 401 }))
    check(refused.response.status, status, request.url)
    check((await refused.response.text()).includes('refused GITHUB_TOKEN'), true, request.url)
  }
  const pushRefused = await answeredBy(
    served,
    new Request(`${githubGit}/you/read/info/refs?service=git-receive-pack`),
    () => new Response(''),
  )
  check(pushRefused.response.status, 403)
  check(pushRefused.response.headers.get('content-type'), 'text/plain; charset=utf-8')
  return checks
}

describe('the shipped github profile, against what github’s code served', () => {
  it('serves and refuses what the corpus expects, through the shipped profile', async () => {
    for (const [actual, expected, what] of await githubChecks([githubGrant()])) {
      assert.deepStrictEqual(actual, expected, what)
    }
  })

  it('carries the API root’s query, which the code dropped', async () => {
    const [reached] = await reachedBy(
      [githubGrant()],
      [{ expected: 'refused', method: 'GET', url: `${githubApi}/?per_page=1` }],
      false,
    )
    assert.deepStrictEqual(reached, sentToGithub(`${githubApi}/?per_page=1`))
  })
})
