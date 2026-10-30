/**
 * @module The runtime instance: resolves flag values for each request (override, store value,
 * `decide`, then the default), and serves the dev route and the admin API as a fetch handler.
 */
import * as Definitions from '../Definitions.js'
import type { Registered } from '../index.js'
import * as Errors from '../internal/Errors.js'
import * as Json from '../internal/Json.js'
import * as Override from '../Override.js'
import * as Page from './internal/Page.js'
import type * as Store from './Store.js'

/** The access of an admin request, as `authorize` returns it. */
export type Access = 'read' | 'write' | undefined

/** Where a value came from. */
export type Source = 'decide' | 'default' | 'env' | 'override' | 'store'

/** The runtime instance. */
export type Flargs<definitions = Registered> = {
  /** Returns the definitions: `definitions`, or the store definitions, or zero config from `env`. */
  definitions: () => Promise<Definitions.Definitions>
  /** Returns every value for `request`. `visibility: 'public'` returns public flags only. */
  evaluate: (
    request: Request,
    options?: { visibility?: 'all' | 'public' | undefined },
  ) => Promise<Definitions.Values<definitions>>
  /** Serves the dev route and the admin API under `path`, and returns `404` outside it. */
  fetch: (request: Request) => Promise<Response>
  /** Returns one value for `request`, and runs `decide` for that flag only. */
  get: <key extends keyof definitions & string>(
    request: Request,
    key: key,
  ) => Promise<Definitions.Value<definitions[key]>>
  /** The path of the dev route and the admin API. */
  path: string
  /** Returns a `<script>` element with the public values for `request`, for the HTML of a page. */
  script: (request: Request) => Promise<string>
  /** Returns the `Set-Cookie` value that stores the overrides in the search parameters of `request`, if any. */
  setCookie: (request: Request) => Promise<string | undefined>
}

/** Returns a runtime instance. It listens on no port: `fetch` is a fetch handler. */
export function create<
  const definitions extends Definitions.Definitions = Registered & Definitions.Definitions,
>(options: create.Options<definitions> = {}): Flargs<definitions> {
  const path = (options.path ?? '/.flags').replace(/\/$/, '')
  const dev = options.dev ?? false
  const env = options.env ?? globalThis.process?.env ?? {}
  const envPrefix = options.envPrefix ?? Definitions.envPrefix
  const onError = options.onError ?? (() => {})

  if (!dev && !options.secret)
    throw new TypeError(
      '`Flargs.create` needs `secret` outside dev mode. Set `secret`, such as from `FLARGS_SECRET`.',
    )

  // Definitions from the store are read once, and again after a write through this runtime.
  let cached: Promise<Definitions.Definitions> | undefined

  const definitions = (): Promise<Definitions.Definitions> => {
    if (options.definitions) return Promise.resolve(options.definitions)
    if (!options.store?.definitions) return Promise.resolve(Definitions.fromEnv(env, { envPrefix }))

    cached ??= (async () => {
      try {
        return Definitions.parse(await options.store!.definitions!.list(), { envPrefix })
      } catch (cause) {
        cached = undefined
        throw new DefinitionsUnavailableError({ cause })
      }
    })()
    return cached
  }

  // One state for each request: definitions, context, overrides, and store values.
  const states = new WeakMap<Request, Promise<State>>()
  const values = new WeakMap<Request, Map<string, Promise<Resolved>>>()

  const state = (request: Request): Promise<State> => {
    let promise = states.get(request)
    if (promise) return promise

    promise = (async () => {
      const defs = await definitions()
      const overrides = await readOverrides(request, defs)
      const keys = Object.keys(defs)
      const stored = options.store
        ? await options.store.get(keys).catch((error: unknown) => (onError(error), {}))
        : {}
      const context = options.identify ? await options.identify(request) : undefined
      return { context, definitions: defs, overrides, stored }
    })()
    states.set(request, promise)
    return promise
  }

  const readOverrides = async (
    request: Request,
    defs: Definitions.Definitions,
  ): Promise<Record<string, Definitions.Json>> => {
    const result: Record<string, Definitions.Json> = {}

    // The cookie holds overrides that this runtime wrote, so a valid cookie applies to private flags.
    const raw = readCookie(request.headers.get('cookie'), Override.cookie)
    if (raw !== undefined) {
      try {
        const overrides = await Override.parse(raw, {
          definitions: defs,
          dev,
          secret: options.secret,
        })
        if (overrides.signed || dev) Object.assign(result, overrides.values)
        for (const error of overrides.errors) onError(error)
      } catch (error) {
        onError(error)
      }
    }

    // Search parameters take precedence over the cookie.
    try {
      const overrides = await Override.parse(new URL(request.url), {
        definitions: defs,
        dev,
        secret: options.secret,
      })
      if (overrides.reset) for (const key of Object.keys(result)) delete result[key]
      Object.assign(result, overrides.values)
      for (const error of overrides.errors) onError(error)
    } catch (error) {
      onError(error)
    }

    return result
  }

  const resolve = (request: Request, key: string): Promise<Resolved> => {
    let cache = values.get(request)
    if (!cache) {
      cache = new Map()
      values.set(request, cache)
    }

    const existing = cache.get(key)
    if (existing) return existing

    const promise = (async (): Promise<Resolved> => {
      const current = await state(request)
      const definition = current.definitions[key]
      if (!definition) throw new UnknownFlagError({ key })

      if (key in current.overrides) return { source: 'override', value: current.overrides[key]! }

      const fallback = (() => {
        const raw = env[definition.env]
        if (raw === undefined) return { source: 'default' as const, value: definition.default }
        try {
          return { source: 'env' as const, value: Definitions.decode(definition, raw, key) }
        } catch (error) {
          onError(error)
          return { source: 'default' as const, value: definition.default }
        }
      })()

      const stored = current.stored[key]
      if (stored !== undefined) {
        const value = coerce(definition, stored, key)
        if (value !== undefined) return { source: 'store', value }
        onError(
          new Definitions.InvalidValueError({ env: definition.env, key, type: definition.type }),
        )
      }

      if (definition.build) return fallback

      const decide = (options.decide as Record<string, unknown> | undefined)?.[key]
      if (decide) {
        try {
          const value = await (decide as (context: unknown) => unknown)(current.context)
          if (value !== undefined) {
            if (Definitions.validate(definition, value)) return { source: 'decide', value }
            onError(
              new Definitions.InvalidValueError({
                env: definition.env,
                key,
                type: definition.type,
              }),
            )
          }
        } catch (error) {
          onError(error)
        }
      }

      return fallback
    })()

    cache.set(key, promise)
    return promise
  }

  const evaluate = async (
    request: Request,
    evaluateOptions: { visibility?: 'all' | 'public' | undefined } = {},
  ) => {
    const current = await state(request)
    const entries = Object.entries(current.definitions).filter(
      (entry) => evaluateOptions.visibility !== 'public' || entry[1].public,
    )
    const result: Record<string, Definitions.Json> = {}
    for (const [key] of entries) result[key] = (await resolve(request, key)).value
    return result
  }

  const authorize = async (request: Request): Promise<Access | Response> => {
    if (dev) return 'write'
    if (!options.authorize) return undefined
    try {
      return await options.authorize(request)
    } catch (error) {
      onError(error)
      return undefined
    }
  }

  const cookieValue = async (
    overrides: Readonly<Record<string, Definitions.Json>>,
  ): Promise<string> => {
    if (Object.keys(overrides).length === 0)
      return `${Override.cookie}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${dev ? '' : '; Secure'}`

    const maxAge = 30 * 24 * 60 * 60
    const params = await Override.serialize(
      overrides,
      options.secret
        ? { expiresAt: (options.now?.() ?? Date.now()) + maxAge * 1000, secret: options.secret }
        : {},
    )
    return `${Override.cookie}=${encodeURIComponent(params.toString())}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${dev ? '' : '; Secure'}`
  }

  const flargs: Flargs<definitions> = {
    definitions,
    evaluate: evaluate as Flargs<definitions>['evaluate'],

    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== path && !url.pathname.startsWith(`${path}/`))
        return json(404, { error: 'not_found' })

      const route = url.pathname.slice(path.length).replace(/^\//, '')
      const segments = route === '' ? [] : route.split('/').map(decodeURIComponent)
      const method = request.method.toUpperCase()

      // The values endpoint is public, and returns public flags only.
      if (segments[0] === 'values' && segments.length === 1) {
        const headers = corsHeaders(request, options.cors)
        if (method === 'OPTIONS') return new Response(null, { headers, status: 204 })
        if (method !== 'GET') return json(405, { error: 'method_not_allowed' })
        return json(200, await evaluate(request, { visibility: 'public' }), headers)
      }

      const access = await authorize(request)
      if (access instanceof Response) return access
      if (access === undefined) return json(401, { error: 'unauthorized' })

      const required = (() => {
        if (segments.length === 0 || segments[0] === 'manifest') return 'read'
        if (segments[0] === 'overrides') return 'read'
        return 'write'
      })()
      if (required === 'write' && access !== 'write') return json(403, { error: 'forbidden' })

      try {
        return await serve(request, method, segments, access)
      } catch (error) {
        if (error instanceof DefinitionsUnavailableError)
          return json(503, { error: 'definitions_unavailable' })
        throw error
      }
    },

    async get(request, key) {
      return (await resolve(request, key)).value as never
    },

    path,

    async script(request) {
      const values = await evaluate(request, { visibility: 'public' })
      return `<script type="application/json" id="__flargs">${Json.safe(values)}</script>`
    },

    async setCookie(request) {
      const url = new URL(request.url)
      if (![...url.searchParams.keys()].some((name) => name.startsWith(Override.prefix)))
        return undefined
      const current = await state(request)
      return cookieValue(current.overrides)
    },
  }

  const serve = async (
    request: Request,
    method: string,
    segments: readonly string[],
    access: 'read' | 'write',
  ) => {
    const [resource, key] = segments

    if (resource === undefined) {
      if (method !== 'GET') return json(405, { error: 'method_not_allowed' })
      return new Response(Page.html({ path, write: access === 'write' }), {
        headers: { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' },
      })
    }

    if (resource === 'manifest' && segments.length === 1) {
      if (method !== 'GET') return json(405, { error: 'method_not_allowed' })
      const current = await state(request)
      const flags: Record<string, unknown> = {}
      for (const [flag, definition] of Object.entries(current.definitions)) {
        const resolved = await resolve(request, flag)
        flags[flag] = {
          ...definition,
          override: current.overrides[flag] ?? null,
          source: resolved.source,
          stale: Definitions.isStale(definition, options.now?.()),
          store: current.stored[flag] ?? null,
          value: resolved.value,
        }
      }
      const orphans = options.store?.keys
        ? (await options.store.keys()).filter((key) => !(key in current.definitions)).sort()
        : null
      return json(200, {
        flags,
        orphans,
        store: Boolean(options.store),
        storeDefinitions: !options.definitions && Boolean(options.store?.definitions),
        version: 1,
      })
    }

    if (resource === 'values' && key !== undefined && segments.length === 2) {
      if (!options.store) return json(501, { error: 'no_store' })
      const definition = (await definitions())[key]

      // An orphan value, of a flag that no longer exists, may be deleted.
      if (method === 'DELETE' && (definition || (await options.store.keys?.())?.includes(key))) {
        await options.store.delete(key)
        return json(200, { key })
      }
      if (!definition) return json(404, { error: 'unknown_flag' })
      if (method !== 'PUT') return json(405, { error: 'method_not_allowed' })

      const body = await readJson(request)
      const value = body?.['value']
      if (!Definitions.validate(definition, value))
        return json(400, { error: 'invalid_value', key })
      await options.store.set(key, value)
      return json(200, { key, value })
    }

    if (resource === 'definitions' && key !== undefined && segments.length === 2) {
      if (options.definitions) return json(409, { error: 'definitions_in_file' })
      const store = options.store?.definitions
      if (!store) return json(501, { error: 'no_store_definitions' })

      if (method === 'DELETE') {
        await store.delete(key)
        cached = undefined
        return json(200, { key })
      }
      if (method !== 'PUT') return json(405, { error: 'method_not_allowed' })

      const body = await readJson(request)
      const parsed = (() => {
        try {
          return Definitions.parse({ [key]: body }, { envPrefix })[key]
        } catch (error) {
          return error as Definitions.InvalidDeclarationError
        }
      })()
      if (!parsed || parsed instanceof Error)
        return json(400, {
          error: 'invalid_definition',
          message: parsed?.details ?? 'Invalid definition.',
        })

      await store.set(key, parsed)
      cached = undefined
      return json(200, { definition: parsed, key })
    }

    if (resource === 'overrides' && segments.length === 1) {
      if (method === 'DELETE') return json(200, {}, { 'set-cookie': await cookieValue({}) })
      if (method !== 'PUT') return json(405, { error: 'method_not_allowed' })

      const body = await readJson(request)
      const input = body?.['values']
      if (typeof input !== 'object' || input === null || Array.isArray(input))
        return json(400, { error: 'invalid_body' })

      // An admin request may preview private flags, so overrides from this route count as signed.
      const defs = await definitions()
      const accepted: Record<string, Definitions.Json> = {}
      for (const [flag, value] of Object.entries(input)) {
        const definition = defs[flag]
        if (!definition) return json(404, { error: 'unknown_flag', key: flag })
        if (definition.build && !dev) return json(400, { error: 'build_flag', key: flag })
        if (!Definitions.validate(definition, value))
          return json(400, { error: 'invalid_value', key: flag })
        accepted[flag] = value
      }
      return json(200, { values: accepted }, { 'set-cookie': await cookieValue(accepted) })
    }

    if (resource === 'links' && segments.length === 1) {
      if (method !== 'POST') return json(405, { error: 'method_not_allowed' })
      if (!options.secret) return json(501, { error: 'no_secret' })

      const body = await readJson(request)
      const input = body?.['values']
      const target = body?.['url']
      const expiresAt = body?.['expiresAt']
      if (
        typeof input !== 'object' ||
        input === null ||
        Array.isArray(input) ||
        typeof target !== 'string' ||
        typeof expiresAt !== 'number'
      )
        return json(400, { error: 'invalid_body' })

      const defs = await definitions()
      for (const [flag, value] of Object.entries(input)) {
        const definition = defs[flag]
        if (!definition) return json(404, { error: 'unknown_flag', key: flag })
        if (definition.build) return json(400, { error: 'build_flag', key: flag })
        if (!Definitions.validate(definition, value))
          return json(400, { error: 'invalid_value', key: flag })
      }

      const link = new URL(target, request.url)
      const params = await Override.serialize(input as Record<string, Definitions.Json>, {
        expiresAt,
        secret: options.secret,
      })
      for (const [name, value] of params) link.searchParams.set(name, value)
      return json(200, { url: link.toString() })
    }

    return json(404, { error: 'not_found' })
  }

  return flargs
}

export declare namespace create {
  type Options<definitions extends Definitions.Definitions = Definitions.Definitions> = {
    /**
     * Returns the access of an admin request: `'read'`, `'write'`, `undefined` for no access, or a
     * `Response` that the admin route returns, such as a `401` challenge. Default: no access
     * outside dev mode. In dev mode, every request has `'write'` and `authorize` does not run.
     */
    authorize?: ((request: Request) => Access | Response | Promise<Access | Response>) | undefined
    /** Origins that receive CORS headers on the values endpoint. Admin routes return none. */
    cors?: { origins: readonly string[] } | undefined
    /** Functions keyed by flag, which return a value from the `identify` context, or `undefined` to fall through. */
    decide?:
      | {
          readonly [key in keyof definitions as definitions[key] extends { readonly build: true }
            ? never
            : key]?: (
            context: any,
          ) =>
            | Definitions.Value<definitions[key]>
            | undefined
            | Promise<Definitions.Value<definitions[key]> | undefined>
        }
      | undefined
    /** The definitions, from `flargs.gen.ts` or `Definitions.parse`. Without them, the store holds the definitions. */
    definitions?: definitions | undefined
    /** Dev mode: every flag accepts an unsigned override, and the dev route is open. @default false */
    dev?: boolean | undefined
    /** The environment, for `FEATURE_*` values. @default process.env */
    env?: Readonly<Record<string, string | undefined>> | undefined
    /** The prefix of flag environment variables. @default 'FEATURE_' */
    envPrefix?: string | undefined
    /** Returns the context that `decide` receives, such as the user of the request. */
    identify?: ((request: Request) => unknown) | undefined
    /** The current time, in milliseconds since the epoch. @default Date.now */
    now?: (() => number) | undefined
    /** Receives invalid overrides, store values, `decide` errors, and `authorize` errors. */
    onError?: ((error: unknown) => void) | undefined
    /** The path of the dev route and the admin API. @default '/.flags' */
    path?: string | undefined
    /** The HMAC secret for overrides and links, such as `FLARGS_SECRET`. Required outside dev mode. */
    secret?: string | undefined
    /** The store for admin values, and optionally for definitions. */
    store?: Store.Store | undefined
  }
}

/** Thrown when the store cannot return its definitions. With no definitions, no default exists. */
export class DefinitionsUnavailableError extends Errors.BaseError {
  override name = 'Flargs.DefinitionsUnavailableError'

  constructor(options: { cause: unknown }) {
    super('The store did not return the flag definitions.', {
      cause: options.cause,
      steps: ['Check the connection to the store, or declare the flags in a flags file.'],
    })
  }
}

/** Thrown when a read names a key that no flag declares. */
export class UnknownFlagError extends Errors.BaseError {
  override name = 'Flargs.UnknownFlagError'

  /** The key. */
  readonly key: string

  constructor(options: { key: string }) {
    super(`No flag declares the key ${options.key}.`, {
      steps: ['Check the key against the flags file, and run `flargs generate` after a change.'],
    })
    this.key = options.key
  }
}

type Resolved = { source: Source; value: Definitions.Json }

type State = {
  context: unknown
  definitions: Definitions.Definitions
  overrides: Record<string, Definitions.Json>
  stored: Record<string, unknown>
}

// A store over environment variables holds text, so text decodes for a non-string flag.
function coerce(
  definition: Definitions.Definition,
  value: unknown,
  key: string,
): Definitions.Json | undefined {
  if (Definitions.validate(definition, value)) return value
  if (typeof value !== 'string') return undefined
  try {
    return Definitions.decode(definition, value, key)
  } catch {
    return undefined
  }
}

function corsHeaders(
  request: Request,
  cors: { origins: readonly string[] } | undefined,
): Record<string, string> {
  const origin = request.headers.get('origin')
  if (!cors || !origin || !cors.origins.includes(origin)) return {}
  return {
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-origin': origin,
    vary: 'origin',
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json', ...headers },
    status,
  })
}

async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body = (await request.json()) as unknown
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index !== -1 && part.slice(0, index).trim() === name)
      return decodeURIComponent(part.slice(index + 1).trim())
  }
  return undefined
}
