/** @module Commands that call the admin API: `list`, `get`, `set`, `unset`, `define`, `undefine`, `prune`, and `link`. */
import { Cli, z } from 'incur'
import * as Context from '../Context.js'

const key = z.object({ key: z.string().describe('Key of the flag, such as newCheckout') })

type Flag = { source: string; type: string; value: unknown }

/** `vexla list`: lists every flag of a running server with its value and source. */
export const list = Cli.command({
  description: 'Lists every flag of a running server, with its value and source.',
  options: Context.server,
  async run(c) {
    try {
      const manifest = await Context.api(c.options, 'GET', '/manifest')
      const flags = (manifest['flags'] ?? {}) as Record<string, Flag>
      return {
        flags: Object.entries(flags).map((entry) => ({
          key: entry[0],
          source: entry[1].source,
          type: entry[1].type,
          value: entry[1].value,
        })),
      }
    } catch (error) {
      return c.error(Context.error(error))
    }
  },
})

/** `vexla get`: returns one flag of a running server. */
export const get = Cli.command({
  args: key,
  description: 'Returns one flag of a running server, with its definition, value, and source.',
  options: Context.server,
  async run(c) {
    try {
      const flags = ((await Context.api(c.options, 'GET', '/manifest'))['flags'] ?? {}) as Record<
        string,
        unknown
      >
      const flag = flags[c.args.key]
      if (!flag)
        return c.error({ code: 'UNKNOWN_FLAG', message: `No flag declares the key ${c.args.key}.` })
      return { key: c.args.key, ...(flag as object) }
    } catch (error) {
      return c.error(Context.error(error))
    }
  },
})

/** `vexla set`: sets the store value of a flag for every request. */
export const set = Cli.command({
  args: key.extend({ value: z.string().describe('Value, such as true, b, 3, or {"requests":5}') }),
  description: 'Sets the store value of a flag for every request.',
  options: Context.server,
  async run(c) {
    try {
      const types = await typesOf(c.options)
      const value = parse(c.args.value, types[c.args.key])
      await Context.api(c.options, 'PUT', `/values/${encodeURIComponent(c.args.key)}`, { value })
      return { key: c.args.key, value }
    } catch (error) {
      return c.error(Context.error(error))
    }
  },
})

/** `vexla unset`: deletes the store value of a flag. */
export const unset = Cli.command({
  args: key,
  description: 'Deletes the store value of a flag.',
  options: Context.server,
  async run(c) {
    try {
      await Context.api(c.options, 'DELETE', `/values/${encodeURIComponent(c.args.key)}`)
      return { key: c.args.key }
    } catch (error) {
      return c.error(Context.error(error))
    }
  },
})

/** `vexla define`: creates or replaces a store definition. */
export const define = Cli.command({
  args: key,
  description: 'Creates or replaces a flag in the store, for a project with no flags file.',
  options: Context.server.extend({
    default: z.string().describe('Default value, such as false, a, 3, or {"requests":5}'),
    description: z.string().optional().describe('Description of the flag'),
    options: z.string().optional().describe('Comma-separated options of a select flag'),
    public: z.boolean().optional().describe('Let the value reach the browser'),
    type: z.enum(['boolean', 'json', 'number', 'select', 'string']).describe('Type of the flag'),
  }),
  async run(c) {
    try {
      const definition = {
        default:
          c.options.type === 'string' || c.options.type === 'select'
            ? c.options.default
            : parse(c.options.default),
        ...(c.options.description ? { description: c.options.description } : {}),
        ...(c.options.options
          ? { options: c.options.options.split(',').map((option) => option.trim()) }
          : {}),
        ...(c.options.public ? { public: true } : {}),
        type: c.options.type,
      }
      const result = await Context.api(
        c.options,
        'PUT',
        `/definitions/${encodeURIComponent(c.args.key)}`,
        definition,
      )
      return { definition: result['definition'], key: c.args.key }
    } catch (error) {
      return c.error(Context.error(error))
    }
  },
})

/** `vexla undefine`: deletes a store definition. */
export const undefine = Cli.command({
  args: key,
  description: 'Deletes a flag from the store, with its value.',
  options: Context.server,
  async run(c) {
    try {
      await Context.api(c.options, 'DELETE', `/definitions/${encodeURIComponent(c.args.key)}`)
      return { key: c.args.key }
    } catch (error) {
      return c.error(Context.error(error))
    }
  },
})

/** `vexla prune`: lists, and with `--yes` deletes, store values of keys that no flag declares. */
export const prune = Cli.command({
  description: 'Lists store values of removed flags. --yes deletes them.',
  options: Context.server.extend({ yes: z.boolean().optional().describe('Delete the values') }),
  async run(c) {
    try {
      const orphans = (await Context.api(c.options, 'GET', '/manifest'))['orphans']
      if (!Array.isArray(orphans))
        return c.error({
          code: 'NO_KEYS',
          message: 'The store does not list its keys. To resolve: Implement `keys` on the store.',
        })
      if (c.options.yes)
        for (const orphan of orphans)
          await Context.api(c.options, 'DELETE', `/values/${encodeURIComponent(String(orphan))}`)
      return { deleted: Boolean(c.options.yes), orphans }
    } catch (error) {
      return c.error(Context.error(error))
    }
  },
})

/** `vexla link`: returns a signed link that overrides flags until it expires. */
export const link = Cli.command({
  args: z.object({
    url: z.string().describe('Page to link, such as https://app.example.com/checkout'),
    values: z.array(z.string()).describe('Overrides as key=value, such as pricing=c'),
  }),
  description:
    'Returns a signed link that overrides flags, including private flags, until it expires.',
  options: Context.server.extend({
    expires: z.string().optional().describe('Lifetime, such as 1h, 7d. Default: 7d'),
  }),
  async run(c) {
    try {
      const types = await typesOf(c.options)
      const values = Object.fromEntries(
        c.args.values.map((pair) => {
          const index = pair.indexOf('=')
          if (index === -1) throw new Error(`Expected key=value, received ${pair}.`)
          return [pair.slice(0, index), parse(pair.slice(index + 1), types[pair.slice(0, index)])]
        }),
      )
      const expiresAt = Date.now() + duration(c.options.expires ?? '7d')
      const result = await Context.api(c.options, 'POST', '/links', {
        expiresAt,
        url: c.args.url,
        values,
      })
      return { expiresAt, url: result['url'] }
    } catch (error) {
      return c.error(Context.error(error))
    }
  },
})

// A value on the command line is text for a string or select flag, and JSON otherwise.
function parse(value: string, type?: string | undefined): unknown {
  if (type === 'string' || type === 'select') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

async function typesOf(options: { url?: string | undefined }): Promise<Record<string, string>> {
  const flags = ((await Context.api(options, 'GET', '/manifest'))['flags'] ?? {}) as Record<
    string,
    Flag
  >
  return Object.fromEntries(Object.entries(flags).map((entry) => [entry[0], entry[1].type]))
}

function duration(value: string): number {
  const match = /^(\d+)([mhd])$/.exec(value)
  if (!match) throw new Error(`Expected a lifetime such as 30m, 1h, or 7d, received ${value}.`)
  return Number(match[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[match[2] as 'd' | 'h' | 'm']
}
