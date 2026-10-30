/** @module Runs the override vectors, which TypeScript and Rust share. */
import { Definitions, Override } from 'flargs'
import vectors from '../test/vectors/overrides.json' with { type: 'json' }

const definitions = Definitions.parse(vectors.definitions)

describe('parse', () => {
  for (const vector of vectors.cases)
    test(vector.name, async () => {
      const promise = Override.parse(vector.query, {
        definitions,
        dev: 'dev' in vector ? vector.dev : false,
        now: 'now' in vector ? vector.now : vectors.now,
        secret: 'secret' in vector ? (vector.secret ?? undefined) : vectors.secret,
      })

      if ('throws' in vector) {
        const error = await promise.catch((error: unknown) => error)
        expect(error).toBeInstanceOf(Override.InvalidSignatureError)
        expect((error as Override.InvalidSignatureError).reason).toBe(vector.throws)
        return
      }

      const result = await promise
      expect(result.values).toEqual(vector.values)
      expect(result.errors.map((error) => error.name)).toEqual(vector.errors)
      expect(result.reset).toBe('reset' in vector ? vector.reset : false)
      expect(result.signed).toBe('signed' in vector ? vector.signed : false)
    })

  test('accepts a URL', async () => {
    const result = await Override.parse(new URL('https://app.example.com/?flag.newCheckout=true'), {
      definitions,
    })
    expect(result.values).toMatchInlineSnapshot(`
      {
        "newCheckout": true,
      }
    `)
  })
})

describe('serialize', () => {
  for (const vector of vectors.serialize)
    test(vector.name, async () => {
      const params = await Override.serialize(
        vector.values,
        'unsigned' in vector ? {} : { expiresAt: vector.expiresAt, secret: vectors.secret },
      )
      expect(params.toString()).toBe(new URLSearchParams(vector.query).toString())
    })

  test('round trip', async () => {
    const params = await Override.serialize(
      { limits: { requests: 7 }, pricing: 'b' },
      { expiresAt: vectors.now + 60_000, secret: vectors.secret },
    )
    const result = await Override.parse(params, {
      definitions,
      now: vectors.now,
      secret: vectors.secret,
    })
    expect(result.values).toMatchInlineSnapshot(`
      {
        "limits": {
          "requests": 7,
        },
        "pricing": "b",
      }
    `)
  })

  test('secret without expiresAt', async () => {
    await expect(
      Override.serialize({ pricing: 'b' }, { secret: vectors.secret }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[TypeError: \`serialize\` needs \`expiresAt\` with \`secret\`. Set \`expiresAt\` in milliseconds since the epoch.]`,
    )
  })
})
