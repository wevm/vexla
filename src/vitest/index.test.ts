/**
 * @module Runs a fixture project in a real Vitest run with the Vite plugin, and asserts the result of
 * each test.
 */
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import * as Stream from 'node:stream'
import { startVitest } from 'vite-plus/test/node'
import vexla from 'vexla/vite'

const src = Path.resolve(import.meta.dirname, '..')

const flagsFile = [
  '# @type {boolean} @build',
  'BANNER=false',
  '',
  'LIMITS={"requests":100}',
  '',
  '# @type {boolean} @public',
  'NEW_CHECKOUT=false',
  '',
  "# @type {'a' | 'b' | 'c'}",
  'PRICING=a',
  '',
].join('\n')

const setup = `
import { describe, test } from 'vite-plus/test'
import { flags } from 'vexla'
import { withFlags } from 'vexla/vitest'

// Each read waits first, so a value that leaks between concurrent tests fails an assertion.
const tick = () => new Promise((resolve) => setTimeout(resolve, 10))
`

/**
 * Runs `source` after the setup in a real Vitest run, and returns the state and error of each test.
 * The project lives in this directory, so `vite-plus/test` resolves as it does for a project.
 */
async function run(source: string) {
  const root = Fs.mkdtempSync(Path.join(import.meta.dirname, '.vitest-'))
  Fs.writeFileSync(Path.join(root, '.env.flags'), flagsFile)
  Fs.writeFileSync(Path.join(root, '.env'), 'LIMITS={"requests":5}\n')
  Fs.writeFileSync(Path.join(root, 'flags.test.ts'), `${setup}\n${source}`)

  try {
    const vitest = await startVitest(
      'test',
      [],
      { config: false, reporters: [], root, watch: false },
      {
        plugins: [vexla()],
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

    const results: Record<string, string> = {}
    for (const module of vitest.state.getTestModules())
      for (const testCase of module.children.allTests()) {
        const result = testCase.result()
        const error = result.errors?.[0]?.message.split('\n')[0]
        results[testCase.fullName] = error ? `${result.state}: ${error}` : result.state
      }
    await vitest.close()
    return results
  } finally {
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

describe('withFlags', () => {
  test('runs each test with the values of withFlags, over the values of the environment', async () => {
    const results = await run(`
test('reads the default, the environment, and the literal of a build flag', async ({ expect }) => {
  await tick()
  expect(flags.PRICING).toBe('a')
  expect(flags.LIMITS).toEqual({ requests: 5 })
  expect(flags.BANNER).toBe(false)
})

test('reads the values of withFlags', withFlags({ PRICING: 'b' }), async ({ expect }) => {
  await tick()
  expect(flags.PRICING).toBe('b')
  expect(flags.LIMITS).toEqual({ requests: 5 })
})

test('keeps the options', withFlags({ PRICING: 'b' }, { retry: 2 }), ({ expect, task }) => {
  expect(task.retry).toBe(2)
})

test.concurrent('isolates concurrent b', withFlags({ PRICING: 'b' }), async ({ expect }) => {
  await tick()
  expect(flags.PRICING).toBe('b')
})

test.concurrent('isolates concurrent c', withFlags({ PRICING: 'c' }), async ({ expect }) => {
  await tick()
  expect(flags.PRICING).toBe('c')
})

test.for([1, 2])('runs each case of for %i', withFlags({ PRICING: 'b' }), async (_, { expect }) => {
  await tick()
  expect(flags.PRICING).toBe('b')
})

describe('block', withFlags({ PRICING: 'c' }), () => {
  test('reads the values of the block', async ({ expect }) => {
    await tick()
    expect(flags.PRICING).toBe('c')
  })

  test('merges a test over the block', withFlags({ NEW_CHECKOUT: true }), async ({ expect }) => {
    await tick()
    expect(flags.PRICING).toBe('c')
    expect(flags.NEW_CHECKOUT).toBe(true)
  })

  describe('nested block', withFlags({ NEW_CHECKOUT: true }), () => {
    test('merges the values of each block', async ({ expect }) => {
      await tick()
      expect(flags.PRICING).toBe('c')
      expect(flags.NEW_CHECKOUT).toBe(true)
    })

    test('lets a test take precedence', withFlags({ PRICING: 'a' }), async ({ expect }) => {
      await tick()
      expect(flags.PRICING).toBe('a')
    })
  })
})

describe('skipped block', withFlags({ PRICING: 'b' }, { skip: true }), () => {
  test('skips', () => {
    throw new Error('The skipped block ran.')
  })
})

describe('plain block', () => {
  test('reads the default', async ({ expect }) => {
    await tick()
    expect(flags.PRICING).toBe('a')
  })
})
`)

    expect(results).toMatchInlineSnapshot(`
      {
        "block > merges a test over the block": "passed",
        "block > nested block > lets a test take precedence": "passed",
        "block > nested block > merges the values of each block": "passed",
        "block > reads the values of the block": "passed",
        "isolates concurrent b": "passed",
        "isolates concurrent c": "passed",
        "keeps the options": "passed",
        "plain block > reads the default": "passed",
        "reads the default, the environment, and the literal of a build flag": "passed",
        "reads the values of withFlags": "passed",
        "runs each case of for 1": "passed",
        "runs each case of for 2": "passed",
        "skipped block > skips": "skipped",
      }
    `)
  })

  test('fails a test with an unknown key, an invalid value, or a build flag', async () => {
    const results = await run(`
test('unknown key', withFlags({ PRICNG: 'b' } as never), () => {})

test('invalid value', withFlags({ PRICING: 'd' } as never), () => {})

test('build flag', withFlags({ BANNER: true } as never), () => {})

describe('block', withFlags({ PRICING: 'd' } as never), () => {
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
