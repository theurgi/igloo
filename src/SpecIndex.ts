/**
 * An OpenAPI spec, reduced to what checking a profile against it needs: each
 * operation's host, method, path, `operationId` and group, and the slots in
 * its path that may hold a `/`.
 *
 * An index names the spec it was made from, by URL and by the sha256 of the
 * file, and the paths of it that were kept, so that a rule outside them is
 * reported as unchecked rather than as matching nothing.
 *
 * Imports nothing, so `scripts/spec-index.ts` runs it with Bun alone.
 */

/** One operation a spec describes. */
export interface Operation {
  /** `x-github.category` where the spec has one, else its first tag, else `untagged`. */
  readonly group: string
  readonly host: string
  readonly method: string
  /** The slots of `path` that may hold a `/` (`x-multi-segment`). */
  readonly multiSegment: readonly string[]
  readonly operationId: string
  /** From the host's root, with no leading `/`, and its slots as the spec writes them, `{name}`. */
  readonly path: string
}

export interface Index {
  readonly operations: readonly Operation[]
  /**
   * The paths of the spec that were kept, as rule paths over the spec's own,
   * where `*` is any one segment, a slot included, and a last `**` any number
   * of them. Absent for the whole spec.
   */
  readonly paths?: readonly string[]
  /** The sha256 of the spec file, in hex. */
  readonly sha256: string
  /** Where the spec file came from. */
  readonly source: string
}

const methods = ['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace'] as const

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw)

const asRecord = (raw: unknown): Record<string, unknown> | undefined =>
  isRecord(raw) ? raw : undefined

/** Whether `pattern`, a rule's path, matches `path`, a sequence of segments. */
export const covers = (pattern: string, path: readonly string[]): boolean => {
  const written = pattern === '' ? [] : pattern.split('/')
  const open = written.at(-1) === '**'
  const fixed = open ? written.slice(0, -1) : written
  return (
    (open ? path.length >= fixed.length : path.length === fixed.length) &&
    fixed.every((segment, at) => segment === '*' || segment === path[at])
  )
}

/** A path from a host's root as segments, `""` the root itself. */
export const segmentsOf = (path: string): readonly string[] => (path === '' ? [] : path.split('/'))

/** The parameter `raw` is, following a `$ref` into `#/components/parameters`. */
const parameterOf = (
  spec: Record<string, unknown>,
  raw: unknown,
): Record<string, unknown> | undefined => {
  const parameter = asRecord(raw)
  const ref = parameter?.['$ref']
  if (typeof ref !== 'string') return parameter
  const prefix = '#/components/parameters/'
  if (!ref.startsWith(prefix)) return undefined
  return asRecord(
    asRecord(asRecord(spec['components'])?.['parameters'])?.[ref.slice(prefix.length)],
  )
}

/** Where a `servers` list sends an operation: its first entry's host and base path. */
const serverOf = (raw: unknown): { host: string; base: string } | string | undefined => {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const url = asRecord(raw[0])?.['url']
  if (typeof url !== 'string') return 'a server has no `url`'
  if (url.includes('{')) return `${url} has variables, which an index cannot fill`
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `${url} is not an absolute URL, so it names no host`
  }
  return {
    base: parsed.pathname.replace(/^\/+|\/+$/g, ''),
    host: parsed.hostname.toLowerCase(),
  }
}

/**
 * The index of `spec`, an OpenAPI document as JSON, keeping the operations
 * whose path one of `paths` covers, or every one without `paths`. Sorted by
 * host, path and method, so that a refreshed index differs where the spec
 * does.
 */
export const indexOf = (
  spec: unknown,
  made: { readonly paths?: readonly string[]; readonly sha256: string; readonly source: string },
): { readonly index: Index } | { readonly message: string } => {
  const document = asRecord(spec)
  const pathItems = asRecord(document?.['paths'])
  if (document === undefined || pathItems === undefined) {
    return { message: 'not an OpenAPI document: it has no `paths`' }
  }
  const root = serverOf(document['servers'])
  const operations: Operation[] = []
  for (const [written, rawItem] of Object.entries(pathItems)) {
    const item = asRecord(rawItem)
    if (item === undefined) continue
    const itemServer = serverOf(item['servers'])
    for (const method of methods) {
      const operation = asRecord(item[method])
      if (operation === undefined) continue
      const server = serverOf(operation['servers']) ?? itemServer ?? root
      const where = `${method.toUpperCase()} ${written}`
      if (server === undefined) return { message: `${where}: the spec names no server` }
      if (typeof server === 'string') return { message: `${where}: ${server}` }
      const path = [server.base, written.replace(/^\/+|\/+$/g, '')]
        .filter(part => part !== '')
        .join('/')
      if (made.paths !== undefined && !made.paths.some(each => covers(each, segmentsOf(path)))) {
        continue
      }
      const parameters = [
        ...(Array.isArray(item['parameters']) ? item['parameters'] : []),
        ...(Array.isArray(operation['parameters']) ? operation['parameters'] : []),
      ].map(each => parameterOf(document, each))
      const multiSegment = [
        ...new Set(
          parameters.flatMap(parameter =>
            parameter?.['in'] === 'path' &&
            parameter['x-multi-segment'] === true &&
            typeof parameter['name'] === 'string'
              ? [parameter['name']]
              : [],
          ),
        ),
      ].toSorted()
      const category = asRecord(operation['x-github'])?.['category']
      const tags = operation['tags']
      const tag = Array.isArray(tags) && typeof tags[0] === 'string' ? tags[0] : undefined
      const id = operation['operationId']
      operations.push({
        group: typeof category === 'string' ? category : (tag ?? 'untagged'),
        host: server.host,
        method: method.toUpperCase(),
        multiSegment,
        operationId: typeof id === 'string' ? id : where,
        path,
      })
    }
  }
  operations.sort(
    (a, b) =>
      a.host.localeCompare(b.host) ||
      a.path.localeCompare(b.path) ||
      a.method.localeCompare(b.method),
  )
  return {
    index: {
      source: made.source,
      sha256: made.sha256,
      ...(made.paths === undefined ? {} : { paths: made.paths }),
      operations,
    },
  }
}

const isStrings = (raw: unknown): raw is readonly string[] =>
  Array.isArray(raw) && raw.every(each => typeof each === 'string')

/** An index as `indexOf` writes it, read back from JSON, or what is wrong with it. */
export const readIndex = (
  raw: unknown,
): { readonly index: Index } | { readonly message: string } => {
  const index = asRecord(raw)
  const { operations, paths, sha256, source } = index ?? {}
  if (
    typeof source !== 'string' ||
    typeof sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    (paths !== undefined && !isStrings(paths)) ||
    !Array.isArray(operations)
  ) {
    return {
      message:
        'an index is `{ source, sha256, paths?, operations }`, as `scripts/spec-index.ts` writes it',
    }
  }
  const read: Operation[] = []
  for (const each of operations as readonly unknown[]) {
    const operation = asRecord(each)
    const { group, host, method, multiSegment, operationId, path } = operation ?? {}
    if (
      typeof group !== 'string' ||
      typeof host !== 'string' ||
      typeof method !== 'string' ||
      !isStrings(multiSegment) ||
      typeof operationId !== 'string' ||
      typeof path !== 'string'
    ) {
      return {
        message: `operation ${JSON.stringify(each)} is not \`{ group, host, method, multiSegment, operationId, path }\``,
      }
    }
    read.push({ group, host, method, multiSegment, operationId, path })
  }
  return { index: { operations: read, ...(paths === undefined ? {} : { paths }), sha256, source } }
}
