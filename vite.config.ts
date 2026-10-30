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
        find: 'flargs/server',
        replacement: Path.resolve(import.meta.dirname, 'src/server/index.ts'),
      },
      { find: /^flargs$/, replacement: Path.resolve(import.meta.dirname, 'src/index.ts') },
    ],
    exclude: ['.claude/**', 'dist/**', 'node_modules/**'],
    globals: true,
  },
  lint: {
    ignorePatterns: ['.claude/**', 'dist/**'],
    // TypeScript runs separately through `pnpm check:types`.
    options: {
      typeAware: false,
      typeCheck: false,
    },
  },
  fmt: {
    ignorePatterns: ['.claude/**', 'dist/**'],
    printWidth: 100,
    semi: false,
    singleQuote: true,
    sortPackageJson: false,
  },
})
