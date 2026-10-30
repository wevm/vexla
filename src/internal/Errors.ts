/** @module The base of the errors that Flargs throws: what failed, then the steps that resolve it. */

/**
 * An error whose message states what failed, then the steps that resolve it. `details` and
 * `steps` hold the two parts, so a CLI or an agent can render them separately.
 */
export class BaseError extends Error {
  /** What failed, without the steps. */
  readonly details: string
  /** The steps that resolve the error, in order. Empty when no step applies. */
  readonly steps: readonly string[]

  constructor(details: string, options: BaseError.Options = {}) {
    super(format(details, options.steps ?? []), { cause: options.cause })
    this.details = details
    this.steps = options.steps ?? []
  }
}

export declare namespace BaseError {
  type Options = {
    /** The error that caused this one. */
    cause?: unknown
    /** The steps that resolve the error, in order. Each is one imperative sentence. */
    steps?: readonly string[] | undefined
  }
}

/** Returns the message of `error` on one line, for output that cannot hold line breaks. */
export function inline(error: Error): string {
  if (!(error instanceof BaseError) || error.steps.length === 0) return error.message
  if (error.steps.length === 1) return `${error.details} To resolve: ${error.steps[0]}`
  return `${error.details} To resolve: ${error.steps.map((step, index) => `${index + 1}. ${step}`).join(' ')}`
}

/** Returns the message with its steps: one step after `To resolve:`, or a numbered list. */
function format(details: string, steps: readonly string[]): string {
  if (steps.length === 0) return details
  if (steps.length === 1) return `${details}\n\nTo resolve: ${steps[0]}`
  return `${details}\n\nTo resolve:\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`
}
