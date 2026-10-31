/** @module Runs Store.http against a second runtime over real HTTP. */
import { Definitions } from 'vexla'
import { Vexla, Store } from 'vexla/server'
import * as Http from '../../test/Http.js'

const definitions = Definitions.parse({
  NEW_CHECKOUT: { default: false, public: true, type: 'boolean' },
})

describe('http', () => {
  test('a value set on the remote vexla applies to the local runtime', async () => {
    const remote = Vexla.create({
      authorize: (request) =>
        request.headers.get('authorization') === 'Bearer admin' ? 'write' : undefined,
      definitions,
      secret: 'remote-secret',
      store: Store.memory(),
    })
    const server = await Http.serve(remote.fetch)

    const store = Store.http({ token: 'admin', ttl: 0, url: `${server.url}/.flags` })
    const local = Vexla.create({ definitions, secret: 'local-secret', store })
    const read = () => local.get(new Request('https://app.example.com/'), 'NEW_CHECKOUT')

    expect(await read()).toMatchInlineSnapshot(`false`)
    await store.set('NEW_CHECKOUT', true)
    expect(await read()).toMatchInlineSnapshot(`true`)

    const response = await fetch(`${server.url}/.flags/manifest`, {
      headers: { authorization: 'Bearer admin' },
    })
    expect((await response.json()).flags.NEW_CHECKOUT.store).toMatchInlineSnapshot(`true`)
    await server.close()
  })

  test('store definitions through a remote vexla, with no flags file', async () => {
    const remote = Vexla.create({
      authorize: () => 'write',
      secret: 'remote-secret',
      store: Store.memory(),
    })
    const server = await Http.serve(remote.fetch)

    const store = Store.http({ ttl: 0, url: `${server.url}/.flags` })
    await store.definitions!.set(
      'BETA',
      Definitions.parse({ BETA: { default: true, type: 'boolean' } })['BETA']!,
    )
    const local = Vexla.create({ secret: 'local-secret', store })
    expect(
      await local.get(new Request('https://app.example.com/'), 'BETA' as never),
    ).toMatchInlineSnapshot(`true`)
    await server.close()
  })

  test('an error status throws HttpError without the token', async () => {
    const remote = Vexla.create({ definitions, secret: 'remote-secret', store: Store.memory() })
    const server = await Http.serve(remote.fetch)
    const store = Store.http({ token: 'wrong-token', url: `${server.url}/.flags` })
    const error = await store.get(['NEW_CHECKOUT']).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Store.HttpError)
    expect(String(error)).not.toContain('wrong-token')
    await server.close()
  })
})
