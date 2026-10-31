/** @module Commands that read the flags file: `generate`, `check`, and `stale`. */
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import { Cli, z } from 'incur'
import * as Definitions from '../../Definitions.js'
import * as Files from '../../internal/Files.js'
import * as Context from '../Context.js'

/** `vexla generate`: writes `vexla.gen.ts` from the flags file, or from the manifest of `--url`. */
export const generate = Cli.command({
  description: 'Writes vexla.gen.ts from .env.flags, or from the manifest of a running server.',
  options: Context.file.extend({
    ...Context.server.shape,
    out: z.string().optional().describe('Path of the generated module. Default: vexla.gen.ts'),
    visibility: z
      .enum(['all', 'public'])
      .optional()
      .describe('Flags to declare. Default: all, or public with --url'),
  }),
  async run(c) {
    try {
      const remote = c.options.url !== undefined
      const definitions = remote
        ? Definitions.parse(
            fileOf(
              ((await Context.api(c.options, 'GET', '/manifest'))['flags'] ?? {}) as Record<
                string,
                Record<string, unknown>
              >,
            ),
          )
        : Context.definitions(c.options)
      const visibility = c.options.visibility ?? (remote ? 'public' : 'all')
      const out = Path.resolve(Context.root(c.options), c.options.out ?? Files.defaultOut)
      const written = Files.write(definitions, { out, root: Context.root(c.options), visibility })
      return {
        flags: Object.keys(
          visibility === 'public' ? Definitions.publicOf(definitions) : definitions,
        ).length,
        out,
        written,
      }
    } catch (error) {
      return c.error(Context.error(error))
    }
  },
})

/** `vexla check`: validates the environment against the flags file. */
export const check = Cli.command({
  description:
    'Fails when the environment sets an invalid flag value, or an undeclared variable with --prefix. Reports stale flags.',
  options: Context.file.extend({
    envFile: z
      .array(z.string())
      .optional()
      .describe('Dotenv files to check with the environment, such as .env'),
    prefix: z
      .string()
      .optional()
      .describe('Report undeclared variables with this prefix, such as FEATURE_'),
    strict: z.boolean().optional().describe('Fail on stale flags too'),
  }),
  run(c) {
    try {
      const definitions = Context.definitions(c.options)
      const env = { ...process.env }
      for (const file of c.options.envFile ?? [])
        Object.assign(
          env,
          dotenv(Fs.readFileSync(Path.resolve(Context.root(c.options), file), 'utf8')),
        )

      const issues = Definitions.check(definitions, env, { prefix: c.options.prefix })
      const failing = issues.filter((issue) => issue.reason !== 'stale' || c.options.strict)
      if (failing.length > 0)
        return c.error({
          code: 'CHECK',
          message: failing.map((issue) => `${issue.key}: ${issue.reason}`).join(', '),
        })
      return { issues }
    } catch (error) {
      return c.error(Context.error(error))
    }
  },
})

/** `vexla stale`: lists flags past their `expires` date. */
export const stale = Cli.command({
  description: 'Lists flags past their expires date, which are due for retirement.',
  options: Context.file,
  run(c) {
    try {
      const definitions = Context.definitions(c.options)
      return {
        stale: Object.entries(definitions)
          .filter((entry) => Definitions.isStale(entry[1]))
          .map((entry) => ({ expires: entry[1].expires!, key: entry[0] })),
      }
    } catch (error) {
      return c.error(Context.error(error))
    }
  },
})

// The manifest adds runtime fields to each definition. The flags file format keeps only declared fields.
function fileOf(flags: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const fields = ['build', 'default', 'description', 'expires', 'options', 'public', 'type']
  return Object.fromEntries(
    Object.entries(flags).map((entry) => [
      entry[0],
      Object.fromEntries(
        Object.entries(entry[1]).filter(
          (field) => fields.includes(field[0]) && field[1] !== undefined,
        ),
      ),
    ]),
  )
}

// Reads `NAME=value` lines. Quotes around a value are removed. Comments and blank lines are skipped.
function dotenv(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    const value = match[2]!
    result[match[1]!] = /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value
  }
  return result
}
