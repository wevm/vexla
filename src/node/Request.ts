/** @module Conversion between `node:http` and the fetch API, for Node servers and Express. */
import type * as Http from 'node:http'
import * as Values from '../Values.js'
import type * as Flargs from '../server/Flargs.js'

/** A fetch handler. */
export type Handler = (request: globalThis.Request) => Response | Promise<Response>

/**
 * Returns a `node:http` request listener for `handler`. With `flargs`, requests under its path
 * reach `flargs.fetch`, other requests run in `Values.run`, and override search parameters
 * persist in the `flargs` cookie.
 */
export function toNodeListener(
  handler: Handler,
  options: toNodeListener.Options = {},
): Http.RequestListener {
  return (incoming, outgoing) => {
    void (async () => {
      const request = fromNodeListener(incoming)
      const flargs = options.flargs

      const response = await (async () => {
        if (!flargs) return handler(request)

        const pathname = new URL(request.url).pathname
        if (pathname === flargs.path || pathname.startsWith(`${flargs.path}/`))
          return flargs.fetch(request)

        const response = await Values.run(flargs, request, () => handler(request))
        const cookie = await flargs.setCookie(request)
        if (!cookie) return response

        const headers = new Headers(response.headers)
        headers.append('set-cookie', cookie)
        return new Response(response.body, {
          headers,
          status: response.status,
          statusText: response.statusText,
        })
      })().catch((error: unknown) => {
        options.onError?.(error)
        return new Response('Internal Server Error', { status: 500 })
      })

      outgoing.statusCode = response.status
      for (const [name, value] of response.headers)
        if (name !== 'set-cookie') outgoing.setHeader(name, value)
      const cookies = response.headers.getSetCookie()
      if (cookies.length > 0) outgoing.setHeader('set-cookie', cookies)
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    })()
  }
}

export declare namespace toNodeListener {
  type Options = {
    /** Receives errors that the handler throws. The response is `500`. */
    onError?: ((error: unknown) => void) | undefined
    /** A Flargs instance: serves its path, and scopes `flags` to each request. */
    flargs?: Flargs.Flargs<any> | undefined
  }
}

/** Returns a fetch `Request` for a `node:http` request. The body streams from `incoming`. */
export function fromNodeListener(incoming: Http.IncomingMessage): globalThis.Request {
  const protocol = (incoming.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http'
  const url = new URL(incoming.url ?? '/', `${protocol}://${incoming.headers.host ?? 'localhost'}`)
  const method = incoming.method ?? 'GET'

  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item)
    else if (value !== undefined) headers.set(name, value)
  }

  const body =
    method === 'GET' || method === 'HEAD'
      ? null
      : new ReadableStream<Uint8Array>({
          start(controller) {
            incoming.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
            incoming.on('end', () => controller.close())
            incoming.on('error', (error) => controller.error(error))
          },
        })

  return new globalThis.Request(url, { body, duplex: 'half', headers, method } as RequestInit)
}
