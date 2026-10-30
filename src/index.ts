/** @module Core entry: definitions, overrides, and the flag values of the current request or page. */
import type * as Definitions_ from './Definitions.js'

export * as Definitions from './Definitions.js'
export * as Override from './Override.js'
export { flags } from './Values.js'
export * as Values from './Values.js'

/**
 * Holds the definitions of the project for type inference. `flargs.gen.ts` augments it with
 * `definitions`, so every read of a flag carries its type.
 */
export interface Register {}

/** The registered definitions, or any definitions when the project registers none. */
export type Registered = Register extends { definitions: infer definitions }
  ? definitions
  : Definitions_.Definitions
