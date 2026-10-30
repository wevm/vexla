/** @module The `retire` command: replaces each read of a flag with its final value, then deletes the flag. */
import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import { Cli, z } from 'incur'
import * as Definitions from '../../Definitions.js'
import * as Files from '../../internal/Files.js'
import * as Context from '../Context.js'

export default Cli.command({
  args: z.object({ key: z.string().describe('Key of the flag, such as newCheckout') }),
  description:
    'Replaces each read of a flag with its final value, deletes the declaration, and prunes the store.',
  options: Context.file.extend({
    ...Context.server.shape,
    dryRun: z.boolean().optional().describe('Print the changes, and write nothing'),
    value: z
      .string()
      .optional()
      .describe('Final value. Default: the store value with --url, else the default'),
  }),
  async run(c) {
    try {
      const root = Context.root(c.options)
      const definitions = Context.definitions(c.options)
      const definition = definitions[c.args.key]
      if (!definition)
        return c.error({ code: 'UNKNOWN_FLAG', message: `No flag declares the key ${c.args.key}.` })

      const value = await (async (): Promise<Definitions.Json> => {
        if (c.options.value !== undefined)
          return Definitions.decode(definition, c.options.value, c.args.key)
        if (c.options.url) {
          const flags = ((await Context.api(c.options, 'GET', '/manifest'))['flags'] ??
            {}) as Record<string, { store: unknown }>
          const stored = flags[c.args.key]?.store
          if (stored !== null && stored !== undefined && Definitions.validate(definition, stored))
            return stored
        }
        return definition.default
      })()

      // The TypeScript compiler API loads only for this command.
      const Inline = await import('../../internal/Inline.js')
      const changed: string[] = []
      const unresolved: { file: string; line: number }[] = []

      for (const file of sources(root)) {
        const code = Fs.readFileSync(Path.join(root, file), 'utf8')
        if (!code.includes('flargs')) continue

        const result = Inline.transform(code, {
          definitions,
          file,
          prune: true,
          values: { [c.args.key]: value },
        })
        for (const finding of result.findings)
          if (finding.reason === 'dynamic') unresolved.push({ file, line: finding.line })
        if (result.code === code) continue

        changed.push(file)
        if (!c.options.dryRun) Fs.writeFileSync(Path.join(root, file), result.code)
      }

      if (!c.options.dryRun) {
        const path = Path.resolve(root, c.options.path ?? Files.defaultPath)
        const text = Definitions.removeFromFile(Fs.readFileSync(path, 'utf8'), c.args.key)
        Fs.writeFileSync(path, text)

        const out = Path.resolve(root, Files.defaultOut)
        if (Fs.existsSync(out)) Files.write(Definitions.parseFile(text), { root })

        if (c.options.url)
          await Context.api(c.options, 'DELETE', `/values/${encodeURIComponent(c.args.key)}`).catch(
            () => {},
          )
      }

      return { changed, dryRun: Boolean(c.options.dryRun), key: c.args.key, unresolved, value }
    } catch (error) {
      return c.error(Context.error(error))
    }
  },
})

// Source files that git tracks, or every source file outside node_modules and dist when git is absent.
function sources(root: string): string[] {
  const pattern = /\.[cm]?[jt]sx?$/
  const tracked = (() => {
    try {
      return ChildProcess.execFileSync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard'],
        {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      )
        .split('\n')
        .filter(Boolean)
    } catch {
      return undefined
    }
  })()
  const files = tracked ?? walk(root, '')
  return files.filter(
    (file) =>
      pattern.test(file) && !file.endsWith('.d.ts') && Path.basename(file) !== Files.defaultOut,
  )
}

function walk(root: string, dir: string): string[] {
  return Fs.readdirSync(Path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.'))
      return []
    const path = Path.join(dir, entry.name)
    return entry.isDirectory() ? walk(root, path) : [path]
  })
}
