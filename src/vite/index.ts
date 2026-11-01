/**
 * @module Vite entry: reads `.env.flags`, writes `vexla.gen.ts`, and replaces each read of a
 * build flag with a literal, so dead branches drop from the bundle. In a Vitest run, it adds a
 * setup file that runs each test in `Values.run`.
 */
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import { loadEnv, type Plugin } from 'vite'
import type * as Definitions from '../Definitions.js'
import * as Errors from '../internal/Errors.js'
import * as Files from '../internal/Files.js'
import * as Inline from '../internal/Inline.js'
import type * as Store from '../server/Store.js'

// The setup file of a Vitest run. Vitest resolves a setup file against the root, so the plugin
// matches the base name, and the null byte marks the resolved module as virtual.
const setupFile = 'vexla:vitest-setup'
const setupId = `\0${setupFile}`

/** Returns the Vexla Vite plugin. */
export default function vexla(options: vexla.Options = {}): Plugin {
  let root = process.cwd()
  let env: Record<string, string | undefined> = {}
  let definitions: Definitions.Definitions = {}
  let loading: Promise<void> | undefined
  let values: Record<string, Definitions.Json> = {}

  const load = async () => {
    definitions = Files.read({ path: options.path, root })
    Files.write(definitions, { out: options.out, root })
    const keys = Object.entries(definitions)
      .filter((entry) => entry[1].build)
      .map((entry) => entry[0])
    const stored = options.store && keys.length > 0 ? await options.store.get(keys) : {}
    values = Files.buildValues(definitions, { env, values: stored })
  }

  return {
    async buildStart() {
      loading = load()
      await loading
      this.addWatchFile(Path.resolve(root, options.path ?? Files.defaultPath))
    },

    // Vitest reads `test` from the Vite config. A Vite build ignores it.
    config(config) {
      if (!process.env['VITEST']) return undefined
      const file = Path.resolve(config.root ?? process.cwd(), setupFile)
      return { test: { setupFiles: [file] } } as never
    },

    configResolved(config) {
      root = config.root
      env = { ...process.env, ...loadEnv(config.mode, config.envDir || root, '') }
    },

    configureServer(server) {
      const file = Path.resolve(root, options.path ?? Files.defaultPath)
      server.watcher.add(file)
      server.watcher.on('change', (changed) => {
        if (Path.resolve(changed) !== file) return
        void load().then(() => server.ws.send({ type: 'full-reload' }))
      })
    },

    enforce: 'pre',

    async load(id) {
      if (id !== setupId) return undefined
      await (loading ??= load())

      // The setup file imports Vitest from the root, as test files do, so both reach one copy.
      const importer = Path.join(root, 'index.ts')
      const vitest = (await this.resolve('vite-plus/test', importer)) ? 'vite-plus/test' : 'vitest'
      // Only the variables of flags reach the module, so no other secret enters the module graph.
      const flagEnv = Object.fromEntries(
        Object.keys(definitions).flatMap((key) =>
          env[key] === undefined ? [] : [[key, env[key]]],
        ),
      )

      return [
        `import { aroundEach } from ${JSON.stringify(vitest)}`,
        "import { Vexla } from 'vexla/server'",
        "import { setup } from 'vexla/vitest'",
        '',
        'setup({',
        '  aroundEach,',
        `  vexla: Vexla.create({ definitions: ${JSON.stringify(definitions)}, dev: true, env: ${JSON.stringify(flagEnv)} }),`,
        '})',
        '',
      ].join('\n')
    },

    name: 'vexla',

    resolveId(id) {
      return Path.basename(id) === setupFile ? setupId : undefined
    },

    transform(code, id, transformOptions) {
      if (
        !code.includes('vexla') ||
        id.includes('/node_modules/') ||
        !/\.[cm]?[jt]sx?$/.test(id.split('?')[0]!)
      )
        return undefined
      if (!Fs.existsSync(id.split('?')[0]!)) return undefined

      const browser = !(transformOptions?.ssr ?? false)
      // Browser code receives public build flags only, so a private build flag read stays and fails.
      const inlined = browser
        ? Object.fromEntries(
            Object.entries(values).filter((entry) => definitions[entry[0]]?.public),
          )
        : values
      const result = Inline.transform(code, {
        browser,
        definitions,
        file: id.split('?')[0]!,
        values: inlined,
      })

      const leak = result.findings.find((finding) => finding.reason === 'private')
      if (leak)
        this.error(
          new Errors.BaseError(
            `Browser code reads the private flag ${leak.key} in ${Path.relative(root, id)}:${leak.line}.`,
            {
              steps: [
                `Read ${leak.key} on the server, or add \`@public\` to the flag in .env.flags.`,
              ],
            },
          ),
        )

      return result.code === code ? undefined : { code: result.code, map: null }
    },
  }
}

export declare namespace vexla {
  type Options = {
    /** The path of the generated module, relative to the Vite root. @default 'vexla.gen.ts' */
    out?: string | undefined
    /** The path of the flags file, relative to the Vite root. @default '.env.flags' */
    path?: string | undefined
    /** A store whose values take precedence over the environment for build flags, such as `Store.http`. */
    store?: Pick<Store.Store, 'get'> | undefined
  }
}
