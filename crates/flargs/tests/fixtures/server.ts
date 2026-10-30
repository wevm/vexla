/**
 * @module Serves two TypeScript runtimes from the built package for the Rust client tests: one with
 * a flags file, and one with store definitions. It prints their URLs as one JSON line.
 */
import * as Http from 'node:http'
import { Definitions } from 'flargs'
import { Request } from 'flargs/node'
import { Flargs, Store } from 'flargs/server'

const definitions = Definitions.parse({
  BANNER: { build: true, default: false, public: true, type: 'boolean' },
  NEW_CHECKOUT: { default: false, public: true, type: 'boolean' },
  PRICING: { default: 'a', options: ['a', 'b', 'c'], type: 'select' },
})

const authorize = (request: globalThis.Request) =>
  request.headers.get('authorization') === 'Bearer admin' ? ('write' as const) : undefined

async function listen(flargs: { fetch: Flargs.Flargs['fetch'] }): Promise<string> {
  const server = Http.createServer(Request.toNodeListener(flargs.fetch))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address.')
  return `http://127.0.0.1:${address.port}/.flags`
}

const file = await listen(
  Flargs.create({
    authorize,
    definitions,
    env: {},
    secret: 'remote-secret',
    store: Store.memory(),
  }),
)
const store = await listen(
  Flargs.create({ authorize, env: {}, secret: 'remote-secret', store: Store.memory() }),
)

console.log(JSON.stringify({ file, store }))
