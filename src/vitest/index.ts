/**
 * @module Vitest entry: `test` and `describe` functions whose `flags` modifier sets runtime flag
 * values for a test or a block. Each test runs in `Values.run`, so `flags` reads those values.
 */
import type { SuiteAPI, TestAPI, TestContext } from 'vitest'
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

/** The `describe` function, with `describe.flags`. */
export type Describe<definitions = Registered> = SuiteAPI & {
  /**
   * Returns a `describe` function whose tests run with `values`. A nested block or a test merges
   * its own values over the values of the block.
   */
  flags: (values: Flags<definitions>) => DescribeWithFlags
}

/** A `describe` function that `describe.flags` returns. */
export type DescribeWithFlags = {
  (name: string, fn: () => void | Promise<void>): void
  (name: string, options: DescribeOptions, fn: () => void | Promise<void>): void
}

/** The options of `describe`, such as `skip` or `concurrent`. */
export type DescribeOptions = Exclude<Parameters<SuiteAPI>[1], Function | number | undefined>

/** The `test` function, with `test.flags`. */
export type Test<definitions = Registered, context extends object = object> = TestAPI<
  context & { flags: Flags<definitions> }
> & {
  /**
   * Returns a `test` function whose tests run with `values`. Chained calls merge, and modifiers
   * such as `concurrent`, `skip`, and `for` follow the call.
   */
  flags: (values: Flags<definitions>) => Test<definitions, context>
}

/**
 * Returns `test` and `describe` functions for `vexla`. Each test runs in `Values.run` with the
 * values that `vexla` evaluates, and the values of `test.flags` and `describe.flags` take
 * precedence over them.
 *
 * @throws {Override.UnknownFlagError} When a test runs with a key that no flag declares.
 * @throws {Definitions.InvalidValueError} When a test runs with a value that is not a value of its flag.
 * @throws {BuildFlagError} When a test runs with a value for a build flag.
 */
export function create<
  const definitions extends Definitions.Definitions = Registered & Definitions.Definitions,
  const context extends object = object,
>(options: create.Options<definitions, context>): create.ReturnType<definitions, context> {
  const vexla = options.vexla
  // The overloads of `extend` do not infer a fixture that holds plain data, so `Api` narrows them.
  const base = (options.vitest.test as unknown as Api).extend({ flags: {} })

  // Vitest requires a destructured fixture parameter, so this hook is an exception to the rule.
  base.aroundEach(async (runTest, { flags, task }) => {
    // Vitest merges the `meta` of a suite into its children shallowly, so each level merges here.
    const suites: Readonly<Record<string, Definitions.Json>>[] = []
    for (let suite = task.suite; suite; suite = suite.suite) {
      const values = (suite.meta as { vexla?: Record<string, Definitions.Json> }).vexla
      if (values) suites.unshift(values)
    }
    const overrides = Object.assign({}, ...suites, flags) as Record<string, Definitions.Json>

    const request = new Request('http://vexla.test/')
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
    await Values.run(evaluator, request, runTest)
  })

  const test = (api: Api, current: Flags<definitions>): Test<definitions, context> =>
    Object.assign(api, {
      flags(values: Flags<definitions>) {
        const merged = { ...current, ...values }
        return test(base.extend({ flags: merged }), merged)
      },
    }) as never

  const flags = (values: Flags<definitions>): DescribeWithFlags => {
    return (
      name: string,
      ...rest: [DescribeOptions, () => void | Promise<void>] | [() => void | Promise<void>]
    ) => {
      const describeOptions = rest.length === 2 ? rest[0] : {}
      const fn = rest.length === 2 ? rest[1] : rest[0]
      options.vitest.describe(
        name,
        { ...describeOptions, meta: { ...describeOptions.meta, vexla: values } as never },
        fn,
      )
    }
  }

  // A proxy adds `flags` without a change to the `describe` of Vitest, which other files share.
  const describe = new Proxy(options.vitest.describe, {
    get(target, key, receiver) {
      if (key === 'flags') return flags
      return Reflect.get(target, key, receiver)
    },
  }) as Describe<definitions>

  return { describe, test: test(base, {}) }
}

export declare namespace create {
  type Options<
    definitions extends Definitions.Definitions = Definitions.Definitions,
    context extends object = object,
  > = {
    /** The instance whose evaluation supplies every value that the test does not set. */
    vexla: Vexla.Vexla<definitions>
    /** The `describe` and `test` functions of Vitest, such as `import * as vitest from 'vitest'`. */
    vitest: { describe: SuiteAPI; test: TestAPI<context> }
  }

  type ReturnType<
    definitions extends Definitions.Definitions = Definitions.Definitions,
    context extends object = object,
  > = {
    /** `describe`, with `describe.flags`. */
    describe: Describe<definitions>
    /** `test`, with the `flags` fixture and `test.flags`. */
    test: Test<definitions, context>
  }

  type ErrorType = BuildFlagError | Definitions.InvalidValueError | Override.UnknownFlagError
}

// The part of a Vitest `test` function that `create` calls.
type Api = {
  aroundEach: (
    fn: (
      runTest: () => Promise<void>,
      context: { flags: Readonly<Record<string, Definitions.Json>>; task: TestContext['task'] },
    ) => Promise<void>,
  ) => void
  extend: (fixtures: { flags: object }) => Api
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
