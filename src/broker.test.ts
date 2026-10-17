import { assert, describe, it, vi } from '@effect/vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as connectTls } from 'node:tls'

import * as Broker from './broker.ts'

const grants: readonly Broker.Grant[] = [
  { credential: 'GITHUB_TOKEN', profile: 'github', repos: ['you/api'] },
]

const base = 'http://127.0.0.1:3128'

const advertise = (path: string, query = '?service=git-upload-pack') =>
  Broker.decide(grants, 'GET', `${base}${path}${query}`)

const fetchPack = (path: string) => Broker.decide(grants, 'POST', `${base}${path}`)

/** The status of a decision, or `'allow'` — enough to assert without a cast. */
const outcome = (decision: Broker.Decision): number | string =>
  decision._tag === 'Deny' ? decision.status : 'allow'

describe('Broker.decide, on what it permits', () => {
  it('allows the ref advertisement for a granted repository', () => {
    const decision = advertise('/github.com/you/api/info/refs')
    assert.strictEqual(decision._tag, 'Git')
    assert.deepStrictEqual(decision, {
      _tag: 'Git',
      credential: 'GITHUB_TOKEN',
      host: 'github.com',
      operation: 'ls-refs',
      profile: 'github',
      repo: 'you/api',
      upstream: 'https://github.com/you/api.git/info/refs?service=git-upload-pack',
    })
  })

  it('allows the fetch that follows it', () => {
    const decision = fetchPack('/github.com/you/api/git-upload-pack')
    assert.strictEqual(decision._tag, 'Git')
    assert.strictEqual(
      decision._tag === 'Git' ? decision.upstream : '',
      'https://github.com/you/api.git/git-upload-pack',
    )
  })

  it('treats a `.git` suffix as the same repository, in the request and in the grant', () => {
    // git keeps whatever the remote URL said, and a person writes it either way.
    assert.strictEqual(outcome(advertise('/github.com/you/api.git/info/refs')), 'allow')
    assert.strictEqual(
      outcome(
        Broker.decide(
          [{ credential: 'T', profile: 'github', repos: ['you/api.git'] }],
          'GET',
          `${base}/github.com/you/api/info/refs?service=git-upload-pack`,
        ),
      ),
      'allow',
    )
  })

  it('matches the repository case-insensitively, as the upstream does', () => {
    assert.strictEqual(outcome(advertise('/github.com/YOU/API/info/refs')), 'allow')
  })

  it('sends the grant’s spelling upstream, never the request’s', () => {
    // The request decides which grant applies and nothing else. A repository
    // name that reached the upstream URL would be a path this broker never
    // authorized, however carefully the rest of it was checked.
    const decision = Broker.decide(
      [{ credential: 'T', profile: 'github', repos: ['You/Api'] }],
      'GET',
      `${base}/github.com/you/api/info/refs?service=git-upload-pack`,
    )
    assert.strictEqual(
      decision._tag === 'Git' ? decision.upstream : '',
      'https://github.com/You/Api.git/info/refs?service=git-upload-pack',
    )
  })
})

describe('Broker.decide, on what it refuses', () => {
  it('refuses everything when no grant is configured', () => {
    // A 403 rather than a 5xx, which most model clients retry for minutes.
    assert.strictEqual(
      outcome(Broker.decide([], 'GET', `${base}/github.com/you/api/info/refs`)),
      403,
    )
  })

  it('refuses a repository the grant does not name', () => {
    assert.strictEqual(outcome(advertise('/github.com/you/other/info/refs')), 403)
  })

  it('refuses a host no grant covers', () => {
    assert.strictEqual(outcome(advertise('/gitlab.com/you/api/info/refs')), 403)
  })

  it('names what a refused request asked for, where its reason repeats it', () => {
    const asked = (decision: Broker.Decision) =>
      decision._tag === 'Deny' ? decision.asked : decision._tag
    assert.deepStrictEqual(asked(advertise('/github.com/you/other/info/refs')), {
      scope: 'you/other',
    })
    assert.deepStrictEqual(asked(advertise('/gitlab.com/you/api/info/refs')), {
      host: 'gitlab.com',
    })
    // A reason that repeats nothing of the request's has nothing to add.
    assert.isUndefined(asked(advertise('/github.com/you/api/info/refs', '')))
  })

  it('refuses a push at both endpoints that request one', () => {
    // The advertisement is where git asks whether it may push at all, so
    // refusing only the second one would let a push start and fail late.
    assert.strictEqual(
      outcome(advertise('/github.com/you/api/info/refs', '?service=git-receive-pack')),
      403,
    )
    assert.strictEqual(outcome(fetchPack('/github.com/you/api/git-receive-pack')), 403)
  })

  it('refuses an advertisement with no service, rather than guessing one', () => {
    assert.strictEqual(outcome(advertise('/github.com/you/api/info/refs', '')), 404)
  })

  it('refuses a path with more or fewer parts than host, owner and repository', () => {
    // This is what makes traversal unreachable: there is one shape, and
    // `/github.com/you/api/../../x/info/refs` is not it.
    assert.strictEqual(outcome(advertise('/github.com/you/api/extra/info/refs')), 404)
    assert.strictEqual(outcome(advertise('/github.com/api/info/refs')), 404)
    assert.strictEqual(outcome(advertise('/github.com/you/api/../../x/info/refs')), 404)
  })

  it('refuses percent-encoding rather than deciding what it meant', () => {
    assert.strictEqual(outcome(advertise('/github.com/you/%61pi/info/refs')), 400)
    assert.strictEqual(outcome(advertise('/github.com/you/api%2f../info/refs')), 400)
  })

  it('refuses an empty path segment', () => {
    assert.strictEqual(outcome(advertise('/github.com//you/api/info/refs')), 404)
  })

  it('refuses the right method on the wrong endpoint', () => {
    assert.strictEqual(
      outcome(
        Broker.decide(
          grants,
          'POST',
          `${base}/github.com/you/api/info/refs?service=git-upload-pack`,
        ),
      ),
      405,
    )
    assert.strictEqual(
      outcome(Broker.decide(grants, 'GET', `${base}/github.com/you/api/git-upload-pack`)),
      405,
    )
  })

  it('refuses anything that is not a git fetch endpoint', () => {
    // github.com serves git and nothing else: the token would authenticate a
    // request for anything there perfectly well, which is the reason the
    // allowlist is of operations and not of hosts.
    assert.strictEqual(outcome(advertise('/github.com/you/api/pulls')), 404)
    assert.strictEqual(outcome(advertise('/github.com/user/keys')), 404)
  })

  it('refuses an unparseable target', () => {
    assert.strictEqual(outcome(Broker.decide(grants, 'GET', 'http://[')), 400)
  })

  it('decides a bare path the same way as a full URL', () => {
    // A request target is not always a URL. A client sending no `Host` — which
    // is every HTTP/1.0 client — leaves the server reporting the path alone, and
    // a broker that answered 400 to those would be refusing on the shape of the
    // request line rather than on its grants.
    assert.strictEqual(
      outcome(
        Broker.decide(grants, 'GET', '/github.com/you/api/info/refs?service=git-upload-pack'),
      ),
      'allow',
    )
    assert.strictEqual(
      outcome(
        Broker.decide(grants, 'GET', '/github.com/you/api/info/refs?service=git-receive-pack'),
      ),
      403,
    )
  })

  it('cannot be pointed at another authority by the request target', () => {
    // A protocol-relative target resolves to an authority of the guest's
    // choosing. Refused on the path, and inert besides: the upstream is built
    // from the grant, so the authority in a request is never read.
    assert.strictEqual(outcome(Broker.decide(grants, 'GET', '//evil.example/x/info/refs')), 404)
    assert.strictEqual(outcome(advertise('//evil.example/github.com/you/api/info/refs')), 404)
    assert.strictEqual(
      outcome(
        Broker.decide(
          grants,
          'GET',
          'http://evil.example/github.com/you/api/info/refs?service=git-upload-pack',
        ),
      ),
      'allow',
    )
  })
})

describe('Broker.tlsNames', () => {
  it('answers each git grant’s host, once, and is covered by the certificate', () => {
    const twice: readonly Broker.Grant[] = [
      ...grants,
      { credential: 'OTHER', profile: 'github', repos: ['you/web'] },
    ]
    assert.deepStrictEqual(Broker.tlsNames(twice), ['github.com', 'api.github.com'])
    for (const name of Broker.tlsNames(twice)) assert.include(Broker.tlsNamesCovered, name)
  })

  it('answers nothing for a grant that is not a git one', () => {
    assert.deepStrictEqual(Broker.tlsNames([...inference, ...servers]), [])
  })
})

describe('Broker.decideAddressed', () => {
  const addressed = (url: string, method = 'GET', granted = grants) =>
    Broker.decideAddressed(granted, method, url)

  it('decides a request addressed to a name it answers as the path form naming it', () => {
    const decided = addressed('https://github.com/you/api/info/refs?service=git-upload-pack')
    assert.deepStrictEqual(decided, advertise('/github.com/you/api/info/refs'))
    assert.strictEqual(decided._tag, 'Git')
    assert.deepStrictEqual(
      addressed('https://github.com/you/api.git/git-upload-pack', 'POST'),
      fetchPack('/github.com/you/api.git/git-upload-pack'),
    )
  })

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
  })
})

describe('Broker.decide, on GitHub’s API', () => {
  const api = (path: string, method = 'GET', granted = grants) =>
    Broker.decide(granted, method, `${base}/api.github.com${path}`)

  it('reads under a repository the grant lists, with its credential', () => {
    assert.deepStrictEqual(api('/repos/you/api/actions/runs?per_page=100&status=failure'), {
      _tag: 'Api',
      credential: 'GITHUB_TOKEN',
      host: 'api.github.com',
      operation: 'read',
      profile: 'github',
      repo: 'you/api',
      upstream: 'https://api.github.com/repos/you/api/actions/runs?per_page=100&status=failure',
    })
    assert.strictEqual(outcome(api('/repos/you/api', 'HEAD')), 'allow')
    assert.strictEqual(outcome(api('/repos/You/API/releases/latest')), 'allow')
  })

  it('sends the grant’s spelling upstream, and the query encoded', () => {
    const spelled: readonly Broker.Grant[] = [
      { credential: 'T', profile: 'github', repos: ['Owner/Repo.git'] },
    ]
    const decided = api('/repos/owner/repo/issues?q=a b&labels=x,y', 'GET', spelled)
    assert.strictEqual(
      decided._tag === 'Api' ? decided.upstream : '',
      'https://api.github.com/repos/Owner/Repo/issues?q=a+b&labels=x%2Cy',
    )
  })

  it('cannot leave the repository by its path', () => {
    // The URL parser resolves `..` before anything is matched, an escaped one
    // too, so each of these asks for a repository the grant does not list.
    const left = api('/repos/you/api/../other/issues')
    assert.strictEqual(left._tag === 'Deny' ? left.asked?.scope : '', 'you/other')
    const escaped = api('/repos/you/api/%2e%2e/%2e%2e/someone/else')
    assert.strictEqual(escaped._tag === 'Deny' ? escaped.asked?.scope : '', 'someone/else')
  })

  it('refuses another repository, naming it', () => {
    const refused = api('/repos/someone/else/actions/runs')
    assert.deepStrictEqual(refused, {
      _tag: 'Deny',
      asked: { scope: 'someone/else' },
      reason: 'someone/else is not a repository this VM may read',
      status: 403,
    })
  })

  it('refuses what lies outside the repositories, gists and new repositories among it', () => {
    for (const path of [
      '/gists',
      '/user/repos',
      '/search/issues?q=repo:someone/else',
      '/repositories/212613049/issues',
      '/orgs/someone/repos',
    ]) {
      assert.strictEqual(outcome(api(path)), 403, path)
    }
    assert.strictEqual(outcome(api('/repos/you')), 404)
  })

  it('reads the API’s root with its credential, which is where a token’s scopes are given', () => {
    const root = {
      _tag: 'Api',
      credential: 'GITHUB_TOKEN',
      host: 'api.github.com',
      operation: 'read',
      profile: 'github',
      upstream: 'https://api.github.com/',
    } as const
    assert.deepStrictEqual(api('/'), root)
    assert.deepStrictEqual(api(''), root)
    assert.deepStrictEqual(api('/?x=1', 'HEAD'), root)
    assert.strictEqual(outcome(api('/', 'POST')), 403)
  })

  it('takes an empty segment as the root only where it ends a host alone', () => {
    for (const path of ['//', '/repos/you/api/', '/repos//api']) {
      assert.strictEqual(outcome(api(path)), 404, path)
    }
    assert.strictEqual(outcome(Broker.decide(grants, 'GET', `${base}/github.com/`)), 404)
  })

  it('refuses a write, whatever it is for', () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      assert.strictEqual(outcome(api('/repos/you/api/issues', method)), 403, method)
    }
    assert.strictEqual(outcome(api('/gists', 'POST')), 403)
  })

  it('sends a GraphQL query with its credential, naming no repository', () => {
    // Its body names what it reads, which the broker does not read.
    const query = {
      _tag: 'Api',
      credential: 'GITHUB_TOKEN',
      host: 'api.github.com',
      operation: 'graphql',
      profile: 'github',
      upstream: 'https://api.github.com/graphql',
    } as const
    assert.deepStrictEqual(api('/graphql', 'POST'), query)
    assert.deepStrictEqual(api('/graphql?owner=someone', 'POST'), query)
  })

  it('takes a GraphQL query at /graphql alone, and by POST alone', () => {
    for (const method of ['GET', 'HEAD', 'PUT']) {
      assert.strictEqual(outcome(api('/graphql', method)), 405, method)
    }
    for (const path of ['/graphql/x', '/api/graphql', '/repos/you/api/graphql']) {
      assert.strictEqual(outcome(api(path, 'POST')), 403, path)
    }
  })

  it('is not served without a github grant', () => {
    assert.strictEqual(outcome(api('/repos/you/api', 'GET', inference)), 404)
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
      'Git',
    )
  })

  it('refuses it when the tunnel does not reach the name', () => {
    for (const reach of [[], ['example.com'], ['github.com.example']] as const) {
      const decided = read(
        'https://github.com/someone/else/info/refs?service=git-upload-pack',
        'GET',
        reach,
      )
      assert.deepStrictEqual(
        decided,
        Broker.decide(grants, 'GET', '/github.com/someone/else/info/refs?service=git-upload-pack'),
      )
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
    assert.strictEqual(read('https://api.github.com/repos/you/api/releases/latest')._tag, 'Api')
    assert.strictEqual(read('https://api.github.com/gists', 'POST', 'any')._tag, 'Deny')
  })

  it('sends a GraphQL query with the grant’s credential, and none on github.com', () => {
    const query = read('https://api.github.com/graphql', 'POST', [])
    assert.strictEqual(query._tag === 'Api' ? query.operation : '', 'graphql')
    assert.strictEqual(read('https://github.com/graphql', 'POST', 'any')._tag, 'Deny')
  })

  it('reads the API’s root with the grant’s credential, reached or not', () => {
    const root = read('https://api.github.com/', 'GET', [])
    assert.strictEqual(root._tag === 'Api' ? root.upstream : '', 'https://api.github.com/')
    assert.strictEqual(read('https://github.com/', 'GET', 'any')._tag, 'Anonymous')
  })

  it('answers no other name, reached or not', () => {
    assert.strictEqual(outcome(read('https://example.com/', 'GET', 'any')), 421)
  })
})

describe('Broker.upstreamHeaders', () => {
  const allowed = {
    _tag: 'Git',
    credential: 'GITHUB_TOKEN',
    host: 'github.com',
    operation: 'ls-refs',
    profile: 'github',
    repo: 'you/api',
    upstream: 'https://github.com/you/api.git/info/refs?service=git-upload-pack',
  } as const

  const headersFor = (operation: Broker.GitOperation, guest: Record<string, string>) =>
    Broker.upstreamHeaders({ ...allowed, operation }, 'ghp_secret', new Headers(guest))

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
})

describe('Broker.relay', () => {
  const allowed = {
    credential: 'GITHUB_TOKEN',
    host: 'github.com',
    kind: 'Git',
    scope: 'you/api',
  } as const

  it('does not pass a 401 back as a 401', () => {
    // Measured against real git: a 401 makes it prompt for a username inside the
    // guest, for a credential the guest does not have and must not be given.
    // Dropping `WWW-Authenticate` does not prevent it — the status is the
    // trigger — so the broker reports its own credential being refused instead.
    const refused = Broker.relay(allowed, 401)
    assert.strictEqual(refused?.status, 502)
    assert.include(refused?.reason ?? '', 'GITHUB_TOKEN')
  })

  it('answers a model call’s refused credential with a 403, which a client does not retry', () => {
    // Measured: every harness retries a 502 as an outage, omp for over six
    // minutes, and every one stops at a 403 and shows the reason.
    const refused = Broker.relay(
      {
        credential: 'ANTHROPIC_API_KEY',
        host: 'api.anthropic.com',
        kind: 'Inference',
        scope: 'claude-opus-5',
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

  it('passes an API read’s redirect back, and answers its refused credential with a final 403', () => {
    const read = {
      credential: 'GITHUB_TOKEN',
      host: 'api.github.com',
      kind: 'Api',
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
      host: 'github.com',
      kind: 'Anonymous',
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

const inference: readonly Broker.Grant[] = [
  { credential: 'ANTHROPIC_API_KEY', profile: 'anthropic-messages' },
  { credential: 'OPENROUTER_API_KEY', profile: 'openrouter' },
]

/** A `POST` to a brokered provider path, as a provider's own client builds it. */
const call = (path: string, method = 'POST') => Broker.decide(inference, method, `${base}${path}`)

describe('Broker.decide, on an inference request', () => {
  it('routes the endpoints each profile serves', () => {
    const decision = call('/api.anthropic.com/v1/messages')
    assert.strictEqual(decision._tag, 'Inference')
    assert.deepStrictEqual(
      decision._tag === 'Inference'
        ? { operation: decision.operation, upstream: decision.upstream }
        : {},
      { operation: 'messages', upstream: 'https://api.anthropic.com/v1/messages' },
    )
    assert.strictEqual(outcome(call('/api.anthropic.com/v1/messages/count_tokens')), 'allow')
    assert.strictEqual(outcome(call('/openrouter.ai/api/v1/chat/completions')), 'allow')
  })

  it('decides which grant pays from the host the path names', () => {
    const credential = (decision: Broker.Decision) =>
      decision._tag === 'Inference' ? decision.credential : undefined
    assert.strictEqual(credential(call('/api.anthropic.com/v1/messages')), 'ANTHROPIC_API_KEY')
    assert.strictEqual(
      credential(call('/openrouter.ai/api/v1/chat/completions')),
      'OPENROUTER_API_KEY',
    )
  })

  it('refuses every other endpoint the same credential would open', () => {
    // A model grant is not a provider grant: the same key lists batches,
    // uploads files and reads the organisation, and none of those is a model
    // call. The allowlist is of endpoints for that reason.
    for (const path of [
      '/api.anthropic.com/v1/messages/batches',
      '/api.anthropic.com/v1/models',
      '/api.anthropic.com/v1/files',
      '/openrouter.ai/api/v1/credits',
      '/openrouter.ai/api/v1/chat',
    ]) {
      assert.strictEqual(outcome(call(path)), 404)
    }
  })

  it('serves OpenRouter’s model listings, read with GET', () => {
    // What omp reads at startup: the catalog of each kind of model.
    for (const path of [
      '/openrouter.ai/api/v1/models',
      '/openrouter.ai/api/v1/images/models',
      '/openrouter.ai/api/v1/videos/models',
      '/openrouter.ai/api/v1/embeddings/models',
    ]) {
      const decision = call(path, 'GET')
      assert.deepStrictEqual(
        decision._tag === 'Inference' ? [decision.operation, decision.upstream] : [],
        ['list-models', `https://openrouter.ai${path.slice('/openrouter.ai'.length)}`],
      )
      assert.strictEqual(outcome(call(path, 'POST')), 405)
    }
  })

  it('serves OpenRouter’s Responses and Messages endpoints, and nothing beneath either', () => {
    for (const [path, operation] of [
      ['/openrouter.ai/api/v1/responses', 'responses'],
      ['/openrouter.ai/api/v1/messages', 'messages'],
    ] as const) {
      const decision = call(path)
      assert.deepStrictEqual(
        decision._tag === 'Inference'
          ? [decision.operation, decision.upstream, decision.credential]
          : [],
        [
          operation,
          `https://openrouter.ai${path.slice('/openrouter.ai'.length)}`,
          'OPENROUTER_API_KEY',
        ],
      )
      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
        assert.strictEqual(outcome(call(path, method)), 405, `${method} ${path}`)
      }
    }
    // What OpenAI serves beside a model call, to read, cancel or delete a
    // response it stored, and Anthropic's token count, which OpenRouter does
    // not have.
    for (const [path, method] of [
      ['/openrouter.ai/api/v1/responses/resp_1', 'GET'],
      ['/openrouter.ai/api/v1/responses/resp_1', 'DELETE'],
      ['/openrouter.ai/api/v1/responses/resp_1/cancel', 'POST'],
      ['/openrouter.ai/api/v1/responses/resp_1/input_items', 'GET'],
      ['/openrouter.ai/api/v1/responses/compact', 'POST'],
      ['/openrouter.ai/api/v1/messages/count_tokens', 'POST'],
      ['/openrouter.ai/api/v1/messages/batches', 'POST'],
    ] as const) {
      assert.strictEqual(outcome(call(path, method)), 404, `${method} ${path}`)
    }
  })

  it('carries a listing’s filter, encoded, and no other endpoint’s query', () => {
    const listed = call('/openrouter.ai/api/v1/models?output_modalities=rerank&q=a b/../c#x', 'GET')
    assert.strictEqual(
      listed._tag === 'Inference' ? listed.upstream : '',
      'https://openrouter.ai/api/v1/models?output_modalities=rerank&q=a+b%2F..%2Fc',
    )
    const chat = call('/openrouter.ai/api/v1/chat/completions?model=elsewhere')
    assert.strictEqual(
      chat._tag === 'Inference' ? chat.upstream : '',
      'https://openrouter.ai/api/v1/chat/completions',
    )
  })

  it('refuses a host no grant covers, and the wrong method on one that is', () => {
    assert.strictEqual(outcome(call('/api.openai.com/v1/chat/completions')), 404)
    assert.strictEqual(outcome(call('/api.anthropic.com/v1/messages', 'GET')), 405)
  })

  it('keeps every git refusal when both kinds of grant are held', () => {
    // Both profiles in one broker: a git path must still be judged as a git
    // path, rather than falling through to "no such inference endpoint".
    const both = [...grants, ...inference]
    assert.strictEqual(
      outcome(Broker.decide(both, 'GET', `${base}/github.com/you/api/info/refs`)),
      404,
    )
    assert.strictEqual(
      outcome(Broker.decide(both, 'POST', `${base}/github.com/you/api/git-receive-pack`)),
      403,
    )
    assert.strictEqual(
      outcome(Broker.decide(both, 'POST', `${base}/api.anthropic.com/v1/messages`)),
      'allow',
    )
  })
})

describe('Broker.upstreamHeaders, for an inference request', () => {
  const decision = call('/api.anthropic.com/v1/messages')
  const openrouter = call('/openrouter.ai/api/v1/chat/completions')
  const listing = call('/openrouter.ai/api/v1/models', 'GET')

  const headersFor = (routed: Broker.Decision, guest: Record<string, string> = {}) =>
    routed._tag === 'Inference'
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
      [...Broker.responseHeaders('Inference', upstream())],
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
      [...Broker.responseHeaders('Git', upstream())],
      [
        ['cache-control', 'no-cache, max-age=0, must-revalidate'],
        ['content-type', 'text/event-stream'],
      ],
    )
  })
})

describe('Broker.guestEnvironment', () => {
  it('points each provider’s client at the broker, with a placeholder for a key', () => {
    assert.deepStrictEqual(Broker.guestEnvironment(inference, 3128), {
      ANTHROPIC_API_KEY: Broker.guestPlaceholderKey,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:3128/api.anthropic.com',
      OPENCODE_CONFIG: '/etc/igloo/opencode.json',
      OPENROUTER_API_KEY: Broker.guestPlaceholderKey,
      OPENROUTER_BASE_URL: 'http://127.0.0.1:3128/openrouter.ai/api/v1',
    })
  })

  it('holds no value a session variable cannot carry', () => {
    // NixOS writes these inside double quotes, unescaped: a JSON value here
    // reached the guest with its quotes stripped, and opencode refused to start.
    for (const [name, value] of Object.entries(Broker.guestEnvironment(inference, 3128))) {
      assert.notMatch(value, /["\\]/, name)
    }
  })

  it('gives opencode its base URLs in the file that variable names', () => {
    // opencode reads neither base URL variable, only its own configuration;
    // its Anthropic client takes a base ending in `v1`.
    const files = Broker.guestEtcFiles(inference, 3128)
    assert.deepStrictEqual(Object.keys(files), ['igloo/opencode.json'])
    assert.deepStrictEqual(JSON.parse(files['igloo/opencode.json'] ?? '{}'), {
      provider: {
        anthropic: { options: { baseURL: 'http://127.0.0.1:3128/api.anthropic.com/v1' } },
        openrouter: { options: { baseURL: 'http://127.0.0.1:3128/openrouter.ai/api/v1' } },
      },
    })
  })

  it('configures only the providers a grant covers', () => {
    const openrouterOnly = [{ credential: 'OPENROUTER_API_KEY', profile: 'openrouter' }] as const
    assert.notProperty(Broker.guestEnvironment(openrouterOnly, 3128), 'ANTHROPIC_BASE_URL')
    assert.deepStrictEqual(
      Object.keys(
        JSON.parse(Broker.guestEtcFiles(openrouterOnly, 3128)['igloo/opencode.json'] ?? '{}')
          .provider,
      ),
      ['openrouter'],
    )
  })

  it('gives a github grant only the token GitHub’s CLI needs before it asks for anything', () => {
    assert.deepStrictEqual(Broker.guestEnvironment(grants, 3128), {
      GH_TOKEN: Broker.guestPlaceholderKey,
    })
    assert.deepStrictEqual(Broker.guestEtcFiles(grants, 3128), {})
    assert.deepStrictEqual(Broker.guestClientFiles(grants, 3128), [])
  })

  it('builds a base URL the profile’s own endpoints hang off', () => {
    // The two halves have to meet: a client appends its endpoint to this, and
    // the result has to be a path `decide` routes.
    const environment = Broker.guestEnvironment(inference, 3128)
    for (const [baseUrl, endpoint] of [
      [environment['ANTHROPIC_BASE_URL'], 'v1/messages'],
      [environment['OPENROUTER_BASE_URL'], 'chat/completions'],
    ]) {
      assert.strictEqual(
        outcome(Broker.decide(inference, 'POST', `${String(baseUrl)}/${String(endpoint)}`)),
        'allow',
      )
    }
  })
})

describe('Broker.guestClientFiles', () => {
  it('names the broker as each provider’s base, in pi’s and omp’s own files', () => {
    const files = Broker.guestClientFiles(inference, 3128)
    assert.deepStrictEqual(
      files.map(({ path, program }) => [program, path]),
      [
        ['pi', '.pi/agent/models.json'],
        ['omp', '.omp/agent/models.yml'],
      ],
    )
    for (const file of files) {
      // omp reads it as YAML, which JSON is.
      assert.deepStrictEqual(JSON.parse(file.content), {
        providers: {
          anthropic: { baseUrl: 'http://127.0.0.1:3128/api.anthropic.com' },
          openrouter: { baseUrl: 'http://127.0.0.1:3128/openrouter.ai/api/v1' },
        },
      })
    }
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
    // loading and tools; and the model calls no harness here makes.
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
      'v1/embeddings',
      'v1/messages',
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
        Broker.decide(held, 'GET', `${base}/github.com/you/api/info/refs?service=git-upload-pack`),
      ),
      'allow',
    )
    assert.strictEqual(
      outcome(Broker.decide(held, 'POST', `${base}/openrouter.ai/api/v1/chat/completions`)),
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
})

describe('Broker.relay, for a model server', () => {
  it('answers a server that wants a key it was not given with a final 403 saying so', () => {
    const refused = Broker.relay(
      { credential: undefined, host: '127.0.0.1:8080', kind: 'ModelServer', scope: undefined },
      401,
    )
    assert.strictEqual(refused?.status, 403)
    assert.include(refused?.reason, '127.0.0.1:8080 wants a credential')
  })

  it('answers a refused key as it does a provider’s', () => {
    const refused = Broker.relay(
      {
        credential: 'model-server.ollama',
        host: '127.0.0.1:11434',
        kind: 'ModelServer',
        scope: undefined,
      },
      401,
    )
    assert.strictEqual(refused?.status, 403)
    assert.include(refused?.reason, 'refused model-server.ollama')
  })

  it('follows no redirect', () => {
    const redirected = Broker.relay(
      { credential: undefined, host: '127.0.0.1:8080', kind: 'ModelServer', scope: undefined },
      307,
    )
    assert.strictEqual(redirected?.status, 502)
  })
})

describe('Broker.guestEnvironment, for a model server', () => {
  it('points omp at the one server there is, and opencode at nothing', () => {
    const only = servers.slice(0, 1)
    assert.deepStrictEqual(Broker.guestEnvironment(only, 3128), {
      LLAMA_CPP_BASE_URL: 'http://127.0.0.1:3128/local/llama-swap/v1',
    })
    assert.deepStrictEqual(Broker.guestEtcFiles(only, 3128), {})
    assert.deepStrictEqual(Broker.guestClientFiles(only, 3128), [])
  })

  it('chooses none of several servers for omp', () => {
    assert.notProperty(Broker.guestEnvironment(servers, 3128), 'LLAMA_CPP_BASE_URL')
  })

  it('keeps the providers’ variables beside it', () => {
    const environment = Broker.guestEnvironment([...inference, ...servers.slice(0, 1)], 3128)
    assert.strictEqual(
      environment['OPENROUTER_BASE_URL'],
      'http://127.0.0.1:3128/openrouter.ai/api/v1',
    )
    assert.strictEqual(
      environment['LLAMA_CPP_BASE_URL'],
      'http://127.0.0.1:3128/local/llama-swap/v1',
    )
  })

  it('builds a base each endpoint hangs off', () => {
    // An OpenAI-shaped client appends these to its base; each has to be a path
    // `decide` routes.
    const baseUrl = Broker.modelServerBase('llama-swap', 3128)
    for (const [endpoint, method] of [
      ['chat/completions', 'POST'],
      ['responses', 'POST'],
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
  it('reads a grant', () => {
    assert.deepStrictEqual(
      Broker.parseGrants('[{"credential":"T","profile":"github","repos":["you/api"]}]'),
      { grants: [{ credential: 'T', profile: 'github', repos: ['you/api'] }] },
    )
  })

  it('reads no grants at all', () => {
    assert.deepStrictEqual(Broker.parseGrants('[]'), { grants: [] })
  })

  it('refuses a profile it does not have', () => {
    // A broker that dropped the grant it could not read would serve a smaller
    // policy than the one written down, which is not a difference anyone
    // notices until the request that should have been refused succeeds.
    assert.include(message('[{"credential":"T","profile":"gitlab","repos":["you/api"]}]'), 'gitlab')
  })

  it('refuses a grant that names no repositories', () => {
    assert.include(message('[{"credential":"T","profile":"github","repos":[]}]'), 'no repositories')
  })

  it('refuses a repository that is not owner/repo', () => {
    for (const repo of ['api', 'you/api/extra', '../api', 'https://github.com/you/api', 'you/']) {
      assert.include(
        message(`[{"credential":"T","profile":"github","repos":[${JSON.stringify(repo)}]}]`),
        'owner/repo',
      )
    }
  })

  it('refuses malformed input rather than starting without it', () => {
    assert.include(message('not json'), 'not JSON')
    assert.include(message('{}'), 'array')
    assert.include(message('[{"profile":"github","repos":["you/api"]}]'), 'credential')
  })

  it('reads an inference grant, which is a profile and a credential', () => {
    assert.deepStrictEqual(
      Broker.parseGrants(
        '[{"credential":"K","profile":"anthropic-messages"},{"credential":"O","profile":"openrouter"}]',
      ),
      {
        grants: [
          { credential: 'K', profile: 'anthropic-messages' },
          { credential: 'O', profile: 'openrouter' },
        ],
      },
    )
  })

  it('refuses a field it does not read, rather than serving without the limit', () => {
    for (const grant of [
      { credential: 'K', models: ['m'], profile: 'anthropic-messages' },
      { credential: 'K', maxOutputTokens: 64, profile: 'openrouter' },
      { credential: 'K', profile: 'anthropic-messages', repos: ['you/api'] },
      { credential: 'T', models: ['m'], profile: 'github', repos: ['you/api'] },
    ]) {
      assert.include(message(JSON.stringify([grant])), 'which this broker does not read')
    }
  })

  it('refuses a second grant for one profile, which nothing could choose between', () => {
    assert.include(
      message(
        '[{"credential":"K","profile":"anthropic-messages"},{"credential":"L","profile":"anthropic-messages"}]',
      ),
      'two anthropic-messages grants',
    )
    // A request to GitHub's API may name no repository, so its repository
    // cannot pick the grant.
    assert.include(
      message(
        '[{"credential":"T","profile":"github","repos":["you/api"]},{"credential":"U","profile":"github","repos":["you/web"]}]',
      ),
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
      advertise('/github.com/you/api/info/refs'),
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

  it('refuses what it cannot read, rather than passing it through', () => {
    for (const address of ['', 'not-an-address', '999.1.1.1', '1.2.3']) {
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
const tlsIdentity = (dir: string): Broker.TlsIdentity => {
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
      '/CN=github.com',
      '-addext',
      'subjectAltName=DNS:github.com',
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
          await plain.fetch(new Request(refs('you/api')))
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
            ['allow', 3],
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

const held: ReadonlyMap<string, string> = new Map([['GITHUB_TOKEN', 'ghp-test']])

/** A guest's request for a repository's refs, as it reaches the broker. */
const refs = (repo: string): string =>
  `http://broker/github.com/${repo}/info/refs?service=git-upload-pack`

/** Serve `granted` with `send` standing in for the provider, for as long as `use` runs. */
const serving = <A>(
  granted: readonly Broker.Grant[],
  credentials: ReadonlyMap<string, string>,
  send: NonNullable<Parameters<typeof Broker.serveRequests>[3]>,
  use: (server: ReturnType<typeof Broker.serveRequests>) => Promise<A>,
): Promise<A> =>
  withSocketDir(async dir => {
    const server = Broker.serveRequests(join(dir, 'http.sock'), granted, credentials, send)
    try {
      return await use(server)
    } finally {
      await server.stop(true)
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
    'waits for a ref advertisement that takes longer than that to start',
    () =>
      withSocketDir(async dir => {
        const socketPath = join(dir, 'http.sock')
        const server = Broker.serveRequests(
          socketPath,
          grants,
          new Map([['GITHUB_TOKEN', 'ghp-test']]),
          async () => {
            await Bun.sleep(silence)
            return new Response('refs')
          },
        )
        try {
          const response = await fetch(
            'http://broker/github.com/you/api/info/refs?service=git-upload-pack',
            { unix: socketPath },
          )
          assert.strictEqual(response.status, 200)
          assert.strictEqual(await response.text(), 'refs')
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
          [{ credential: 'ANTHROPIC_KEY', profile: 'anthropic-messages' }],
          new Map([['ANTHROPIC_KEY', 'sk-test']]),
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
          const response = await fetch('http://broker/api.anthropic.com/v1/messages', {
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
  const github = (url: string, init: RequestInit): Promise<Response> => {
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
      serving(grants, held, github, async server => {
        sent.length = 0
        const response = await server.fetch(
          new Request('http://broker/api.github.com/repos/you/api/actions/runs?per_page=1', {
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

  it('passes a log’s redirect back for the guest to follow, and follows none itself', () =>
    auditing(() =>
      serving(grants, held, github, async server => {
        sent.length = 0
        const response = await server.fetch(
          new Request('http://broker/api.github.com/repos/you/api/actions/runs/7/logs'),
        )
        assert.strictEqual(response.status, 302)
        assert.strictEqual(response.headers.get('Location'), 'https://logs.example/run.zip?sig=s')
        assert.strictEqual(sent.length, 1)
      }),
    ))

  it('sends a GraphQL query on with its body and type, and the broker’s token', () =>
    auditing(audited =>
      serving(grants, held, github, async server => {
        sent.length = 0
        const query = '{"query":"query{viewer{login}}"}'
        const response = await server.fetch(
          new Request('http://broker/api.github.com/graphql', {
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
        assert.strictEqual(allowed?.['operation'], 'graphql')
        assert.strictEqual(allowed?.['credential'], 'GITHUB_TOKEN')
        assert.notProperty(allowed, 'scope')
      }),
    ))
})

describe('Broker.serveRequests, request by request', () => {
  const granted: readonly Broker.Grant[] = [
    {
      credential: 'GITHUB_TOKEN',
      profile: 'github',
      repos: ['you/api', 'you/gone', 'you/refused', 'you/moved', 'you/broken', 'you/endless'],
    },
    // A grant whose credential the broker was never given.
    { credential: 'OTHER_TOKEN', profile: 'github', repos: ['you/other'] },
  ]

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
          const response = await server.fetch(refs('you/other'))
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
          ['you/other', 500],
        ] as const) {
          const response = await server.fetch(refs(repo))
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
        [{ credential: 'ANTHROPIC_API_KEY', profile: 'anthropic-messages' }],
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
            new Request('http://broker/api.anthropic.com/v1/messages', {
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
        [{ credential: 'OPENROUTER_API_KEY', profile: 'openrouter' }],
        new Map([['OPENROUTER_API_KEY', 'sk-or-test']]),
        (url, init) => {
          sent.push({ init, url })
          return Promise.resolve(
            new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } }),
          )
        },
        async server => {
          const response = await server.fetch(
            new Request('http://broker/openrouter.ai/api/v1/models?output_modalities=rerank'),
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
            allowed.map(event => [event['operation'], 'scope' in event]),
            [['list-models', false]],
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
              new Request(`http://broker/${path}`, { body, method: 'POST' }),
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
        [{ credential: 'ANTHROPIC_API_KEY', profile: 'anthropic-messages' }],
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
            new Request('http://broker/api.anthropic.com/v1/messages', {
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
        (url, init) => fetch(url.replace(/^https:\/\/[^/]+\//, `http://127.0.0.1:${port}/`), init),
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
  const anthropic: readonly Broker.Grant[] = [
    { credential: 'ANTHROPIC_API_KEY', profile: 'anthropic-messages' },
  ]
  const key = new Map([['ANTHROPIC_API_KEY', 'sk-ant-test']])
  const messages = '/api.anthropic.com/v1/messages'

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
  const anthropic: readonly Broker.Grant[] = [
    { credential: 'ANTHROPIC_API_KEY', profile: 'anthropic-messages' },
  ]
  const key = new Map([['ANTHROPIC_API_KEY', 'sk-ant-test']])
  const messages = '/api.anthropic.com/v1/messages'
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
        const response = await fetch(
          'http://broker/github.com/someone/else/info/refs?service=git-upload-pack',
          { unix: socket },
        )
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
          'GET /github.com/someone/else/info/refs?service=git-upload-pack HTTP/1.1\r\n' +
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
          grants: [{ credential: 'GITHUB_TOKEN', profile: 'github', repos: ['you/api'] }],
          socket,
        })
        const denied = events.find(e => e['event'] === 'deny')
        assert.strictEqual(denied?.['scope'], 'someone/else')
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
          names: ['github.com', 'api.github.com'],
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
          JSON.stringify([
            { credential: Broker.tlsKeyCredential, profile: 'github', repos: ['you/api'] },
          ]),
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
