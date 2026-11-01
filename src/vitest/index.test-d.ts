/** @module Checks the types of `withFlags`, `setup`, and the flag values that a test can set. */
import { aroundEach, describe as vitestDescribe, test as vitestTest } from 'vitest'
import { Vexla } from 'vexla/server'
import { type Flags, setup, withFlags } from 'vexla/vitest'

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

describe('Flags', () => {
  test('types runtime flags from the definitions, and omits build flags', () => {
    expectTypeOf<Flags<typeof definitions>>().toEqualTypeOf<{
      readonly NEW_CHECKOUT?: boolean
      readonly PRICING?: 'a' | 'b' | 'c'
    }>()
  })
})

describe('withFlags', () => {
  test('returns options that test and describe of Vitest accept', () => {
    vitestTest('test', withFlags({ PRICING: 'b' }), () => {})
    vitestTest('options', withFlags({ PRICING: 'b' }, { timeout: 10_000 }), () => {})
    vitestDescribe('block', withFlags({ PRICING: 'b' }, { shuffle: true }), () => {})
  })

  test('keeps the options it receives', () => {
    expectTypeOf(withFlags({}, { timeout: 10_000 }).timeout).toEqualTypeOf<10_000>()
  })

  test('rejects a value that is not an option', () => {
    // @ts-expect-error `timeout` is a number.
    withFlags({}, { timeout: 'slow' })
  })
})

describe('setup', () => {
  test('accepts aroundEach of Vitest and an instance', () => {
    setup({ aroundEach, vexla: Vexla.create({ definitions, dev: true }) })
  })
})
