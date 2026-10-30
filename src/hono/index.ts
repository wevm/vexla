/** @module Hono entry: middleware that serves the dev route and scopes `flags` to each request. */
import type { MiddlewareHandler } from 'hono'
import * as Values from '../Values.js'
import type * as Runtime from '../server/Runtime.js'

/** The Hono environment that the middleware sets: `new Hono<Flargs.Env<typeof runtime>>()`. */
export type Env<runtime extends Runtime.Runtime<any>> = { Variables: { flags: Flags<runtime> } }

/** The flag operations of one request, as `c.var.flags`. */
export type Flags<runtime extends Runtime.Runtime<any>> = {
  evaluate: () => ReturnType<runtime['evaluate']>
  get: <key extends Parameters<runtime['get']>[1]>(key: key) => ReturnType<runtime['get']>
  script: () => Promise<string>
}

/**
 * Returns Hono middleware. Requests under the runtime path reach `runtime.fetch`. Other requests
 * run in `Values.run`, so `flags` holds their values, and `c.var.flags` binds the runtime to them.
 */
export function middleware<runtime extends Runtime.Runtime<any>>(
  runtime: runtime,
): MiddlewareHandler<Env<runtime>> {
  return async (c, next) => {
    const request = c.req.raw
    const pathname = new URL(request.url).pathname
    if (pathname === runtime.path || pathname.startsWith(`${runtime.path}/`))
      return runtime.fetch(request)

    c.set('flags', {
      evaluate: () => runtime.evaluate(request) as never,
      get: (key) => runtime.get(request, key) as never,
      script: () => runtime.script(request),
    })

    await Values.run(runtime, request, next)

    const cookie = await runtime.setCookie(request)
    if (cookie) c.res.headers.append('set-cookie', cookie)
  }
}
