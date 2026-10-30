/** @module Runs Store.http against a second runtime over real HTTP. */
import { Definitions } from 'flargs'
import { Runtime, Store } from 'flargs/server'
import * as Http from '../../test/Http.js'

const definitions = Definitions.parse({
  newCheckout: { default: false, public: true, type: 'boolean' },
})

describe('http', () => {
  test('a value set on the remote runtime applies to the local runtime', async () => {
    const remote = Runtime.create({
      authorize: (request) =>
        request.headers.get('authorization') === 'Bearer admin' ? 'write' : undefined,
      definitions,
      secret: 'remote-secret',
      store: Store.memory(),
    })
    const server = await Http.serve(remote.fetch)

    const store = Store.http({ token: 'admin', ttl: 0, url: `${server.url}/.flags` })
    const local = Runtime.create({ definitions, secret: 'local-secret', store })
    const read = () => local.get(new Request('https://app.example.com/'), 'newCheckout')

    expect(await read()).toMatchInlineSnapshot(`false`)
    await store.set('newCheckout', true)
    expect(await read()).toMatchInlineSnapshot(`true`)

    const response = await fetch(`${server.url}/.flags/manifest`, {
      headers: { authorization: 'Bearer admin' },
    })
    expect((await response.json()).flags.newCheckout.store).toMatchInlineSnapshot(`true`)
    await server.close()
  })

  test('store definitions through a remote runtime, with no flags file', async () => {
    const remote = Runtime.create({
      authorize: () => 'write',
      secret: 'remote-secret',
      store: Store.memory(),
    })
    const server = await Http.serve(remote.fetch)

    const store = Store.http({ ttl: 0, url: `${server.url}/.flags` })
    await store.definitions!.set(
      'beta',
      Definitions.parse({ beta: { default: true, type: 'boolean' } })['beta']!,
    )
    const local = Runtime.create({ secret: 'local-secret', store })
    expect(
      await local.get(new Request('https://app.example.com/'), 'beta' as never),
    ).toMatchInlineSnapshot(`true`)
    await server.close()
  })

  test('an error status throws HttpError without the token', async () => {
    const remote = Runtime.create({ definitions, secret: 'remote-secret', store: Store.memory() })
    const server = await Http.serve(remote.fetch)
    const store = Store.http({ token: 'wrong-token', url: `${server.url}/.flags` })
    const error = await store.get(['newCheckout']).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Store.HttpError)
    expect(String(error)).not.toContain('wrong-token')
    await server.close()
  })
})
