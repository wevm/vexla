/** @module Runs a fixture test file in a real Vitest run, and asserts the result of each test. */
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import * as Stream from 'node:stream'
import { startVitest } from 'vitest/node'

const src = Path.resolve(import.meta.dirname, '..')

const setup = `
import * as vitest from 'vitest'
import { Definitions, flags } from 'vexla'
import { Vexla } from 'vexla/server'
import { create } from 'vexla/vitest'

const definitions = Definitions.parse({
  BANNER: { build: true, default: false, type: 'boolean' },
  LIMITS: { default: { requests: 100 }, type: 'json' },
  NEW_CHECKOUT: { default: false, public: true, type: 'boolean' },
  PRICING: { default: 'a', options: ['a', 'b', 'c'], type: 'select' },
})

const vexla = Vexla.create({
  decide: {
    LIMITS() {
      return { requests: 5 }
    },
  },
  definitions,
  dev: true,
})

const { describe, test } = create({ vexla, vitest })

// Each read waits first, so a value that leaks between concurrent tests fails an assertion.
async function read(key: string) {
  await new Promise((resolve) => setTimeout(resolve, 10))
  return (flags as Record<string, unknown>)[key]
}
`

/** Runs `source` after the setup in a real Vitest run, and returns the state and error of each test. */
async function run(source: string) {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'vexla-vitest-'))
  Fs.writeFileSync(Path.join(root, 'flags.test.ts'), `${setup}\n${source}`)

  const vitest = await startVitest(
    'test',
    [],
    { config: false, reporters: [], root, watch: false },
    {
      resolve: {
        alias: [
          { find: 'vexla/server', replacement: Path.join(src, 'server/index.ts') },
          { find: 'vexla/vitest', replacement: Path.join(src, 'vitest/index.ts') },
          { find: /^vexla$/, replacement: Path.join(src, 'index.ts') },
        ],
      },
    },
    // The outer run reports the results, so the output of the inner run is discarded.
    { stderr: discard(), stdout: discard() },
  )

  try {
    const results: Record<string, string> = {}
    for (const module of vitest.state.getTestModules())
      for (const testCase of module.children.allTests()) {
        const result = testCase.result()
        const error = result.errors?.[0]?.message.split('\n')[0]
        results[testCase.fullName] = error ? `${result.state}: ${error}` : result.state
      }
    return results
  } finally {
    await vitest.close()
    Fs.rmSync(root, { force: true, recursive: true })
  }
}

function discard() {
  return new Stream.Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
}

describe('create', () => {
  test('runs each test with the values of test.flags and describe.flags', async () => {
    const results = await run(`
test('reads the evaluated values', async ({ expect }) => {
  expect(await read('PRICING')).toBe('a')
  expect(await read('LIMITS')).toEqual({ requests: 5 })
})

test.flags({ PRICING: 'b' })('reads the values of test.flags', async ({ expect }) => {
  expect(await read('PRICING')).toBe('b')
  expect(await read('LIMITS')).toEqual({ requests: 5 })
})

test.flags({ PRICING: 'b' }).flags({ NEW_CHECKOUT: true })('merges chained calls', async ({ expect }) => {
  expect(await read('PRICING')).toBe('b')
  expect(await read('NEW_CHECKOUT')).toBe(true)
})

test.flags({ PRICING: 'b' }).concurrent('isolates concurrent b', async ({ expect }) => {
  expect(await read('PRICING')).toBe('b')
})

test.flags({ PRICING: 'c' }).concurrent('isolates concurrent c', async ({ expect }) => {
  expect(await read('PRICING')).toBe('c')
})

test.flags({ PRICING: 'b' }).for([1, 2])('runs each case of for %i', async (_, { expect }) => {
  expect(await read('PRICING')).toBe('b')
})

test.flags({ PRICING: 'b' }).skip('skips', () => {
  throw new Error('The skipped test ran.')
})

describe.flags({ PRICING: 'c' })('block', () => {
  test('reads the values of the block', async ({ expect }) => {
    expect(await read('PRICING')).toBe('c')
  })

  test.flags({ NEW_CHECKOUT: true })('merges test.flags over the block', async ({ expect }) => {
    expect(await read('PRICING')).toBe('c')
    expect(await read('NEW_CHECKOUT')).toBe(true)
  })

  describe.flags({ NEW_CHECKOUT: true })('nested block', () => {
    test('merges the values of each block', async ({ expect }) => {
      expect(await read('PRICING')).toBe('c')
      expect(await read('NEW_CHECKOUT')).toBe(true)
    })

    test.flags({ PRICING: 'a' })('lets test.flags take precedence', async ({ expect }) => {
      expect(await read('PRICING')).toBe('a')
    })
  })
})

describe.flags({ PRICING: 'b' })('skipped block', { skip: true }, () => {
  test('skips', () => {
    throw new Error('The skipped block ran.')
  })
})

describe('plain block', () => {
  test('reads the evaluated values', async ({ expect }) => {
    expect(await read('PRICING')).toBe('a')
  })
})
`)

    expect(results).toMatchInlineSnapshot(`
      {
        "block > merges test.flags over the block": "passed",
        "block > nested block > lets test.flags take precedence": "passed",
        "block > nested block > merges the values of each block": "passed",
        "block > reads the values of the block": "passed",
        "isolates concurrent b": "passed",
        "isolates concurrent c": "passed",
        "merges chained calls": "passed",
        "plain block > reads the evaluated values": "passed",
        "reads the evaluated values": "passed",
        "reads the values of test.flags": "passed",
        "runs each case of for 1": "passed",
        "runs each case of for 2": "passed",
        "skipped block > skips": "skipped",
        "skips": "skipped",
      }
    `)
  })

  test('fails a test with an unknown key, an invalid value, or a build flag', async () => {
    const results = await run(`
test.flags({ PRICNG: 'b' } as never)('unknown key', () => {})

test.flags({ PRICING: 'd' } as never)('invalid value', () => {})

test.flags({ BANNER: true } as never)('build flag', () => {})

describe.flags({ PRICING: 'd' } as never)('block', () => {
  test('invalid value of the block', () => {})
})
`)

    expect(results).toMatchInlineSnapshot(`
      {
        "block > invalid value of the block": "failed: The value of PRICING is not a select value of the flag.",
        "build flag": "failed: The build flag BANNER accepts no value from a test.",
        "invalid value": "failed: The value of PRICING is not a select value of the flag.",
        "unknown key": "failed: No flag declares the key PRICNG.",
      }
    `)
  })
})
