/** @module Reads the flags file of a project and writes `vexla.gen.ts`, for the build tools and the CLI. */
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import * as Definitions from '../Definitions.js'

/** The default path of the flags file. */
export const defaultPath = '.env.flags'

/** The default path of the generated module. */
export const defaultOut = 'vexla.gen.ts'

/** Returns the definitions in the flags file at `path`, relative to `root`. */
export function read(options: read.Options): Definitions.Definitions {
  const file = Path.resolve(options.root, options.path ?? defaultPath)
  const text = Fs.readFileSync(file, 'utf8')
  return Definitions.parseFile(text)
}

export declare namespace read {
  type Options = {
    path?: string | undefined
    root: string
  }
}

/** Writes `vexla.gen.ts` when its content changes. Returns `true` when it wrote the file. */
export function write(definitions: Definitions.Definitions, options: write.Options): boolean {
  const file = Path.resolve(options.root, options.out ?? defaultOut)
  const content = Definitions.generate(definitions, { visibility: options.visibility })
  const current = Fs.existsSync(file) ? Fs.readFileSync(file, 'utf8') : undefined
  if (current === content) return false
  Fs.writeFileSync(file, content)
  return true
}

export declare namespace write {
  type Options = {
    out?: string | undefined
    root: string
    visibility?: 'all' | 'public' | undefined
  }
}

/** Returns the values of build flags: `values` (such as store values), then `env`, then the default. */
export function buildValues(
  definitions: Definitions.Definitions,
  options: {
    env: Readonly<Record<string, string | undefined>>
    values?: Readonly<Record<string, unknown>> | undefined
  },
): Record<string, Definitions.Json> {
  const result: Record<string, Definitions.Json> = {}
  for (const [key, definition] of Object.entries(definitions)) {
    if (!definition.build) continue
    const stored = options.values?.[key]
    if (stored !== undefined && Definitions.validate(definition, stored)) {
      result[key] = stored
      continue
    }
    const raw = options.env[key]
    result[key] = raw === undefined ? definition.default : Definitions.decode(definition, raw, key)
  }
  return result
}
