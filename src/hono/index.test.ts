/** @module Runs a Hono app with the middleware behind a local HTTP server. */
import { Hono } from 'hono'
import { Definitions, flags } from 'flargs'
import * as Flargs from 'flargs/hono'
import { Runtime } from 'flargs/server'
import * as Http from '../../test/Http.js'

const definitions = Definitions.parse({
  newCheckout: { default: false, public: true, type: 'boolean' },
  pricing: { default: 'a', options: ['a', 'b'], type: 'select' },
})

describe('middleware', () => {
  test('serves the runtime path, and scopes flags and c.var.flags to the request', async () => {
    const runtime = Runtime.create({
      decide: { pricing: () => 'b' },
      definitions,
      secret: 'test-secret',
    })
    const app = new Hono<Flargs.Env<typeof runtime>>()
    app.use(Flargs.middleware(runtime))
    app.get('/', async (c) =>
      c.json({ flag: flags['newCheckout'], get: await c.var.flags.get('pricing') }),
    )

    const server = await Http.serve(app.fetch)
    expect((await fetch(`${server.url}/.flags/values`)).status).toMatchInlineSnapshot(`200`)

    const response = await fetch(`${server.url}/?flag.newCheckout=true`)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "flag": true,
        "get": "b",
      }
    `)
    expect(response.headers.get('set-cookie')).toMatch(/^flargs=/)
    await server.close()
  })
})
