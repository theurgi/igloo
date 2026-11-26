#!/usr/bin/env bun
// Make an index of an OpenAPI spec file for `igloo profile check --index`,
// printed as JSON. It fetches nothing: whoever refreshes an index downloads
// the spec and runs this on it.
//
//   bun scripts/spec-index.ts --source <url> [--path <pattern>]... <spec.json>
//
// `--source` is where the file came from, which the index names beside the
// file's sha256. Each `--path` keeps the operations whose path, from the
// host's root, it covers, as a rule's path does: `*` any one segment and a
// last `**` any number. Without one, every operation is kept.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { indexOf } from '../src/SpecIndex.ts'

const usage = 'usage: bun scripts/spec-index.ts --source <url> [--path <pattern>]... <spec.json>'

function fail(message: string): never {
  process.stderr.write(`spec-index: ${message}\n${usage}\n`)
  process.exit(2)
}

const paths: string[] = []
let source: string | undefined
let file: string | undefined
const args = process.argv.slice(2)
for (let at = 0; at < args.length; at += 1) {
  const arg = args[at]
  const value = args[at + 1]
  if (arg === '--source' || arg === '--path') {
    if (value === undefined) fail(`${arg} takes a value`)
    else if (arg === '--source') source = value
    else paths.push(value)
    at += 1
  } else if (arg !== undefined && !arg.startsWith('--') && file === undefined) {
    file = arg
  } else {
    fail(`unexpected argument ${String(arg)}`)
  }
}
if (source === undefined || file === undefined) fail('a spec file and --source are required')

const bytes = readFileSync(file)
let spec: unknown
try {
  spec = JSON.parse(bytes.toString('utf8'))
} catch {
  fail(`${file} is not JSON`)
}
const made = indexOf(spec, {
  ...(paths.length === 0 ? {} : { paths }),
  sha256: createHash('sha256').update(bytes).digest('hex'),
  source,
})
if ('message' in made) fail(`${file}: ${made.message}`)
else process.stdout.write(`${JSON.stringify(made.index, null, 2)}\n`)
