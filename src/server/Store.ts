/**
 * @module Stores: where the admin API keeps flag values, and optionally flag definitions, so a
 * value applies to every request. A host implements `Store` on its own database.
 */
import * as Definitions from '../Definitions.js'
import * as Errors from '../internal/Errors.js'

/** The store contract. A host implements it on its own database, such as a Postgres table. */
export type Store = {
  /** Deletes the value of a flag. */
  delete: (key: string) => Promise<void>
  /** Returns the values of `keys` that the store holds. A key with no value is absent. */
  get: (keys: readonly string[]) => Promise<Record<string, unknown>>
  /** Sets the value of a flag. The runtime validates `value` before the call. */
  set: (key: string, value: Definitions.Json) => Promise<void>
  /**
   * Definition operations. Required only when `Runtime.create` has no `definitions`, so the store
   * declares the flags.
   */
  definitions?:
    | {
        /** Deletes the definition of a flag. */
        delete: (key: string) => Promise<void>
        /** Returns every definition, in the format of a flags file. */
        list: () => Promise<Record<string, unknown>>
        /** Creates or replaces the definition of a flag. */
        set: (key: string, definition: Definitions.Definition) => Promise<void>
      }
    | undefined
}

/** Returns a store in memory, for dev mode and tests. It holds values and definitions. */
export function memory(options: memory.Options = {}): Store {
  const values = new Map<string, Definitions.Json>(Object.entries(options.values ?? {}))
  const definitions = new Map<string, unknown>(Object.entries(options.definitions ?? {}))

  return {
    async delete(key) {
      values.delete(key)
    },
    definitions: {
      async delete(key) {
        definitions.delete(key)
        values.delete(key)
      },
      async list() {
        return Object.fromEntries(definitions)
      },
      async set(key, definition) {
        definitions.set(key, definition)
      },
    },
    async get(keys) {
      return Object.fromEntries(
        keys.filter((key) => values.has(key)).map((key) => [key, values.get(key)]),
      )
    },
    async set(key, value) {
      values.set(key, value)
    },
  }
}

export declare namespace memory {
  type Options = {
    /** Definitions to start with, in the format of a flags file. */
    definitions?: Record<string, unknown> | undefined
    /** Values to start with. */
    values?: Record<string, Definitions.Json> | undefined
  }
}

/**
 * Returns a store over `FEATURE_*` variables, read only. It holds no definitions. A write throws
 * `ReadOnlyError`.
 */
export function env(
  variables: Readonly<Record<string, string | undefined>>,
  options: env.Options = {},
): Store {
  return {
    async delete(key) {
      throw new ReadOnlyError({ key })
    },
    async get(keys) {
      const prefix = options.envPrefix ?? Definitions.envPrefix
      return Object.fromEntries(
        keys.flatMap((key) => {
          const raw = variables[Definitions.envOf(key, prefix)]
          return raw === undefined ? [] : [[key, raw]]
        }),
      )
    },
    async set(key) {
      throw new ReadOnlyError({ key })
    },
  }
}

export declare namespace env {
  type Options = {
    /** The prefix of flag environment variables. @default 'FEATURE_' */
    envPrefix?: string | undefined
  }
}

/** Returns `store` unchanged, typed as a `Store`. A host store implements the contract directly. */
export function from(store: Store): Store {
  return store
}

/** Thrown when a write reaches a read-only store. */
export class ReadOnlyError extends Errors.BaseError {
  override name = 'Store.ReadOnlyError'

  constructor(options: { key: string }) {
    super(`The store is read only, so it cannot write the value of ${options.key}.`, {
      steps: ['Use a writable store, such as `Store.from` on a database table.'],
    })
  }
}
