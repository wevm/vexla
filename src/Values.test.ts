/** @module Reads flags inside and outside a request scope. */
import { Definitions, flags, Values } from 'flargs'
import { Flargs } from 'flargs/server'

const definitions = Definitions.parse({
  PRICING: { default: 'a', options: ['a', 'b', 'c'], type: 'select' },
})

describe('run', () => {
  test('concurrent requests read their own values', async () => {
    const flargs = Flargs.create({ definitions, dev: true })
    const read = (value: string) =>
      Values.run(
        flargs,
        new Request(`https://app.example.com/?flag.PRICING=${value}`),
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          return flags['PRICING']
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
    process.env['ZERO_CONFIG_TEST'] = 'true'
    expect(flags['ZERO_CONFIG_TEST']).toMatchInlineSnapshot(`true`)
    delete process.env['ZERO_CONFIG_TEST']
    expect(flags['ZERO_CONFIG_TEST']).toMatchInlineSnapshot(`undefined`)
  })
})
