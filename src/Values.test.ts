/** @module Reads flags inside and outside a request scope. */
import { Definitions, flags, Values } from 'flargs'
import { Flargs } from 'flargs/server'

const definitions = Definitions.parse({
  pricing: { default: 'a', options: ['a', 'b', 'c'], type: 'select' },
})

describe('run', () => {
  test('concurrent requests read their own values', async () => {
    const flargs = Flargs.create({ definitions, dev: true })
    const read = (value: string) =>
      Values.run(
        flargs,
        new Request(`https://app.example.com/?flag.pricing=${value}`),
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          return flags['pricing']
        },
      )

    expect(await Promise.all([read('b'), read('c')])).toMatchInlineSnapshot(`
      [
        "b",
        "c",
      ]
    `)
  })
})

describe('flags', () => {
  test('outside a request, FEATURE_* variables apply, as in zero config', () => {
    process.env['FEATURE_ZERO_CONFIG_TEST'] = 'true'
    expect(flags['zeroConfigTest']).toMatchInlineSnapshot(`true`)
    delete process.env['FEATURE_ZERO_CONFIG_TEST']
    expect(flags['zeroConfigTest']).toMatchInlineSnapshot(`undefined`)
  })
})
