/** @module Hono entry: middleware that serves the dev route and scopes `flags` to each request. */
import type { MiddlewareHandler } from 'hono'
import * as Values from '../Values.js'
import type * as Vexla from '../server/Vexla.js'

/** The Hono environment that the middleware sets: `new Hono<Env<typeof vexla>>()`. */
export type Env<vexla extends Vexla.Vexla<any>> = { Variables: { flags: Flags<vexla> } }

/** The flag operations of one request, as `c.var.flags`. */
export type Flags<vexla extends Vexla.Vexla<any>> = {
  evaluate: () => ReturnType<vexla['evaluate']>
  get: <key extends Parameters<vexla['get']>[1]>(key: key) => ReturnType<vexla['get']>
  script: () => Promise<string>
}

/**
 * Returns Hono middleware. Requests under the path of `vexla` reach `vexla.fetch`. Other requests
 * run in `Values.run`, so `flags` holds their values, and `c.var.flags` binds `vexla` to them.
 */
export function middleware<vexla extends Vexla.Vexla<any>>(
  vexla: vexla,
): MiddlewareHandler<Env<vexla>> {
  return async (c, next) => {
    const request = c.req.raw
    const pathname = new URL(request.url).pathname
    if (pathname === vexla.path || pathname.startsWith(`${vexla.path}/`))
      return vexla.fetch(request)

    c.set('flags', {
      evaluate: () => vexla.evaluate(request) as never,
      get: (key) => vexla.get(request, key) as never,
      script: () => vexla.script(request),
    })

    await Values.run(vexla, request, next)

    const cookie = await vexla.setCookie(request)
    if (cookie) c.res.headers.append('set-cookie', cookie)
  }
}
