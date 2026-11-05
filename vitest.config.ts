import { defineConfig } from 'vitest/config'

// Bun's Worker doesn't expose Node-compat stdout, which breaks vitest's default
// `threads` pool. `forks` works.
export default defineConfig({
  test: {
    pool: 'forks',
    include: ['src/**/*.test.ts'],
  },
})
