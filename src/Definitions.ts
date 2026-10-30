/**
 * @module Flag definitions: the `.env.flags` file, validation of definition objects (the store and
 * the admin API), zero-config inference from `FEATURE_*` variables, the mapping between keys and
 * environment variables, the decoding of variable values, the manifest of the admin API, and the
 * generated `flargs.gen.ts` module.
 */
import * as EnvFile from './internal/EnvFile.js'
import * as Errors from './internal/Errors.js'

/** The type of a flag. */
export type Type = 'boolean' | 'json' | 'number' | 'select' | 'string'

/** A JSON value. */
export type Json =
  | boolean
  | number
  | string
  | null
  | readonly Json[]
  | { readonly [key: string]: Json }

/** One flag, as a flags file declares it after validation. */
export type Definition = {
  /** `true` for a build flag, which resolves when the bundle builds. */
  readonly build: boolean
  /** The value when no other source has one. */
  readonly default: Json
  /** The description, for the dev route, the admin API, and `.env.example`. */
  readonly description?: string | undefined
  /** The environment variable that sets the value. */
  readonly env: string
  /** The date (`YYYY-MM-DD`) after which the flag is due for retirement. */
  readonly expires?: string | undefined
  /** The values of a select flag. */
  readonly options?: readonly string[] | undefined
  /** `true` when the value may reach a browser. */
  readonly public: boolean
  /** The type of the value. */
  readonly type: Type
}

/** Every flag of a project, keyed by flag key. */
export type Definitions = { readonly [key: string]: Definition }

/** The value type of a definition: options for a select flag, the shape of the default for a JSON flag. */
export type Value<definition> = definition extends { readonly type: 'boolean' }
  ? boolean
  : definition extends { readonly type: 'number' }
    ? number
    : definition extends { readonly type: 'string' }
      ? string
      : definition extends { readonly options: readonly (infer option)[]; readonly type: 'select' }
        ? option
        : definition extends { readonly default: infer value; readonly type: 'json' }
          ? Widen<value>
          : unknown

/** The value types of definitions, keyed by flag key. */
export type Values<definitions> = { readonly [key in keyof definitions]: Value<definitions[key]> }

/** Widens literal types to their primitives, so a JSON default types the value, not one value. */
export type Widen<value> = value extends boolean
  ? boolean
  : value extends number
    ? number
    : value extends string
      ? string
      : value extends readonly (infer item)[]
        ? readonly Widen<item>[]
        : value extends object
          ? { readonly [key in keyof value]: Widen<value[key]> }
          : value

/** The JSON manifest of the admin API. */
export type Manifest = {
  readonly flags: Definitions
  readonly version: 1
}

/** The default prefix of flag environment variables. */
export const envPrefix = 'FEATURE_'

const fields = ['build', 'default', 'description', 'env', 'expires', 'options', 'public', 'type']
const types: readonly Type[] = ['boolean', 'json', 'number', 'select', 'string']

/**
 * Returns the definitions in a definition object, the format of the store and of the admin API.
 * Keys in `snake_case` map to `camelCase`. Every flag must declare `type` and `default`.
 *
 * @throws {InvalidDeclarationError} When a declaration does not follow the schema.
 */
export function parse(input: unknown, options: parse.Options = {}): Definitions {
  const prefix = options.envPrefix ?? envPrefix

  if (!isObject(input))
    throw new InvalidDeclarationError({ key: '(root)', reason: 'The flags file is not an object.' })

  const definitions: Record<string, Definition> = {}
  const envs = new Map<string, string>()

  for (const [name, declaration] of Object.entries(input)) {
    if (name === '$schema') continue

    const key = camelCase(name)
    const definition = declare(key, declaration, prefix)

    if (definitions[key])
      throw new InvalidDeclarationError({ key, reason: `The key ${key} is declared twice.` })

    const other = envs.get(definition.env)
    if (other)
      throw new InvalidDeclarationError({
        key,
        reason: `The flags ${other} and ${key} read the same variable ${definition.env}.`,
      })

    envs.set(definition.env, key)
    definitions[key] = definition
  }

  return definitions
}

export declare namespace parse {
  type Options = {
    /** The prefix of flag environment variables. @default 'FEATURE_' */
    envPrefix?: string | undefined
  }
}

/**
 * Returns the definitions in the text of `.env.flags`. Each `FEATURE_*` variable declares a flag,
 * and its value is the default. Comment lines directly above it hold the description and tags:
 *
 * - `@type {boolean}`, `{number}`, `{string}`, `{json}`, or a union of string literals such as
 *   `{'a' | 'b'}` for a select flag. Required.
 * - `@public`: the value may reach a browser.
 * - `@build`: the value resolves when the bundle builds.
 * - `@expires 2027-01-31`: the date after which the flag is due for retirement.
 *
 * Several tags may share a line. Comment lines without a tag form the description.
 *
 * @throws {InvalidDeclarationError} When a line or a declaration is invalid.
 */
export function parseFile(text: string, options: parseFile.Options = {}): Definitions {
  const prefix = options.envPrefix ?? envPrefix
  const scanned = EnvFile.scan(text)

  const invalid = scanned.invalid[0]
  if (invalid !== undefined)
    throw new InvalidDeclarationError({
      key: `line ${invalid}`,
      reason: `Line ${invalid} is not a comment or a NAME=value line.`,
    })

  const input: Record<string, unknown> = {}

  for (const entry of scanned.entries) {
    const fail = (key: string, reason: string) =>
      new InvalidDeclarationError({
        key,
        reason: `${reason.replace(/\.$/, '')} (line ${entry.line}).`,
      })

    if (!entry.name.startsWith(prefix) || entry.name.length === prefix.length)
      throw fail(entry.name, `The variable ${entry.name} does not start with ${prefix}.`)
    const key = keyOf(entry.name, prefix)

    const description: string[] = []
    const declaration: Record<string, unknown> = { env: entry.name }

    for (const comment of entry.comments) {
      const found = EnvFile.tags(comment)
      if (!found) {
        if (comment.trim() !== '') description.push(comment.trim())
        continue
      }

      for (const tag of found) {
        if (tag.name === 'type') {
          if (!tag.argument)
            throw fail(key, `\`@type\` of ${key} needs a type in braces, such as {boolean}.`)
          Object.assign(
            declaration,
            typeOf(tag.argument, () =>
              fail(key, `\`@type {${tag.argument}}\` of ${key} is not a flag type.`),
            ),
          )
        } else if (tag.name === 'public' || tag.name === 'build') {
          if (tag.argument !== undefined)
            throw fail(key, `\`@${tag.name}\` of ${key} takes no value.`)
          declaration[tag.name] = true
        } else if (tag.name === 'expires') {
          if (!tag.argument)
            throw fail(key, `\`@expires\` of ${key} needs a date in the form YYYY-MM-DD.`)
          declaration['expires'] = tag.argument
        } else throw fail(key, `The tag \`@${tag.name}\` of ${key} is not a Flargs tag.`)
      }
    }

    if (description.length > 0) declaration['description'] = description.join(' ')
    if (!('type' in declaration))
      throw fail(key, `The flag ${key} needs a \`@type\` tag, such as \`# @type {boolean}\`.`)

    declaration['default'] = (() => {
      const type = declaration['type']
      if (type === 'boolean')
        return entry.value === 'true' ? true : entry.value === 'false' ? false : entry.value
      if (type === 'number') return entry.value.trim() === '' ? entry.value : Number(entry.value)
      if (type === 'json') {
        try {
          return JSON.parse(entry.value) as unknown
        } catch {
          return undefined
        }
      }
      return entry.value
    })()

    if (key in input) throw fail(key, `The flag ${key} is declared twice.`)
    input[key] = declaration
  }

  try {
    return parse(input, { envPrefix: prefix })
  } catch (error) {
    if (error instanceof InvalidDeclarationError) {
      const entry = scanned.entries.find((entry) => keyOf(entry.name, prefix) === error.key)
      if (entry)
        throw new InvalidDeclarationError({
          key: error.key,
          reason: `${error.details.replace(/\.$/, '')} (line ${entry.line}).`,
        })
    }
    throw error
  }
}

export declare namespace parseFile {
  type Options = {
    /** The prefix of flag environment variables. @default 'FEATURE_' */
    envPrefix?: string | undefined
  }
}

/**
 * Returns `text` without the declaration of `key`: its comment lines, its variable, and one blank
 * line after it. Returns `text` unchanged when no variable declares `key`.
 */
export function removeFromFile(text: string, key: string, options: parseFile.Options = {}): string {
  const prefix = options.envPrefix ?? envPrefix
  const entry = EnvFile.scan(text).entries.find(
    (entry) => entry.name.startsWith(prefix) && keyOf(entry.name, prefix) === key,
  )
  if (!entry) return text

  const lines = text.split('\n')
  const end = lines[entry.end + 1]?.trim() === '' ? entry.end + 2 : entry.end + 1
  lines.splice(entry.start, end - entry.start)
  return lines.join('\n')
}

/**
 * Returns definitions for each `FEATURE_*` variable in `env`, for a project with no flags file.
 * Each flag is private. `true` and `false` make a boolean, a number makes a number, a JSON object
 * or array makes a JSON flag, and other values make a string. The value is also the default.
 */
export function fromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: fromEnv.Options = {},
): Definitions {
  const prefix = options.envPrefix ?? envPrefix
  const definitions: Record<string, Definition> = {}

  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith(prefix) || name.length === prefix.length || raw === undefined) continue

    const key = keyOf(name, prefix)
    const value = infer(raw)
    definitions[key] = {
      build: false,
      default: value.value,
      env: name,
      public: false,
      type: value.type,
    }
  }

  return definitions
}

export declare namespace fromEnv {
  type Options = {
    /** The prefix of flag environment variables. @default 'FEATURE_' */
    envPrefix?: string | undefined
  }
}

/** Returns the environment variable of a key: `newCheckout` reads `FEATURE_NEW_CHECKOUT`. */
export function envOf(key: string, prefix: string = envPrefix): string {
  return prefix + key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
}

/** Returns the key of an environment variable: `FEATURE_NEW_CHECKOUT` is `newCheckout`. */
export function keyOf(name: string, prefix: string = envPrefix): string {
  return camelCase(name.slice(prefix.length).toLowerCase())
}

/**
 * Returns the value that `raw`, the text of an environment variable or a search parameter, holds
 * for `definition`.
 *
 * @throws {InvalidValueError} When `raw` is not a value of the flag. The error never holds `raw`.
 */
export function decode(definition: Definition, raw: string, key: string): Json {
  const value = (() => {
    if (definition.type === 'boolean')
      return raw === 'true' ? true : raw === 'false' ? false : undefined
    if (definition.type === 'number') {
      const number = raw.trim() === '' ? Number.NaN : Number(raw)
      return Number.isFinite(number) ? number : undefined
    }
    if (definition.type === 'json') {
      try {
        return JSON.parse(raw) as Json
      } catch {
        return undefined
      }
    }
    return raw
  })()

  if (value === undefined || !validate(definition, value))
    throw new InvalidValueError({ env: definition.env, key, type: definition.type })
  return value
}

/** Returns the text of `value` in an environment variable or a search parameter. */
export function encode(value: Json): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** Returns `true` when `value` is a value of the flag. */
export function validate(definition: Definition, value: unknown): value is Json {
  if (definition.type === 'boolean') return typeof value === 'boolean'
  if (definition.type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (definition.type === 'string') return typeof value === 'string'
  if (definition.type === 'select')
    return typeof value === 'string' && (definition.options ?? []).includes(value)
  return isJson(value)
}

/** Returns `true` when the `expires` date of the flag is before `now`. */
export function isStale(definition: Definition, now: number = Date.now()): boolean {
  if (!definition.expires) return false
  return Date.parse(`${definition.expires}T00:00:00Z`) + 86_400_000 <= now
}

/** A problem that {@link check} found in an environment. */
export type Issue = {
  /** The environment variable. */
  readonly env: string
  /** The key of the flag, when a flag declares the variable. */
  readonly key?: string | undefined
  /** `invalid`: the value is not a value of the flag. `stale`: the flag is past `expires`. `unknown`: no flag declares the variable. */
  readonly reason: 'invalid' | 'stale' | 'unknown'
}

/**
 * Returns the problems of `env` against `definitions`: `FEATURE_*` variables that no flag declares,
 * values that are not values of their flag, and flags past their `expires` date.
 */
export function check(
  definitions: Definitions,
  env: Readonly<Record<string, string | undefined>>,
  options: check.Options = {},
): readonly Issue[] {
  const prefix = options.envPrefix ?? envPrefix
  const declared = new Map(Object.entries(definitions).map((entry) => [entry[1].env, entry[0]]))
  const issues: Issue[] = []

  for (const [name, raw] of Object.entries(env).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (raw === undefined) continue

    const key = declared.get(name)
    if (!key) {
      if (name.startsWith(prefix)) issues.push({ env: name, reason: 'unknown' })
      continue
    }

    try {
      decode(definitions[key]!, raw, key)
    } catch {
      issues.push({ env: name, key, reason: 'invalid' })
    }
  }

  for (const [key, definition] of Object.entries(definitions))
    if (isStale(definition, options.now)) issues.push({ env: definition.env, key, reason: 'stale' })

  return issues
}

export declare namespace check {
  type Options = {
    /** The prefix of flag environment variables. @default 'FEATURE_' */
    envPrefix?: string | undefined
    /** The current time, in milliseconds since the epoch. @default Date.now() */
    now?: number | undefined
  }
}

/**
 * Returns the values that `env` sets for declared flags. A variable that a flag does not declare
 * is ignored here. {@link check} reports it.
 *
 * @throws {InvalidValueError} When a variable holds a value that is not a value of its flag.
 */
export function values(
  definitions: Definitions,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, Json> {
  const result: Record<string, Json> = {}

  for (const [key, definition] of Object.entries(definitions)) {
    const raw = env[definition.env]
    if (raw !== undefined) result[key] = decode(definition, raw, key)
  }

  return result
}

/** Returns the manifest of the admin API. */
export function manifest(definitions: Definitions): Manifest {
  return { flags: definitions, version: 1 }
}

/** Returns the definitions of public flags only. */
export function publicOf(definitions: Definitions): Definitions {
  return Object.fromEntries(Object.entries(definitions).filter((entry) => entry[1].public))
}

/**
 * Returns `define` replacements for build flags, for Vite, esbuild, Rollup, and zile. Each value
 * resolves from `values`, then its variable in `env`, then the default.
 */
export function defines(
  definitions: Definitions,
  options: defines.Options = {},
): Record<string, string> {
  const identifier = options.identifier ?? 'flags'
  const result: Record<string, string> = {}

  for (const [key, definition] of Object.entries(definitions)) {
    if (!definition.build) continue

    const value = (() => {
      const value = options.values?.[key]
      if (value !== undefined) return value
      const raw = options.env?.[definition.env]
      if (raw !== undefined) return decode(definition, raw, key)
      return definition.default
    })()

    result[`${identifier}.${key}`] = JSON.stringify(value)
  }

  return result
}

export declare namespace defines {
  type Options = {
    /** The environment of the build. */
    env?: Readonly<Record<string, string | undefined>> | undefined
    /** The name of the values object in source. @default 'flags' */
    identifier?: string | undefined
    /** Values that take precedence over `env`, such as store values. */
    values?: Readonly<Record<string, Json>> | undefined
  }
}

/** Returns the source of `flargs.gen.ts`: the definitions and the `Register` declaration. */
export function generate(definitions: Definitions, options: generate.Options = {}): string {
  const selected = options.visibility === 'public' ? publicOf(definitions) : definitions

  return [
    '// Generated by flargs. Do not edit.',
    '',
    `export const definitions = ${JSON.stringify(selected, null, 2)} as const`,
    '',
    "declare module 'flargs' {",
    '  interface Register {',
    '    definitions: typeof definitions',
    '  }',
    '}',
    '',
  ].join('\n')
}

export declare namespace generate {
  type Options = {
    /** `public` declares public flags only, for a client in another repository. @default 'all' */
    visibility?: 'all' | 'public' | undefined
  }
}

/** Thrown when a declaration in a flags file does not follow the schema. */
export class InvalidDeclarationError extends Errors.BaseError {
  override name = 'Definitions.InvalidDeclarationError'

  /** The key of the flag. */
  readonly key: string

  constructor(options: InvalidDeclarationError.Options) {
    super(options.reason, {
      steps: [
        `Fix the declaration of ${options.key} in \`.env.flags\`, or in the store definition.`,
      ],
    })
    this.key = options.key
  }
}

export declare namespace InvalidDeclarationError {
  type Options = {
    key: string
    reason: string
  }
}

/** Thrown when an environment variable or an override holds a value that is not a value of its flag. */
export class InvalidValueError extends Errors.BaseError {
  override name = 'Definitions.InvalidValueError'

  /** The environment variable. */
  readonly env: string
  /** The key of the flag. */
  readonly key: string

  constructor(options: InvalidValueError.Options) {
    super(
      `The value for ${options.key} (${options.env}) is not a ${options.type} value of the flag.`,
      {
        steps: [
          `Set ${options.env} to a value of the flag, as its declaration in the flags file describes.`,
        ],
      },
    )
    this.env = options.env
    this.key = options.key
  }
}

export declare namespace InvalidValueError {
  type Options = {
    env: string
    key: string
    type: Type
  }
}

function declare(key: string, declaration: unknown, prefix: string): Definition {
  const fail = (reason: string) => new InvalidDeclarationError({ key, reason })

  if (!isObject(declaration)) throw fail(`The declaration of ${key} is not an object.`)

  for (const field of Object.keys(declaration))
    if (!fields.includes(field))
      throw fail(`The declaration of ${key} has an unknown field ${field}.`)

  const type = declaration['type']
  if (typeof type !== 'string' || !types.includes(type as Type))
    throw fail(`The declaration of ${key} needs a \`type\`: ${types.join(', ')}.`)
  if (!('default' in declaration)) throw fail(`The declaration of ${key} needs a \`default\`.`)

  const options = (() => {
    const options = declaration['options']
    if (type !== 'select') {
      if (options !== undefined)
        throw fail(`Only a select flag declares \`options\`, and ${key} is a ${type} flag.`)
      return undefined
    }
    if (
      !Array.isArray(options) ||
      options.length === 0 ||
      !options.every((option) => typeof option === 'string') ||
      new Set(options).size !== options.length
    )
      throw fail(`The select flag ${key} needs \`options\`: a list of distinct strings.`)
    return options as readonly string[]
  })()

  const boolean = (field: 'build' | 'public') => {
    const value = declaration[field]
    if (value === undefined) return false
    if (typeof value !== 'boolean') throw fail(`\`${field}\` of ${key} is not a boolean.`)
    return value
  }

  const description = declaration['description']
  if (description !== undefined && typeof description !== 'string')
    throw fail(`\`description\` of ${key} is not a string.`)

  const env = declaration['env'] ?? envOf(key, prefix)
  if (typeof env !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(env))
    throw fail(`\`env\` of ${key} is not a variable name in SCREAMING_SNAKE_CASE.`)

  const expires = declaration['expires']
  if (
    expires !== undefined &&
    (typeof expires !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(expires) ||
      Number.isNaN(Date.parse(`${expires}T00:00:00Z`)))
  )
    throw fail(`\`expires\` of ${key} is not a date in the form YYYY-MM-DD.`)

  const definition: Definition = {
    build: boolean('build'),
    default: declaration['default'] as Json,
    ...(description !== undefined ? { description } : {}),
    env,
    ...(expires !== undefined ? { expires } : {}),
    ...(options ? { options } : {}),
    public: boolean('public'),
    type: type as Type,
  }

  if (!validate(definition, definition.default))
    throw fail(
      type === 'select'
        ? `The default of ${key} is not one of its options.`
        : `The default of ${key} is not a ${type} value.`,
    )

  return definition
}

// Maps the text in the braces of `@type` to a type, and the options of a select flag.
function typeOf(text: string, fail: () => Error): { options?: string[]; type: Type } {
  const type = text.trim()
  if (type === 'boolean' || type === 'json' || type === 'number' || type === 'string')
    return { type }

  const options = type.split('|').map((part) => {
    const match = /^\s*(['"])(.*)\1\s*$/.exec(part)
    if (!match) throw fail()
    return match[2]!
  })
  return { options, type: 'select' }
}

function infer(raw: string): { type: Type; value: Json } {
  if (raw === 'true' || raw === 'false') return { type: 'boolean', value: raw === 'true' }
  if (/^-?\d+(\.\d+)?$/.test(raw)) return { type: 'number', value: Number(raw) }
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return { type: 'json', value: JSON.parse(raw) as Json }
    } catch {}
  }
  return { type: 'string', value: raw }
}

function camelCase(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase())
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJson(value: unknown): value is Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJson)
  if (isObject(value)) return Object.values(value).every(isJson)
  return false
}
