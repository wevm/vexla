import * as Path from 'node:path'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  test: {
    // Longer specifiers come first, since the bare `flargs` pattern is anchored.
    alias: [
      {
        find: 'flargs/hono',
        replacement: Path.resolve(import.meta.dirname, 'src/hono/index.ts'),
      },
      {
        find: 'flargs/node',
        replacement: Path.resolve(import.meta.dirname, 'src/node/index.ts'),
      },
      {
        find: 'flargs/react',
        replacement: Path.resolve(import.meta.dirname, 'src/react/index.ts'),
      },
      {
        find: 'flargs/server',
        replacement: Path.resolve(import.meta.dirname, 'src/server/index.ts'),
      },
      {
        find: 'flargs/vite',
        replacement: Path.resolve(import.meta.dirname, 'src/vite/index.ts'),
      },
      {
        find: 'flargs/zile',
        replacement: Path.resolve(import.meta.dirname, 'src/zile/index.ts'),
      },
      { find: /^flargs$/, replacement: Path.resolve(import.meta.dirname, 'src/index.ts') },
    ],
    exclude: ['.claude/**', 'dist/**', 'node_modules/**', 'target/**'],
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
