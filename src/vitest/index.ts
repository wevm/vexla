/**
 * @module Vitest entry: `withFlags` returns test options that set runtime flag values for a test or
 * a block, and `setup` runs each test in `Values.run`. The Vite plugin calls `setup` in a setup
 * file, so a test file imports `test` and `describe` from Vitest.
 */
import type { SuiteOptions, TestContext } from 'vitest'
import * as Definitions from '../Definitions.js'
import type { Registered } from '../index.js'
import * as Errors from '../internal/Errors.js'
import * as Override from '../Override.js'
import * as Values from '../Values.js'
import type * as Vexla from '../server/Vexla.js'

/** Runtime flag values for a test, keyed by flag key. A build flag is a literal, so it is absent. */
export type Flags<definitions = Registered> = {
  readonly [key in keyof definitions as definitions[key] extends { readonly build: true }
    ? never
    : key]?: Definitions.Value<definitions[key]>
}

/**
 * Registers an `aroundEach` hook that runs each test in `Values.run`, with the values that `vexla`
 * evaluates. The values of `withFlags` take precedence over them. The Vite plugin calls it in a
 * setup file, so a project calls it only in its own setup file without the plugin.
 *
 * @throws {Override.UnknownFlagError} When a test sets a key that no flag declares.
 * @throws {Definitions.InvalidValueError} When a test sets a value that is not a value of its flag.
 * @throws {BuildFlagError} When a test sets a value for a build flag.
 */
export function setup(options: setup.Options): void {
  // A browser has no `AsyncLocalStorage`, so a test in browser mode reads the values of the page.
  if (!globalThis.process?.getBuiltinModule) return

  const vexla = options.vexla

  // Vitest requires a destructured context parameter, so this hook is an exception to the rule.
  options.aroundEach(async (runTest, { task }) => {
    // Vitest merges `meta` into each child shallowly, so the values of each level merge here.
    const levels: Readonly<Record<string, Definitions.Json>>[] = []
    for (let current: Level | undefined = task; current; current = current.suite) {
      const values = (current.meta as { vexla?: Record<string, Definitions.Json> }).vexla
      if (values) levels.unshift(values)
    }
    const overrides = Object.assign({}, ...levels) as Record<string, Definitions.Json>

    const definitions = await vexla.definitions()
    for (const [key, value] of Object.entries(overrides)) {
      const definition = definitions[key]
      if (!definition) throw new Override.UnknownFlagError({ key })
      if (definition.build) throw new BuildFlagError({ key })
      if (!Definitions.validate(definition, value))
        throw new Definitions.InvalidValueError({ key, type: definition.type })
    }

    const evaluator: Values.Evaluator = {
      async evaluate(request) {
        return { ...(await vexla.evaluate(request)), ...overrides }
      },
    }
    await Values.run(evaluator, new Request('http://vexla.test/'), runTest)
  })
}

export declare namespace setup {
  type Options = {
    /** The `aroundEach` function of Vitest. */
    aroundEach: (fn: (runTest: () => Promise<void>, context: TestContext) => Promise<void>) => void
    /** The instance whose evaluation supplies every value that a test does not set. */
    vexla: Pick<Vexla.Vexla<any>, 'definitions' | 'evaluate'>
  }

  type ErrorType = BuildFlagError | Definitions.InvalidValueError | Override.UnknownFlagError
}

/**
 * Returns the options of a test or a block that runs with `values`, merged into `options`. A
 * nested block or a test merges its values over the values of the block.
 *
 * @example
 * test('shows annual pricing', withFlags({ PRICING: 'b' }, { timeout: 10_000 }), async () => {})
 */
export function withFlags<const options extends SuiteOptions = {}>(
  values: Flags,
  options: options = {} as options,
): withFlags.ReturnType<options> {
  return { ...options, meta: { ...options.meta, vexla: values } } as never
}

export declare namespace withFlags {
  type ReturnType<options extends SuiteOptions = {}> = options & SuiteOptions
}

/** Thrown when a test sets a value for a build flag, which compiles to a literal. */
export class BuildFlagError extends Errors.BaseError {
  override name = 'Vitest.BuildFlagError'

  /** The key of the flag. */
  readonly key: string

  constructor(options: { key: string }) {
    super(`The build flag ${options.key} accepts no value from a test.`, {
      steps: [`Set ${options.key} in the environment of the test run, such as in \`.env\`.`],
    })
    this.key = options.key
  }
}

// A test or a suite, as far as `setup` reads it.
type Level = { meta: object; suite?: Level | undefined }
