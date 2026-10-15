import { assert, describe, it } from '@effect/vitest'
import { readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'

import packageJson from '../package.json' with { type: 'json' }

const root = path.resolve(new URL('..', import.meta.url).pathname)

const pages = [
  'README.md',
  ...readdirSync(path.join(root, 'docs'))
    .filter(name => name.endsWith('.md'))
    .map(name => path.join('docs', name)),
]

// A flake reference to this repository, up to the output a `#` would name.
const reference = /github:theurgi\/igloo[^\s"'`#)]*/g

describe('the docs', () => {
  it('pin every flake reference to igloo to the release this tree is', () => {
    const references = pages.flatMap(page =>
      Array.from(readFileSync(path.join(root, page), 'utf8').matchAll(reference), ([found]) => ({
        page,
        found,
      })),
    )

    // Without a tag a reference follows `main`, and with another release's it
    // installs code other than what the page describes.
    assert.isNotEmpty(references)
    assert.deepStrictEqual(
      references.filter(({ found }) => found !== `github:theurgi/igloo/v${packageJson.version}`),
      [],
    )
  })
})
