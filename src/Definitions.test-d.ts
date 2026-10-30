/** @module Checks the value types that a generated module produces. */
import type { Definitions } from 'flargs'

// The shape that `Definitions.generate` writes, with `as const`.
const definitions = {
  limits: {
    build: false,
    default: { requests: 100 },
    env: 'FEATURE_LIMITS',
    public: false,
    type: 'json',
  },
  newCheckout: {
    build: false,
    default: false,
    env: 'FEATURE_NEW_CHECKOUT',
    public: true,
    type: 'boolean',
  },
  pricing: {
    build: false,
    default: 'a',
    env: 'FEATURE_PRICING',
    options: ['a', 'b', 'c'],
    public: false,
    type: 'select',
  },
  retries: { build: false, default: 3, env: 'FEATURE_RETRIES', public: false, type: 'number' },
  title: { build: false, default: 'Hello', env: 'FEATURE_TITLE', public: false, type: 'string' },
} as const

type Values = Definitions.Values<typeof definitions>

describe('Values', () => {
  test('maps each type to its value type', () => {
    expectTypeOf<Values['newCheckout']>().toEqualTypeOf<boolean>()
    expectTypeOf<Values['pricing']>().toEqualTypeOf<'a' | 'b' | 'c'>()
    expectTypeOf<Values['retries']>().toEqualTypeOf<number>()
    expectTypeOf<Values['title']>().toEqualTypeOf<string>()
    expectTypeOf<Values['limits']>().toEqualTypeOf<{ readonly requests: number }>()
  })

  test('rejects an undeclared key', () => {
    // @ts-expect-error `nope` is not a flag.
    expectTypeOf<Values['nope']>()
  })
})
