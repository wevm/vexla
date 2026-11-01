/** @module Checks the types of the values that `test.flags` and `describe.flags` accept. */
import * as vitest from 'vitest'
import { Vexla } from 'vexla/server'
import { create, type Flags } from 'vexla/vitest'

// The shape that `Definitions.generate` writes, with `as const`.
const definitions = {
  BANNER: { build: true, default: false, env: 'BANNER', public: false, type: 'boolean' },
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
} as const

const vexla = Vexla.create({ definitions, dev: true })
const flagged = create({ vexla, vitest })

describe('create', () => {
  test('types the values of test.flags from the definitions', () => {
    flagged.test.flags({ PRICING: 'b' })
    flagged.test.flags({ NEW_CHECKOUT: true, PRICING: 'c' }).flags({ PRICING: 'a' })

    // @ts-expect-error 'd' is not an option of PRICING.
    flagged.test.flags({ PRICING: 'd' })
    // @ts-expect-error No flag declares PRICNG.
    flagged.test.flags({ PRICNG: 'b' })
    // @ts-expect-error BANNER is a build flag.
    flagged.test.flags({ BANNER: true })
  })

  test('types the values of describe.flags from the definitions', () => {
    flagged.describe.flags({ PRICING: 'b' })('block', () => {})
    flagged.describe.flags({ PRICING: 'b' })('block', { skip: true }, () => {})

    // @ts-expect-error 'd' is not an option of PRICING.
    flagged.describe.flags({ PRICING: 'd' })
    // @ts-expect-error BANNER is a build flag.
    flagged.describe.flags({ BANNER: true })
  })

  test('keeps the modifiers of test after test.flags', () => {
    flagged.test.flags({ PRICING: 'b' }).concurrent('concurrent', () => {})
    flagged.test.flags({ PRICING: 'b' }).skip('skip', () => {})
    flagged.test.flags({ PRICING: 'b' }).for([1, 2])('for %i', () => {})
  })

  test('omits build flags from Flags', () => {
    expectTypeOf<Flags<typeof definitions>>().toEqualTypeOf<{
      readonly NEW_CHECKOUT?: boolean
      readonly PRICING?: 'a' | 'b' | 'c'
    }>()
  })

  test('types the flags fixture', () => {
    flagged.test('fixture', (context) => {
      expectTypeOf(context.flags).toEqualTypeOf<Flags<typeof definitions>>()
    })
  })
})
