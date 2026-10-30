/**
 * @module Stores: where the admin API keeps flag values, and optionally flag definitions, so a
 * value applies to every request. A host implements `Store` on its own database.
 */
import * as Definitions from '../Definitions.js'
import * as Errors from '../internal/Errors.js'

/** The store contract. A host implements it on its own database, such as a Postgres table. */
export type Store = {
  /** Deletes the value of a flag. */
  delete: (key: string) => Promise<void>
  /** Returns the values of `keys` that the store holds. A key with no value is absent. */
  get: (keys: readonly string[]) => Promise<Record<string, unknown>>
  /** Returns every key that holds a value. Optional: `flargs prune` needs it to find orphan values. */
  keys?: (() => Promise<readonly string[]>) | undefined
  /** Sets the value of a flag. The runtime validates `value` before the call. */
  set: (key: string, value: Definitions.Json) => Promise<void>
  /**
   * Definition operations. Required only when `Flargs.create` has no `definitions`, so the store
   * declares the flags.
   */
  definitions?:
    | {
        /** Deletes the definition of a flag. */
        delete: (key: string) => Promise<void>
        /** Returns every definition, in the format of a flags file. */
        list: () => Promise<Record<string, unknown>>
        /** Creates or replaces the definition of a flag. */
        set: (key: string, definition: Definitions.Definition) => Promise<void>
      }
    | undefined
}

/** Returns a store in memory, for dev mode and tests. It holds values and definitions. */
export function memory(options: memory.Options = {}): Store {
  const values = new Map<string, Definitions.Json>(Object.entries(options.values ?? {}))
  const definitions = new Map<string, unknown>(Object.entries(options.definitions ?? {}))

  return {
    async delete(key) {
      values.delete(key)
    },
    definitions: {
      async delete(key) {
        definitions.delete(key)
        values.delete(key)
      },
      async list() {
        return Object.fromEntries(definitions)
      },
      async set(key, definition) {
        definitions.set(key, definition)
      },
    },
    async get(keys) {
      return Object.fromEntries(
        keys.filter((key) => values.has(key)).map((key) => [key, values.get(key)]),
      )
    },
    async keys() {
      return [...values.keys()]
    },
    async set(key, value) {
      values.set(key, value)
    },
  }
}

export declare namespace memory {
  type Options = {
    /** Definitions to start with, in the format of a flags file. */
    definitions?: Record<string, unknown> | undefined
    /** Values to start with. */
    values?: Record<string, Definitions.Json> | undefined
  }
}

/**
 * Returns a store over environment variables, read only. A flag reads the variable of the same name. It holds no definitions. A write throws
 * `ReadOnlyError`.
 */
export function env(variables: Readonly<Record<string, string | undefined>>): Store {
  return {
    async delete(key) {
      throw new ReadOnlyError({ key })
    },
    async get(keys) {
      return Object.fromEntries(
        keys.flatMap((key) => {
          const raw = variables[key]
          return raw === undefined ? [] : [[key, raw]]
        }),
      )
    },
    async set(key) {
      throw new ReadOnlyError({ key })
    },
  }
}

/**
 * Returns a store over the admin API of another Flargs runtime, such as a central admin service.
 * Reads cache the manifest for `ttl` milliseconds. Writes go through at once and clear the cache.
 */
export function http(options: http.Options): Store {
  const base = options.url.replace(/\/$/, '')
  const fetch = options.fetch ?? globalThis.fetch
  const ttl = options.ttl ?? 5_000
  let cache: { expiresAt: number; manifest: Promise<Manifest> } | undefined

  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      method,
    })
    if (!response.ok) throw new HttpError({ method, path, status: response.status })
    return (await response.json()) as unknown
  }

  const manifest = () => {
    const now = Date.now()
    if (!cache || cache.expiresAt <= now) {
      const promise = request('GET', '/manifest') as Promise<Manifest>
      cache = { expiresAt: now + ttl, manifest: promise }
      promise.catch(() => (cache = undefined))
    }
    return cache.manifest
  }

  const write = async (method: string, path: string, body?: unknown) => {
    cache = undefined
    await request(method, path, body)
  }

  return {
    delete: (key) => write('DELETE', `/values/${encodeURIComponent(key)}`),
    definitions: {
      delete: (key) => write('DELETE', `/definitions/${encodeURIComponent(key)}`),
      async list() {
        const fields = [
          'build',
          'default',
          'description',
          'env',
          'expires',
          'options',
          'public',
          'type',
        ]
        return Object.fromEntries(
          Object.entries((await manifest()).flags).map((entry) => [
            entry[0],
            Object.fromEntries(
              Object.entries(entry[1]).filter((field) => fields.includes(field[0])),
            ),
          ]),
        )
      },
      set: (key, definition) => write('PUT', `/definitions/${encodeURIComponent(key)}`, definition),
    },
    async get(keys) {
      const flags = (await manifest()).flags
      return Object.fromEntries(
        keys.flatMap((key) => {
          const stored = flags[key]?.['store']
          return stored === null || stored === undefined ? [] : [[key, stored]]
        }),
      )
    },
    async keys() {
      const current = await manifest()
      return [
        ...Object.entries(current.flags)
          .filter((entry) => entry[1]['store'] !== null && entry[1]['store'] !== undefined)
          .map((entry) => entry[0]),
        ...(current.orphans ?? []),
      ]
    },
    set: (key, value) => write('PUT', `/values/${encodeURIComponent(key)}`, { value }),
  }
}

export declare namespace http {
  type Options = {
    /** The fetch function. @default globalThis.fetch */
    fetch?: typeof globalThis.fetch | undefined
    /** A bearer token that the remote `authorize` accepts. */
    token?: string | undefined
    /** The lifetime of a cached manifest, in milliseconds. @default 5000 */
    ttl?: number | undefined
    /** The URL of the remote admin API, such as `https://api.example.com/.flags`. */
    url: string
  }
}

/** The part of a Cloudflare KV namespace that `kv` uses. */
export type KvNamespace = {
  delete: (key: string) => Promise<void>
  get: (key: string, type: 'json') => Promise<unknown>
  list: (options: { cursor?: string | undefined; prefix: string }) => Promise<{
    cursor?: string | undefined
    keys: readonly { name: string }[]
    list_complete: boolean
  }>
  put: (key: string, value: string) => Promise<void>
}

/**
 * Returns a store on a Cloudflare KV namespace. Values live under `value:<key>`, and definitions
 * under `definition:<key>`. KV is eventually consistent, so a write can take up to a minute to
 * reach every location.
 */
export function kv(namespace: KvNamespace): Store {
  const list = async (prefix: string) => {
    const names: string[] = []
    let cursor: string | undefined
    do {
      const page = await namespace.list({ cursor, prefix })
      names.push(...page.keys.map((key) => key.name.slice(prefix.length)))
      cursor = page.list_complete ? undefined : page.cursor
    } while (cursor)
    return names
  }

  return {
    delete: (key) => namespace.delete(`value:${key}`),
    definitions: {
      async delete(key) {
        await namespace.delete(`definition:${key}`)
        await namespace.delete(`value:${key}`)
      },
      async list() {
        const keys = await list('definition:')
        return Object.fromEntries(
          await Promise.all(
            keys.map(async (key) => [key, await namespace.get(`definition:${key}`, 'json')]),
          ),
        )
      },
      set: (key, definition) => namespace.put(`definition:${key}`, JSON.stringify(definition)),
    },
    async get(keys) {
      const entries = await Promise.all(
        keys.map(async (key) => [key, await namespace.get(`value:${key}`, 'json')] as const),
      )
      return Object.fromEntries(entries.filter((entry) => entry[1] !== null))
    },
    keys: () => list('value:'),
    set: (key, value) => namespace.put(`value:${key}`, JSON.stringify(value)),
  }
}

/** Thrown when the remote admin API of `Store.http` returns an error status. */
export class HttpError extends Errors.BaseError {
  override name = 'Store.HttpError'

  /** The status of the response. */
  readonly status: number

  constructor(options: { method: string; path: string; status: number }) {
    super(
      `The remote admin API returned ${options.status} for ${options.method} ${options.path}.`,
      {
        steps: [
          options.status === 401 || options.status === 403
            ? 'Set `token` to a token that the remote `authorize` accepts with the access the store needs.'
            : 'Check `url`, and that the remote runtime declares the flag.',
        ],
      },
    )
    this.status = options.status
  }
}

type Manifest = {
  flags: Record<string, Record<string, unknown>>
  orphans?: readonly string[] | null | undefined
}

/** Returns `store` unchanged, typed as a `Store`. A host store implements the contract directly. */
export function from(store: Store): Store {
  return store
}

/** Thrown when a write reaches a read-only store. */
export class ReadOnlyError extends Errors.BaseError {
  override name = 'Store.ReadOnlyError'

  constructor(options: { key: string }) {
    super(`The store is read only, so it cannot write the value of ${options.key}.`, {
      steps: ['Use a writable store, such as `Store.from` on a database table.'],
    })
  }
}
