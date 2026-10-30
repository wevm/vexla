/** @module Hono entry: middleware that serves the dev route and scopes `flags` to each request. */
import type { MiddlewareHandler } from 'hono'
import * as Values from '../Values.js'
import type * as Flargs from '../server/Flargs.js'

/** The Hono environment that the middleware sets: `new Hono<Env<typeof flargs>>()`. */
export type Env<flargs extends Flargs.Flargs<any>> = { Variables: { flags: Flags<flargs> } }

/** The flag operations of one request, as `c.var.flags`. */
export type Flags<flargs extends Flargs.Flargs<any>> = {
  evaluate: () => ReturnType<flargs['evaluate']>
  get: <key extends Parameters<flargs['get']>[1]>(key: key) => ReturnType<flargs['get']>
  script: () => Promise<string>
}

/**
 * Returns Hono middleware. Requests under the path of `flargs` reach `flargs.fetch`. Other requests
 * run in `Values.run`, so `flags` holds their values, and `c.var.flags` binds `flargs` to them.
 */
export function middleware<flargs extends Flargs.Flargs<any>>(
  flargs: flargs,
): MiddlewareHandler<Env<flargs>> {
  return async (c, next) => {
    const request = c.req.raw
    const pathname = new URL(request.url).pathname
    if (pathname === flargs.path || pathname.startsWith(`${flargs.path}/`))
      return flargs.fetch(request)

    c.set('flags', {
      evaluate: () => flargs.evaluate(request) as never,
      get: (key) => flargs.get(request, key) as never,
      script: () => flargs.script(request),
    })

    await Values.run(flargs, request, next)

    const cookie = await flargs.setCookie(request)
    if (cookie) c.res.headers.append('set-cookie', cookie)
  }
}
