/** @module Runs the runtime behind a local HTTP server: resolution, overrides, access, and the admin API. */
import { Definitions, Override } from 'flargs'
import { Flargs, Store } from 'flargs/server'
import * as Http from '../../test/Http.js'

const definitions = Definitions.parse({
  banner: { build: true, default: false, public: true, type: 'boolean' },
  limits: { default: { requests: 100 }, type: 'json' },
  newCheckout: { default: false, public: true, type: 'boolean' },
  pricing: { default: 'a', options: ['a', 'b', 'c'], type: 'select' },
  title: { default: 'Hello', public: true, type: 'string' },
})

const secret = 'test-secret'

// Serves the runtime path through `flargs.fetch`, and `/app` with the values of the request.
async function serve(options: Flargs.create.Options<typeof definitions>) {
  const flargs = Flargs.create({ definitions, secret, ...options })
  const server = await Http.serve(async (request) => {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/.flags')) return flargs.fetch(request)
    return Response.json(await flargs.evaluate(request))
  })
  return { flargs, ...server }
}

describe('evaluate', () => {
  test('defaults', async () => {
    const server = await serve({})
    const values = await (await fetch(`${server.url}/app`)).json()
    expect(values).toMatchInlineSnapshot(`
      {
        "banner": false,
        "limits": {
          "requests": 100,
        },
        "newCheckout": false,
        "pricing": "a",
        "title": "Hello",
      }
    `)
    await server.close()
  })

  test('resolution order: override, store, decide, env, then default', async () => {
    const store = Store.memory({ values: { title: 'Stored' } })
    const server = await serve({
      decide: {
        pricing: (user: { plan: string } | undefined) =>
          user?.plan === 'enterprise' ? 'c' : undefined,
      },
      env: { FEATURE_LIMITS: '{"requests":5}', FEATURE_TITLE: 'From env' },
      identify: (request) => ({ plan: request.headers.get('x-plan') ?? 'free' }),
      store,
    })

    const values = await (
      await fetch(`${server.url}/app?flag.newCheckout=true`, {
        headers: { 'x-plan': 'enterprise' },
      })
    ).json()
    expect(values.newCheckout).toMatchInlineSnapshot(`true`)
    expect(values.title).toMatchInlineSnapshot(`"Stored"`)
    expect(values.pricing).toMatchInlineSnapshot(`"c"`)
    expect(values.limits).toMatchInlineSnapshot(`
      {
        "requests": 5,
      }
    `)

    const free = await (await fetch(`${server.url}/app`)).json()
    expect(free.pricing).toMatchInlineSnapshot(`"a"`)
    await server.close()
  })

  test('an invalid store value or decide result falls through and reaches onError', async () => {
    const errors: string[] = []
    const server = await serve({
      decide: { pricing: () => 'z' as never },
      onError: (error) => errors.push((error as Error).name),
      store: Store.from({
        delete: async () => {},
        get: async () => ({ title: 42 }),
        set: async () => {},
      }),
    })

    const values = await (await fetch(`${server.url}/app`)).json()
    expect(values.title).toMatchInlineSnapshot(`"Hello"`)
    expect(values.pricing).toMatchInlineSnapshot(`"a"`)
    expect(errors).toMatchInlineSnapshot(`
      [
        "Definitions.InvalidValueError",
        "Definitions.InvalidValueError",
      ]
    `)
    await server.close()
  })

  test('get runs decide for one flag only', async () => {
    const calls: string[] = []
    const flargs = Flargs.create({
      decide: {
        pricing: () => (calls.push('pricing'), 'b'),
        title: () => (calls.push('title'), undefined),
      },
      definitions,
      secret,
    })
    const request = new Request('https://app.example.com/')
    expect(await flargs.get(request, 'pricing')).toMatchInlineSnapshot(`"b"`)
    expect(await flargs.get(request, 'pricing')).toMatchInlineSnapshot(`"b"`)
    expect(calls).toMatchInlineSnapshot(`
      [
        "pricing",
      ]
    `)
  })
})

describe('overrides', () => {
  test('production: public flags only, unless signed', async () => {
    const server = await serve({})

    const unsigned = await (
      await fetch(`${server.url}/app?flag.newCheckout=true&flag.pricing=c&flag.banner=true`)
    ).json()
    expect([unsigned.newCheckout, unsigned.pricing, unsigned.banner]).toMatchInlineSnapshot(`
      [
        true,
        "a",
        false,
      ]
    `)

    const params = await Override.serialize(
      { pricing: 'c' },
      { expiresAt: Date.now() + 60_000, secret },
    )
    const signed = await (await fetch(`${server.url}/app?${params}`)).json()
    expect(signed.pricing).toMatchInlineSnapshot(`"c"`)

    const forged = await (
      await fetch(`${server.url}/app?${params.toString().replace('pricing=c', 'pricing=b')}`)
    ).json()
    expect(forged.pricing).toMatchInlineSnapshot(`"a"`)
    await server.close()
  })

  test('dev mode: every flag', async () => {
    const server = await serve({ dev: true })
    const values = await (await fetch(`${server.url}/app?flag.pricing=c&flag.banner=true`)).json()
    expect([values.pricing, values.banner]).toMatchInlineSnapshot(`
      [
        "c",
        true,
      ]
    `)
    await server.close()
  })

  test('setCookie stores search parameter overrides, and the cookie applies on the next request', async () => {
    const flargs = Flargs.create({ definitions, secret })
    const cookie = await flargs.setCookie(
      new Request('https://app.example.com/?flag.newCheckout=true'),
    )
    expect(cookie).toMatch(/^flargs=.+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure$/)

    const next = new Request('https://app.example.com/', {
      headers: { cookie: cookie!.split(';')[0]! },
    })
    expect(await flargs.get(next, 'newCheckout')).toMatchInlineSnapshot(`true`)
    expect(await flargs.setCookie(new Request('https://app.example.com/'))).toMatchInlineSnapshot(
      `undefined`,
    )
  })

  test('a forged cookie is ignored', async () => {
    const flargs = Flargs.create({ definitions, secret })
    const request = new Request('https://app.example.com/', {
      headers: {
        cookie: `flargs=${encodeURIComponent('flag.pricing=c&flag.exp=9999999999&flag.sig=forged')}`,
      },
    })
    expect(await flargs.get(request, 'pricing')).toMatchInlineSnapshot(`"a"`)
  })
})

describe('fetch', () => {
  test('access: undefined is 401, read cannot write, a Response passes through', async () => {
    const server = await serve({
      authorize: (request) => {
        const role = request.headers.get('x-role')
        if (role === 'challenge')
          return new Response('challenge', {
            status: 401,
            headers: { 'www-authenticate': 'Bearer' },
          })
        return role === 'admin' ? 'write' : role === 'viewer' ? 'read' : undefined
      },
      store: Store.memory(),
    })

    const status = async (path: string, role: string | undefined, init: RequestInit = {}) =>
      (
        await fetch(`${server.url}/.flags${path}`, {
          ...init,
          headers: { 'content-type': 'application/json', ...(role ? { 'x-role': role } : {}) },
        })
      ).status

    const put = { body: JSON.stringify({ value: true }), method: 'PUT' }
    expect(await status('/manifest', undefined)).toMatchInlineSnapshot(`401`)
    expect(await status('/manifest', 'viewer')).toMatchInlineSnapshot(`200`)
    expect(await status('/values/newCheckout', 'viewer', put)).toMatchInlineSnapshot(`403`)
    expect(await status('/values/newCheckout', 'admin', put)).toMatchInlineSnapshot(`200`)
    expect(await status('/manifest', 'challenge')).toMatchInlineSnapshot(`401`)
    expect(await status('/values', undefined)).toMatchInlineSnapshot(`200`)

    const values = await (await fetch(`${server.url}/app`)).json()
    expect(values.newCheckout).toMatchInlineSnapshot(`true`)
    await server.close()
  })

  test('an authorize error means no access', async () => {
    const errors: unknown[] = []
    const server = await serve({
      authorize: () => {
        throw new Error('database down')
      },
      onError: (error) => errors.push(error),
    })
    expect((await fetch(`${server.url}/.flags/manifest`)).status).toMatchInlineSnapshot(`401`)
    expect(errors.length).toMatchInlineSnapshot(`1`)
    await server.close()
  })

  test('public responses never hold private values', async () => {
    const flargs = Flargs.create({
      definitions,
      secret,
      store: Store.memory({ values: { pricing: 'c' } }),
    })
    const request = new Request('https://app.example.com/.flags/values')

    const values = await (await flargs.fetch(request)).json()
    expect(Object.keys(values)).toMatchInlineSnapshot(`
      [
        "banner",
        "newCheckout",
        "title",
      ]
    `)
    expect(await flargs.script(new Request('https://app.example.com/'))).toMatchInlineSnapshot(
      `"<script type="application/json" id="__flargs">{"banner":false,"newCheckout":false,"title":"Hello"}</script>"`,
    )
  })

  test('script escapes a value that would close the element', async () => {
    const flargs = Flargs.create({
      definitions,
      secret,
      store: Store.memory({ values: { title: '</script><script>alert(1)' } }),
    })
    expect(await flargs.script(new Request('https://app.example.com/'))).not.toContain(
      '</script><script>',
    )
  })

  test('store values: validation, unknown flags, and delete', async () => {
    const server = await serve({ dev: true, store: Store.memory() })
    const put = (key: string, value: unknown) =>
      fetch(`${server.url}/.flags/values/${key}`, {
        body: JSON.stringify({ value }),
        headers: { 'content-type': 'application/json' },
        method: 'PUT',
      })

    expect((await put('pricing', 'z')).status).toMatchInlineSnapshot(`400`)
    expect((await put('nope', true)).status).toMatchInlineSnapshot(`404`)
    expect((await put('pricing', 'b')).status).toMatchInlineSnapshot(`200`)
    expect((await (await fetch(`${server.url}/app`)).json()).pricing).toMatchInlineSnapshot(`"b"`)

    await fetch(`${server.url}/.flags/values/pricing`, { method: 'DELETE' })
    expect((await (await fetch(`${server.url}/app`)).json()).pricing).toMatchInlineSnapshot(`"a"`)
    await server.close()
  })

  test('orphan values are listed and may be deleted', async () => {
    const store = Store.memory({ values: { oldFlag: true, title: 'Stored' } })
    const flargs = Flargs.create({ definitions, dev: true, store })
    const manifest = await (
      await flargs.fetch(new Request('https://app.example.com/.flags/manifest'))
    ).json()
    expect(manifest.orphans).toMatchInlineSnapshot(`
      [
        "oldFlag",
      ]
    `)
    const deleted = await flargs.fetch(
      new Request('https://app.example.com/.flags/values/oldFlag', { method: 'DELETE' }),
    )
    expect(deleted.status).toMatchInlineSnapshot(`200`)
    expect(await store.keys!()).toMatchInlineSnapshot(`
      [
        "title",
      ]
    `)
  })

  test('manifest', async () => {
    const server = await serve({ dev: true, store: Store.memory({ values: { title: 'Stored' } }) })
    const manifest = await (await fetch(`${server.url}/.flags/manifest?flag.pricing=b`)).json()
    expect(manifest.flags.title).toMatchInlineSnapshot(`
      {
        "build": false,
        "default": "Hello",
        "env": "FEATURE_TITLE",
        "override": null,
        "public": true,
        "source": "store",
        "stale": false,
        "store": "Stored",
        "type": "string",
        "value": "Stored",
      }
    `)
    expect([manifest.flags.pricing.source, manifest.flags.pricing.value]).toMatchInlineSnapshot(`
      [
        "override",
        "b",
      ]
    `)
    await server.close()
  })

  test('personal overrides set a cookie', async () => {
    const server = await serve({ dev: true })
    const response = await fetch(`${server.url}/.flags/overrides`, {
      body: JSON.stringify({ values: { pricing: 'c' } }),
      headers: { 'content-type': 'application/json' },
      method: 'PUT',
    })
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!
    const values = await (await fetch(`${server.url}/app`, { headers: { cookie } })).json()
    expect(values.pricing).toMatchInlineSnapshot(`"c"`)
    await server.close()
  })

  test('links override a private flag until they expire', async () => {
    const server = await serve({ authorize: () => 'write' })
    const { url } = await (
      await fetch(`${server.url}/.flags/links`, {
        body: JSON.stringify({
          expiresAt: Date.now() + 60_000,
          url: '/app',
          values: { pricing: 'c' },
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
    ).json()
    expect(url).toMatch(/\/app\?flag\.pricing=c&flag\.exp=\d+&flag\.sig=[\w-]+$/)
    expect((await (await fetch(url)).json()).pricing).toMatchInlineSnapshot(`"c"`)
    await server.close()
  })

  test('store definitions, and 409 with a flags file', async () => {
    const flargs = Flargs.create({ secret, store: Store.memory() })
    const server = await Http.serve(async (request) =>
      new URL(request.url).pathname.startsWith('/.flags')
        ? flargs.fetch(request)
        : Response.json(await flargs.evaluate(request)),
    )
    // A runtime with no authorize has no access outside dev mode.
    expect(
      (await fetch(`${server.url}/.flags/definitions/beta`, { body: '{}', method: 'PUT' })).status,
    ).toMatchInlineSnapshot(`401`)
    await server.close()

    const store = Store.memory()
    const open = Flargs.create({ dev: true, store })
    const created = await open.fetch(
      new Request('https://app.example.com/.flags/definitions/beta', {
        body: JSON.stringify({ default: false, public: true, type: 'boolean' }),
        method: 'PUT',
      }),
    )
    expect(created.status).toMatchInlineSnapshot(`200`)
    expect(
      await open.get(new Request('https://app.example.com/?flag.beta=true'), 'beta' as never),
    ).toMatchInlineSnapshot(`true`)

    const invalid = await open.fetch(
      new Request('https://app.example.com/.flags/definitions/gamma', {
        body: JSON.stringify({ default: 1, type: 'boolean' }),
        method: 'PUT',
      }),
    )
    expect(invalid.status).toMatchInlineSnapshot(`400`)

    const withFile = Flargs.create({ definitions, dev: true, store })
    const conflict = await withFile.fetch(
      new Request('https://app.example.com/.flags/definitions/beta', { body: '{}', method: 'PUT' }),
    )
    expect(conflict.status).toMatchInlineSnapshot(`409`)
  })

  test('store definitions unavailable', async () => {
    const flargs = Flargs.create({
      dev: true,
      store: {
        ...Store.memory(),
        definitions: {
          delete: async () => {},
          list: async () => {
            throw new Error('database down')
          },
          set: async () => {},
        },
      },
    })
    await expect(
      flargs.get(new Request('https://app.example.com/'), 'beta' as never),
    ).rejects.toThrow(Flargs.DefinitionsUnavailableError)
    expect(
      (await flargs.fetch(new Request('https://app.example.com/.flags/manifest'))).status,
    ).toMatchInlineSnapshot(`503`)
  })

  test('cors on the values endpoint only', async () => {
    const flargs = Flargs.create({
      cors: { origins: ['https://web.example.com'] },
      definitions,
      secret,
    })
    const headers = { origin: 'https://web.example.com' }
    const values = await flargs.fetch(
      new Request('https://api.example.com/.flags/values', { headers }),
    )
    expect(values.headers.get('access-control-allow-origin')).toMatchInlineSnapshot(
      `"https://web.example.com"`,
    )

    const other = await flargs.fetch(
      new Request('https://api.example.com/.flags/values', {
        headers: { origin: 'https://evil.example.com' },
      }),
    )
    expect(other.headers.get('access-control-allow-origin')).toMatchInlineSnapshot(`null`)
  })

  test('dev route page', async () => {
    const flargs = Flargs.create({ definitions, dev: true })
    const response = await flargs.fetch(new Request('https://app.example.com/.flags'))
    expect(response.headers.get('content-type')).toMatchInlineSnapshot(`"text/html; charset=utf-8"`)
    expect(await response.text()).toContain('<title>Flags</title>')
  })

  test('outside the path', async () => {
    const flargs = Flargs.create({ definitions, dev: true })
    expect(
      (await flargs.fetch(new Request('https://app.example.com/other'))).status,
    ).toMatchInlineSnapshot(`404`)
  })
})

describe('create', () => {
  test('needs a secret outside dev mode', () => {
    expect(() => Flargs.create({ definitions })).toThrowErrorMatchingInlineSnapshot(
      `[TypeError: \`Flargs.create\` needs \`secret\` outside dev mode. Set \`secret\`, such as from \`FLARGS_SECRET\`.]`,
    )
  })
})
