/**
 * @module The flag values of the current request or page. On the server, `Values.run` scopes the
 * values of one request with `AsyncLocalStorage`. In a browser, the values come from the script
 * that `runtime.script` embeds, or from `Values.load`. Outside both, values come from `FEATURE_*`
 * environment variables, as in zero config.
 */
import * as Definitions from './Definitions.js'
import type { Registered } from './index.js'

/** Resolved values, keyed by flag key. */
export type Snapshot = Readonly<Record<string, Definitions.Json>>

/** The part of a runtime that `run` needs. */
export type Evaluator = {
  evaluate: (request: Request) => Promise<Record<string, unknown>>
}

type Storage = {
  getStore: () => Snapshot | undefined
  run: <result>(store: Snapshot, fn: () => result) => result
}

// `getBuiltinModule` reaches `AsyncLocalStorage` without a static import, so browser bundles
// never import `node:async_hooks`. Node, Bun, Deno, and Workers (`nodejs_compat`) provide it.
const storage = ((): Storage | undefined => {
  const process = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } })
    .process
  const hooks = process?.getBuiltinModule?.('node:async_hooks') as
    | { AsyncLocalStorage: new () => Storage }
    | undefined
  return hooks ? new hooks.AsyncLocalStorage() : undefined
})()

// The values of the page in a browser. The page is the lifecycle of these values.
let page: Snapshot | undefined
const listeners = new Set<() => void>()

/**
 * The typed flag values of the current request (on the server) or page (in a browser). A read is
 * synchronous. A key with no value reads as `undefined`.
 */
export const flags = new Proxy({} as Snapshot, {
  get: (_, key) => (typeof key === 'string' ? snapshot()[key] : undefined),
  getOwnPropertyDescriptor: (_, key) =>
    typeof key === 'string' && key in snapshot()
      ? { configurable: true, enumerable: true, value: snapshot()[key], writable: false }
      : undefined,
  has: (_, key) => typeof key === 'string' && key in snapshot(),
  ownKeys: () => Object.keys(snapshot()),
}) as Readonly<Definitions.Values<Registered>>

/** Returns the current values: the request scope, then the page, then the environment. */
export function snapshot(): Snapshot {
  const scoped = storage?.getStore()
  if (scoped) return scoped
  if (typeof document !== 'undefined') return (page ??= embedded())
  return environment()
}

/**
 * Evaluates every runtime flag for `request`, then runs `fn` with those values in `flags`.
 * Middleware calls it for each request. Each `decide` runs once.
 *
 * @throws {Error} When the runtime has no `AsyncLocalStorage`.
 */
export async function run<result>(
  runtime: Evaluator,
  request: Request,
  fn: () => result,
): Promise<Awaited<result>> {
  if (!storage)
    throw new Error(
      '`Values.run` needs `AsyncLocalStorage`. Run it in Node, Bun, Deno, or Workers with `nodejs_compat`.',
    )
  const values = (await runtime.evaluate(request)) as Snapshot
  return storage.run(values, () => fn()) as Awaited<result>
}

/**
 * Requests the public values from `GET <url>/values`, for a page with no embedded script, such
 * as a client on another origin. `flag.*` parameters of the page persist in `sessionStorage` and
 * travel with each request, since the API cannot set a cookie for another origin.
 */
export async function load(options: load.Options = {}): Promise<Snapshot> {
  const base = options.url ?? '/.flags'
  const params = new URLSearchParams()

  if (typeof location !== 'undefined') {
    const current = new URLSearchParams(location.search)
    const stored = (() => {
      if (current.has('flag.reset')) return new URLSearchParams()
      try {
        return new URLSearchParams(sessionStorage.getItem('flargs') ?? '')
      } catch {
        return new URLSearchParams()
      }
    })()
    for (const [name, value] of current)
      if (name.startsWith('flag.') && name !== 'flag.reset') stored.set(name, value)
    try {
      sessionStorage.setItem('flargs', stored.toString())
    } catch {}
    for (const [name, value] of stored) params.set(name, value)
  }

  const query = params.toString()
  const response = await (options.fetch ?? globalThis.fetch)(
    `${base.replace(/\/$/, '')}/values${query ? `?${query}` : ''}`,
  )
  if (!response.ok) throw new Error(`The values endpoint returned ${response.status}.`)

  page = (await response.json()) as Snapshot
  for (const listener of listeners) listener()
  return page
}

export declare namespace load {
  type Options = {
    /** The fetch function. @default globalThis.fetch */
    fetch?: typeof globalThis.fetch | undefined
    /** The URL of the dev route and the admin API. @default '/.flags' */
    url?: string | undefined
  }
}

/** Calls `fn` after each `load`. Returns a function that removes `fn`. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function embedded(): Snapshot {
  const element = document.getElementById('__flargs')
  if (!element?.textContent) return {}
  try {
    return JSON.parse(element.textContent) as Snapshot
  } catch {
    return {}
  }
}

function environment(): Snapshot {
  const env =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  const definitions = Definitions.fromEnv(env)
  return Object.fromEntries(
    Object.entries(definitions).map((entry) => [entry[0], entry[1].default]),
  )
}
