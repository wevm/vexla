/** @module Runs a Hono app with the middleware behind a local HTTP server. */
import { Hono } from 'hono'
import { Definitions, flags } from 'vexla'
import { type Env, middleware } from 'vexla/hono'
import { Vexla } from 'vexla/server'
import * as Http from '../../test/Http.js'

const definitions = Definitions.parse({
  NEW_CHECKOUT: { default: false, public: true, type: 'boolean' },
  PRICING: { default: 'a', options: ['a', 'b'], type: 'select' },
})

describe('middleware', () => {
  test('serves the vexla path, and scopes flags and c.var.flags to the request', async () => {
    const vexla = Vexla.create({
      decide: { PRICING: () => 'b' },
      definitions,
      secret: 'test-secret',
    })
    const app = new Hono<Env<typeof vexla>>()
    app.use(middleware(vexla))
    app.get('/', async (c) =>
      c.json({ flag: flags['NEW_CHECKOUT'], get: await c.var.flags.get('PRICING') }),
    )

    const server = await Http.serve(app.fetch)
    expect((await fetch(`${server.url}/.flags/values`)).status).toMatchInlineSnapshot(`200`)

    const response = await fetch(`${server.url}/?flag.NEW_CHECKOUT=true`)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "flag": true,
        "get": "b",
      }
    `)
    expect(response.headers.get('set-cookie')).toMatch(/^vexla=/)
    await server.close()
  })
})
