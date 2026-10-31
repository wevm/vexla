/** @module Runs the runtime behind a local HTTP server: resolution, overrides, access, and the admin API. */
import { Definitions, Override } from 'vexla'
import { Vexla, Store } from 'vexla/server'
import * as Http from '../../test/Http.js'

const definitions = Definitions.parse({
  BANNER: { build: true, default: false, public: true, type: 'boolean' },
  LIMITS: { default: { requests: 100 }, type: 'json' },
  NEW_CHECKOUT: { default: false, public: true, type: 'boolean' },
  PRICING: { default: 'a', options: ['a', 'b', 'c'], type: 'select' },
  TITLE: { default: 'Hello', public: true, type: 'string' },
})

const secret = 'test-secret'

// Serves the runtime path through `vexla.fetch`, and `/app` with the values of the request.
async function serve(options: Vexla.create.Options<typeof definitions>) {
  const vexla = Vexla.create({ definitions, secret, ...options })
  const server = await Http.serve(async (request) => {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/.flags')) return vexla.fetch(request)
    return Response.json(await vexla.evaluate(request))
  })
  return { vexla, ...server }
}

describe('evaluate', () => {
  test('defaults', async () => {
    const server = await serve({})
    const values = await (await fetch(`${server.url}/app`)).json()
    expect(values).toMatchInlineSnapshot(`
      {
        "BANNER": false,
        "LIMITS": {
          "requests": 100,
        },
        "NEW_CHECKOUT": false,
        "PRICING": "a",
        "TITLE": "Hello",
      }
    `)
    await server.close()
  })

  test('resolution order: override, store, decide, env, then default', async () => {
    const store = Store.memory({ values: { TITLE: 'Stored' } })
    const server = await serve({
      decide: {
        PRICING(user: { plan: string } | undefined) {
          return user?.plan === 'enterprise' ? 'c' : undefined
        },
      },
      env: { LIMITS: '{"requests":5}', TITLE: 'From env' },
      identify(request) {
        return { plan: request.headers.get('x-plan') ?? 'free' }
      },
      store,
    })

    const values = await (
      await fetch(`${server.url}/app?flag.NEW_CHECKOUT=true`, {
        headers: { 'x-plan': 'enterprise' },
      })
    ).json()
    expect(values.NEW_CHECKOUT).toMatchInlineSnapshot(`true`)
    expect(values.TITLE).toMatchInlineSnapshot(`"Stored"`)
    expect(values.PRICING).toMatchInlineSnapshot(`"c"`)
    expect(values.LIMITS).toMatchInlineSnapshot(`
      {
        "requests": 5,
      }
    `)

    const free = await (await fetch(`${server.url}/app`)).json()
    expect(free.PRICING).toMatchInlineSnapshot(`"a"`)
    await server.close()
  })

  test('an invalid store value or decide result falls through and reaches onError', async () => {
    const errors: string[] = []
    const server = await serve({
      decide: {
        PRICING() {
          return 'z' as never
        },
      },
      onError(error) {
        errors.push((error as Error).name)
      },
      store: Store.from({
        async delete() {},
        async get() {
          return { TITLE: 42 }
        },
        async set() {},
      }),
    })

    const values = await (await fetch(`${server.url}/app`)).json()
    expect(values.TITLE).toMatchInlineSnapshot(`"Hello"`)
    expect(values.PRICING).toMatchInlineSnapshot(`"a"`)
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
    const vexla = Vexla.create({
      decide: {
        PRICING() {
          calls.push('PRICING')
          return 'b'
        },
        TITLE() {
          calls.push('TITLE')
          return undefined
        },
      },
      definitions,
      secret,
    })
    const request = new Request('https://app.example.com/')
    expect(await vexla.get(request, 'PRICING')).toMatchInlineSnapshot(`"b"`)
    expect(await vexla.get(request, 'PRICING')).toMatchInlineSnapshot(`"b"`)
    expect(calls).toMatchInlineSnapshot(`
      [
        "PRICING",
      ]
    `)
  })
})

describe('overrides', () => {
  test('production: public flags only, unless signed', async () => {
    const server = await serve({})

    const unsigned = await (
      await fetch(`${server.url}/app?flag.NEW_CHECKOUT=true&flag.PRICING=c&flag.BANNER=true`)
    ).json()
    expect([unsigned.NEW_CHECKOUT, unsigned.PRICING, unsigned.BANNER]).toMatchInlineSnapshot(`
      [
        true,
        "a",
        false,
      ]
    `)

    const params = await Override.serialize(
      { PRICING: 'c' },
      { expiresAt: Date.now() + 60_000, secret },
    )
    const signed = await (await fetch(`${server.url}/app?${params}`)).json()
    expect(signed.PRICING).toMatchInlineSnapshot(`"c"`)

    const forged = await (
      await fetch(`${server.url}/app?${params.toString().replace('PRICING=c', 'PRICING=b')}`)
    ).json()
    expect(forged.PRICING).toMatchInlineSnapshot(`"a"`)
    await server.close()
  })

  test('dev mode: every flag', async () => {
    const server = await serve({ dev: true })
    const values = await (await fetch(`${server.url}/app?flag.PRICING=c&flag.BANNER=true`)).json()
    expect([values.PRICING, values.BANNER]).toMatchInlineSnapshot(`
      [
        "c",
        true,
      ]
    `)
    await server.close()
  })

  test('setCookie stores search parameter overrides, and the cookie applies on the next request', async () => {
    const vexla = Vexla.create({ definitions, secret })
    const cookie = await vexla.setCookie(
      new Request('https://app.example.com/?flag.NEW_CHECKOUT=true'),
    )
    expect(cookie).toMatch(/^vexla=.+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure$/)

    const next = new Request('https://app.example.com/', {
      headers: { cookie: cookie!.split(';')[0]! },
    })
    expect(await vexla.get(next, 'NEW_CHECKOUT')).toMatchInlineSnapshot(`true`)
    expect(await vexla.setCookie(new Request('https://app.example.com/'))).toMatchInlineSnapshot(
      `undefined`,
    )
  })

  test('a forged cookie is ignored', async () => {
    const vexla = Vexla.create({ definitions, secret })
    const request = new Request('https://app.example.com/', {
      headers: {
        cookie: `vexla=${encodeURIComponent('flag.PRICING=c&flag.exp=9999999999&flag.sig=forged')}`,
      },
    })
    expect(await vexla.get(request, 'PRICING')).toMatchInlineSnapshot(`"a"`)
  })
})

describe('fetch', () => {
  test('access: undefined is 401, read cannot write, a Response passes through', async () => {
    const server = await serve({
      authorize(request) {
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
    expect(await status('/values/NEW_CHECKOUT', 'viewer', put)).toMatchInlineSnapshot(`403`)
    expect(await status('/values/NEW_CHECKOUT', 'admin', put)).toMatchInlineSnapshot(`200`)
    expect(await status('/manifest', 'challenge')).toMatchInlineSnapshot(`401`)
    expect(await status('/values', undefined)).toMatchInlineSnapshot(`200`)

    const values = await (await fetch(`${server.url}/app`)).json()
    expect(values.NEW_CHECKOUT).toMatchInlineSnapshot(`true`)
    await server.close()
  })

  test('an authorize error means no access', async () => {
    const errors: unknown[] = []
    const server = await serve({
      authorize() {
        throw new Error('database down')
      },
      onError(error) {
        errors.push(error)
      },
    })
    expect((await fetch(`${server.url}/.flags/manifest`)).status).toMatchInlineSnapshot(`401`)
    expect(errors.length).toMatchInlineSnapshot(`1`)
    await server.close()
  })

  test('public responses never hold private values', async () => {
    const vexla = Vexla.create({
      definitions,
      secret,
      store: Store.memory({ values: { PRICING: 'c' } }),
    })
    const request = new Request('https://app.example.com/.flags/values')

    const values = await (await vexla.fetch(request)).json()
    expect(Object.keys(values)).toMatchInlineSnapshot(`
      [
        "BANNER",
        "NEW_CHECKOUT",
        "TITLE",
      ]
    `)
    expect(await vexla.script(new Request('https://app.example.com/'))).toMatchInlineSnapshot(
      `"<script type="application/json" id="__vexla">{"BANNER":false,"NEW_CHECKOUT":false,"TITLE":"Hello"}</script>"`,
    )
  })

  test('script escapes a value that would close the element', async () => {
    const vexla = Vexla.create({
      definitions,
      secret,
      store: Store.memory({ values: { TITLE: '</script><script>alert(1)' } }),
    })
    expect(await vexla.script(new Request('https://app.example.com/'))).not.toContain(
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

    expect((await put('PRICING', 'z')).status).toMatchInlineSnapshot(`400`)
    expect((await put('nope', true)).status).toMatchInlineSnapshot(`404`)
    expect((await put('PRICING', 'b')).status).toMatchInlineSnapshot(`200`)
    expect((await (await fetch(`${server.url}/app`)).json()).PRICING).toMatchInlineSnapshot(`"b"`)

    await fetch(`${server.url}/.flags/values/PRICING`, { method: 'DELETE' })
    expect((await (await fetch(`${server.url}/app`)).json()).PRICING).toMatchInlineSnapshot(`"a"`)
    await server.close()
  })

  test('orphan values are listed and may be deleted', async () => {
    const store = Store.memory({ values: { OLD_FLAG: true, TITLE: 'Stored' } })
    const vexla = Vexla.create({ definitions, dev: true, store })
    const manifest = await (
      await vexla.fetch(new Request('https://app.example.com/.flags/manifest'))
    ).json()
    expect(manifest.orphans).toMatchInlineSnapshot(`
      [
        "OLD_FLAG",
      ]
    `)
    const deleted = await vexla.fetch(
      new Request('https://app.example.com/.flags/values/OLD_FLAG', { method: 'DELETE' }),
    )
    expect(deleted.status).toMatchInlineSnapshot(`200`)
    expect(await store.keys!()).toMatchInlineSnapshot(`
      [
        "TITLE",
      ]
    `)
  })

  test('manifest', async () => {
    const server = await serve({ dev: true, store: Store.memory({ values: { TITLE: 'Stored' } }) })
    const manifest = await (await fetch(`${server.url}/.flags/manifest?flag.PRICING=b`)).json()
    expect(manifest.flags.TITLE).toMatchInlineSnapshot(`
      {
        "build": false,
        "default": "Hello",
        "override": null,
        "public": true,
        "source": "store",
        "stale": false,
        "store": "Stored",
        "type": "string",
        "value": "Stored",
      }
    `)
    expect([manifest.flags.PRICING.source, manifest.flags.PRICING.value]).toMatchInlineSnapshot(`
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
      body: JSON.stringify({ values: { PRICING: 'c' } }),
      headers: { 'content-type': 'application/json' },
      method: 'PUT',
    })
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!
    const values = await (await fetch(`${server.url}/app`, { headers: { cookie } })).json()
    expect(values.PRICING).toMatchInlineSnapshot(`"c"`)
    await server.close()
  })

  test('links override a private flag until they expire', async () => {
    const server = await serve({
      authorize() {
        return 'write'
      },
    })
    const { url } = await (
      await fetch(`${server.url}/.flags/links`, {
        body: JSON.stringify({
          expiresAt: Date.now() + 60_000,
          url: '/app',
          values: { PRICING: 'c' },
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
    ).json()
    expect(url).toMatch(/\/app\?flag\.PRICING=c&flag\.exp=\d+&flag\.sig=[\w-]+$/)
    expect((await (await fetch(url)).json()).PRICING).toMatchInlineSnapshot(`"c"`)
    await server.close()
  })

  test('store definitions, and 409 with a flags file', async () => {
    const vexla = Vexla.create({ secret, store: Store.memory() })
    const server = await Http.serve(async (request) =>
      new URL(request.url).pathname.startsWith('/.flags')
        ? vexla.fetch(request)
        : Response.json(await vexla.evaluate(request)),
    )
    // A runtime with no authorize has no access outside dev mode.
    expect(
      (await fetch(`${server.url}/.flags/definitions/BETA`, { body: '{}', method: 'PUT' })).status,
    ).toMatchInlineSnapshot(`401`)
    await server.close()

    const store = Store.memory()
    const open = Vexla.create({ dev: true, store })
    const created = await open.fetch(
      new Request('https://app.example.com/.flags/definitions/BETA', {
        body: JSON.stringify({ default: false, public: true, type: 'boolean' }),
        method: 'PUT',
      }),
    )
    expect(created.status).toMatchInlineSnapshot(`200`)
    expect(
      await open.get(new Request('https://app.example.com/?flag.BETA=true'), 'BETA' as never),
    ).toMatchInlineSnapshot(`true`)

    const invalid = await open.fetch(
      new Request('https://app.example.com/.flags/definitions/GAMMA', {
        body: JSON.stringify({ default: 1, type: 'boolean' }),
        method: 'PUT',
      }),
    )
    expect(invalid.status).toMatchInlineSnapshot(`400`)

    const withFile = Vexla.create({ definitions, dev: true, store })
    const conflict = await withFile.fetch(
      new Request('https://app.example.com/.flags/definitions/BETA', { body: '{}', method: 'PUT' }),
    )
    expect(conflict.status).toMatchInlineSnapshot(`409`)
  })

  test('store definitions unavailable', async () => {
    const vexla = Vexla.create({
      dev: true,
      store: {
        ...Store.memory(),
        definitions: {
          async delete() {},
          async list() {
            throw new Error('database down')
          },
          async set() {},
        },
      },
    })
    await expect(
      vexla.get(new Request('https://app.example.com/'), 'BETA' as never),
    ).rejects.toThrow(Vexla.DefinitionsUnavailableError)
    expect(
      (await vexla.fetch(new Request('https://app.example.com/.flags/manifest'))).status,
    ).toMatchInlineSnapshot(`503`)
  })

  test('cors on the values endpoint only', async () => {
    const vexla = Vexla.create({
      cors: { origins: ['https://web.example.com'] },
      definitions,
      secret,
    })
    const headers = { origin: 'https://web.example.com' }
    const values = await vexla.fetch(
      new Request('https://api.example.com/.flags/values', { headers }),
    )
    expect(values.headers.get('access-control-allow-origin')).toMatchInlineSnapshot(
      `"https://web.example.com"`,
    )

    const other = await vexla.fetch(
      new Request('https://api.example.com/.flags/values', {
        headers: { origin: 'https://evil.example.com' },
      }),
    )
    expect(other.headers.get('access-control-allow-origin')).toMatchInlineSnapshot(`null`)
  })

  test('dev route page', async () => {
    const vexla = Vexla.create({ definitions, dev: true })
    const response = await vexla.fetch(new Request('https://app.example.com/.flags'))
    expect(response.headers.get('content-type')).toMatchInlineSnapshot(`"text/html; charset=utf-8"`)
    expect(await response.text()).toContain('<title>Flags</title>')
  })

  test('outside the path', async () => {
    const vexla = Vexla.create({ definitions, dev: true })
    expect(
      (await vexla.fetch(new Request('https://app.example.com/other'))).status,
    ).toMatchInlineSnapshot(`404`)
  })
})

describe('create', () => {
  test('needs a secret outside dev mode', () => {
    expect(() => Vexla.create({ definitions })).toThrowErrorMatchingInlineSnapshot(
      `[TypeError: \`Vexla.create\` needs \`secret\` outside dev mode. Set \`secret\`, such as from \`VEXLA_SECRET\`.]`,
    )
  })
})
