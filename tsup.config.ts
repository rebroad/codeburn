import { defineConfig } from 'tsup'
import { execFileSync } from 'node:child_process'

function currentCommit(): string {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    if (/^[0-9a-f]{40}$/i.test(commit)) return commit
  } catch {
    // A caller building outside the source checkout can provide its source
    // revision through CODEBURN_COMMIT. Never silently stamp "unknown".
  }
  throw new Error('Unable to determine CodeBurn commit. Set CODEBURN_COMMIT to the source checkout SHA before building.')
}

const buildCommit = process.env.CODEBURN_COMMIT ?? currentCommit()
if (!/^[0-9a-f]{40}$/i.test(buildCommit)) {
  throw new Error(`Invalid CODEBURN_COMMIT: expected a full 40-character Git SHA, got ${JSON.stringify(buildCommit)}`)
}

export default defineConfig({
  entry: ['src/main.ts', 'src/parse-worker.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  external: ['@modelcontextprotocol/sdk', 'zod'],
  define: {
    'process.env.CODEBURN_COMMIT': JSON.stringify(buildCommit),
  },
})
