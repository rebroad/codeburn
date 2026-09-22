import { defineConfig } from 'tsup'
import { execFileSync } from 'node:child_process'

function currentCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || 'unknown'
  } catch {
    return process.env.CODEBURN_COMMIT ?? 'unknown'
  }
}

const buildCommit = process.env.CODEBURN_COMMIT ?? currentCommit()

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
