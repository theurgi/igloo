import { assert, describe, it } from '@effect/vitest'

import { covers, indexOf, readIndex } from './SpecIndex.ts'

const made = { sha256: 'a'.repeat(64), source: 'https://example.com/openapi.json' }

/** A spec in the shape GitHub's takes: categories, a shared parameter, and an upload elsewhere. */
const spec = {
  components: {
    parameters: {
      owner: { in: 'path', name: 'owner', schema: { type: 'string' } },
      path: { in: 'path', name: 'path', 'x-multi-segment': true },
    },
  },
  openapi: '3.0.3',
  paths: {
    '/': { get: { operationId: 'meta/root', tags: ['meta'] } },
    '/orgs/{org}': { get: { operationId: 'orgs/get', tags: ['orgs'] } },
    '/repos/{owner}/{repo}/contents/{path}': {
      get: {
        operationId: 'repos/get-content',
        parameters: [
          { $ref: '#/components/parameters/owner' },
          { $ref: '#/components/parameters/path' },
        ],
        tags: ['repos'],
        'x-github': { category: 'repos', subcategory: 'contents' },
      },
      parameters: [],
    },
    '/repos/{owner}/{repo}/releases/{release_id}/assets': {
      post: {
        operationId: 'repos/upload-release-asset',
        servers: [{ url: 'https://uploads.github.com' }],
        tags: ['repos'],
        'x-github': { category: 'releases' },
      },
    },
    '/repos/{owner}/{repo}/statuses/{sha}': {
      post: {
        parameters: [{ in: 'path', name: 'sha', 'x-multi-segment': true }],
        'x-github': { category: 'commits' },
      },
    },
  },
  servers: [{ url: 'https://api.github.com' }],
}

describe('indexOf', () => {
  it('reads each operation: host, method, path, id, group and multi-segment slots', () => {
    const result = indexOf(spec, made)
    assert('index' in result)
    assert.deepStrictEqual(result.index, {
      operations: [
        {
          group: 'meta',
          host: 'api.github.com',
          method: 'GET',
          multiSegment: [],
          operationId: 'meta/root',
          path: '',
        },
        {
          group: 'orgs',
          host: 'api.github.com',
          method: 'GET',
          multiSegment: [],
          operationId: 'orgs/get',
          path: 'orgs/{org}',
        },
        {
          group: 'repos',
          host: 'api.github.com',
          method: 'GET',
          multiSegment: ['path'],
          operationId: 'repos/get-content',
          path: 'repos/{owner}/{repo}/contents/{path}',
        },
        {
          group: 'commits',
          host: 'api.github.com',
          method: 'POST',
          multiSegment: ['sha'],
          operationId: 'POST /repos/{owner}/{repo}/statuses/{sha}',
          path: 'repos/{owner}/{repo}/statuses/{sha}',
        },
        {
          group: 'releases',
          host: 'uploads.github.com',
          method: 'POST',
          multiSegment: [],
          operationId: 'repos/upload-release-asset',
          path: 'repos/{owner}/{repo}/releases/{release_id}/assets',
        },
      ],
      sha256: made.sha256,
      source: made.source,
    })
  })

  it('keeps only the paths asked for, and says which they were', () => {
    const result = indexOf(spec, { ...made, paths: ['', 'repos/*/*/**'] })
    assert('index' in result)
    assert.deepStrictEqual(result.index.paths, ['', 'repos/*/*/**'])
    assert.notInclude(
      result.index.operations.map(each => each.operationId),
      'orgs/get',
    )
    assert.strictEqual(result.index.operations.length, 4)
  })

  it('puts a server’s base path before each path', () => {
    const result = indexOf(
      {
        paths: { '/chat/completions': { post: { operationId: 'chat', tags: ['Chat'] } } },
        servers: [{ url: 'https://openrouter.ai/api/v1' }],
      },
      made,
    )
    assert('index' in result)
    assert.strictEqual(result.index.operations[0]?.path, 'api/v1/chat/completions')
    assert.strictEqual(result.index.operations[0]?.host, 'openrouter.ai')
  })

  it('refuses a spec whose server names no host', () => {
    const result = indexOf({ paths: { '/x': { get: {} } }, servers: [{ url: '/api' }] }, made)
    assert('message' in result)
    assert.include(result.message, 'not an absolute URL')
  })

  it('reads back what it wrote, and refuses anything else', () => {
    const result = indexOf(spec, made)
    assert('index' in result)
    assert.deepStrictEqual(readIndex(JSON.parse(JSON.stringify(result.index))), result)
    assert('message' in readIndex({ ...result.index, sha256: 'not a hash' }))
    assert('message' in readIndex({ ...result.index, operations: [{ method: 'GET' }] }))
  })
})

describe('covers', () => {
  it('matches as a rule’s path does', () => {
    assert.isTrue(covers('', []))
    assert.isTrue(covers('repos/*/*/**', ['repos', '{owner}', '{repo}']))
    assert.isTrue(covers('v2/**', ['v2', 'pods', '{id}']))
    assert.isFalse(covers('repos/*/*/**', ['orgs', '{org}']))
    assert.isFalse(covers('graphql', []))
  })
})
