/** @module Runs a node:http server with a Flargs instance: the dev route, scoped values, and the override cookie. */
import { Definitions, flags } from 'flargs'
import { Request } from 'flargs/node'
import { Flargs } from 'flargs/server'
import * as Http from '../../test/Http.js'

const definitions = Definitions.parse({
  NEW_CHECKOUT: { default: false, public: true, type: 'boolean' },
})

describe('toNodeListener', () => {
  test('serves the flargs path, scopes flags, and stores overrides in a cookie', async () => {
    const flargs = Flargs.create({ definitions, secret: 'test-secret' })
    const server = await Http.listen(
      Request.toNodeListener(() => Response.json({ NEW_CHECKOUT: flags['NEW_CHECKOUT'] }), {
        flargs,
      }),
    )

    const values = await fetch(`${server.url}/.flags/values`)
    expect(await values.json()).toMatchInlineSnapshot(`
      {
        "NEW_CHECKOUT": false,
      }
    `)

    const response = await fetch(`${server.url}/?flag.NEW_CHECKOUT=true`)
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "NEW_CHECKOUT": true,
      }
    `)

    const cookie = response.headers.get('set-cookie')!.split(';')[0]!
    const next = await fetch(`${server.url}/`, { headers: { cookie } })
    expect(await next.json()).toMatchInlineSnapshot(`
      {
        "NEW_CHECKOUT": true,
      }
    `)
    await server.close()
  })

  test('a handler error returns 500', async () => {
    const errors: unknown[] = []
    const server = await Http.listen(
      Request.toNodeListener(
        () => {
          throw new Error('broken')
        },
        { onError: (error) => errors.push(error) },
      ),
    )
    expect((await fetch(server.url)).status).toMatchInlineSnapshot(`500`)
    expect(errors.length).toMatchInlineSnapshot(`1`)
    await server.close()
  })
})

describe('fromNodeListener', () => {
  test('streams the body', async () => {
    const server = await Http.serve(async (request) =>
      Response.json({ body: await request.text(), method: request.method }),
    )
    const response = await fetch(server.url, { body: 'hello', method: 'POST' })
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "body": "hello",
        "method": "POST",
      }
    `)
    await server.close()
  })
})
