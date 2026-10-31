/** @module Serves a fetch handler over real HTTP on a random port, for integration tests. */
import * as Http from 'node:http'
import { Request } from 'vexla/node'

/** Starts a server on `127.0.0.1` with a `node:http` request listener. */
export async function listen(
  listener: Http.RequestListener,
): Promise<{ close: () => Promise<void>; url: string }> {
  const server = Http.createServer(listener)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address.')

  return {
    // Clients keep connections alive, so `close` ends them instead of waiting for them to idle.
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
    url: `http://127.0.0.1:${address.port}`,
  }
}

/** Starts a server for a fetch handler. */
export function serve(handler: (request: globalThis.Request) => Response | Promise<Response>) {
  return listen(Request.toNodeListener(handler))
}
