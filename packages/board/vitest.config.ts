import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // A2's SQLite store opens `node:sqlite` through board's own, as the build has it, so a Durable Object's database works in tests too.
  resolve: { alias: { 'node:sqlite': fileURLToPath(new URL('src/store/node-sqlite.ts', import.meta.url)) } },
  test: { server: { deps: { inline: [/experimental-a2/] } } },
})
