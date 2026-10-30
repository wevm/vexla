/**
 * @module Vite entry: reads `.env.flags`, writes `flargs.gen.ts`, and replaces each read of a
 * build flag with a literal, so dead branches drop from the bundle.
 */
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import { loadEnv, type Plugin } from 'vite'
import type * as Definitions from '../Definitions.js'
import * as Errors from '../internal/Errors.js'
import * as Files from '../internal/Files.js'
import * as Inline from '../internal/Inline.js'
import type * as Store from '../server/Store.js'

/** Returns the Flargs Vite plugin. */
export default function flargs(options: flargs.Options = {}): Plugin {
  let root = process.cwd()
  let env: Record<string, string | undefined> = {}
  let definitions: Definitions.Definitions = {}
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
      await load()
      this.addWatchFile(Path.resolve(root, options.path ?? Files.defaultPath))
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
    name: 'flargs',

    transform(code, id, transformOptions) {
      if (
        !code.includes('flargs') ||
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

export declare namespace flargs {
  type Options = {
    /** The path of the generated module, relative to the Vite root. @default 'flargs.gen.ts' */
    out?: string | undefined
    /** The path of the flags file, relative to the Vite root. @default '.env.flags' */
    path?: string | undefined
    /** A store whose values take precedence over the environment for build flags, such as `Store.http`. */
    store?: Pick<Store.Store, 'get'> | undefined
  }
}
