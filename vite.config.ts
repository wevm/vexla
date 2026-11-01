import * as Path from 'node:path'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  test: {
    // Longer specifiers come first, since the bare `vexla` pattern is anchored.
    alias: [
      {
        find: 'vexla/hono',
        replacement: Path.resolve(import.meta.dirname, 'src/hono/index.ts'),
      },
      {
        find: 'vexla/node',
        replacement: Path.resolve(import.meta.dirname, 'src/node/index.ts'),
      },
      {
        find: 'vexla/react',
        replacement: Path.resolve(import.meta.dirname, 'src/react/index.ts'),
      },
      {
        find: 'vexla/server',
        replacement: Path.resolve(import.meta.dirname, 'src/server/index.ts'),
      },
      {
        find: 'vexla/vite',
        replacement: Path.resolve(import.meta.dirname, 'src/vite/index.ts'),
      },
      {
        find: 'vexla/vitest',
        replacement: Path.resolve(import.meta.dirname, 'src/vitest/index.ts'),
      },
      {
        find: 'vexla/zile',
        replacement: Path.resolve(import.meta.dirname, 'src/zile/index.ts'),
      },
      { find: /^vexla$/, replacement: Path.resolve(import.meta.dirname, 'src/index.ts') },
    ],
    exclude: ['**/node_modules/**', '.claude/**', 'dist/**', 'docs/**', 'target/**'],
    globals: true,
    // CLI tests start processes, which take longer on CI runners.
    testTimeout: 30_000,
  },
  lint: {
    ignorePatterns: ['.claude/**', 'dist/**', 'target/**'],
    // TypeScript runs separately through `pnpm check:types`.
    options: {
      typeAware: false,
      typeCheck: false,
    },
  },
  fmt: {
    // Cargo manifests follow Rust conventions, not oxfmt.
    ignorePatterns: ['.claude/**', '**/Cargo.toml', 'dist/**', 'target/**'],
    printWidth: 100,
    semi: false,
    singleQuote: true,
    sortPackageJson: false,
  },
})
