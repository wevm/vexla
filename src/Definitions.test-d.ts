/** @module Checks the value types that a generated module produces. */
import type { Definitions } from 'vexla'

// The shape that `Definitions.generate` writes, with `as const`.
const definitions = {
  LIMITS: {
    build: false,
    default: { requests: 100 },
    env: 'LIMITS',
    public: false,
    type: 'json',
  },
  NEW_CHECKOUT: {
    build: false,
    default: false,
    env: 'NEW_CHECKOUT',
    public: true,
    type: 'boolean',
  },
  PRICING: {
    build: false,
    default: 'a',
    env: 'PRICING',
    options: ['a', 'b', 'c'],
    public: false,
    type: 'select',
  },
  RETRIES: { build: false, default: 3, env: 'RETRIES', public: false, type: 'number' },
  TITLE: { build: false, default: 'Hello', env: 'TITLE', public: false, type: 'string' },
} as const

type Values = Definitions.Values<typeof definitions>

describe('Values', () => {
  test('maps each type to its value type', () => {
    expectTypeOf<Values['NEW_CHECKOUT']>().toEqualTypeOf<boolean>()
    expectTypeOf<Values['PRICING']>().toEqualTypeOf<'a' | 'b' | 'c'>()
    expectTypeOf<Values['RETRIES']>().toEqualTypeOf<number>()
    expectTypeOf<Values['TITLE']>().toEqualTypeOf<string>()
    expectTypeOf<Values['LIMITS']>().toEqualTypeOf<{ readonly requests: number }>()
  })

  test('rejects an undeclared key', () => {
    // @ts-expect-error `nope` is not a flag.
    expectTypeOf<Values['nope']>()
  })
})
