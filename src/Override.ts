/**
 * @module Overrides: the `flag.*` search parameters and the `vexla` cookie that override flag
 * values for one browser, with HMAC-SHA256 signatures for private flags and share links.
 */
import * as Definitions from './Definitions.js'
import * as Errors from './internal/Errors.js'

/** The name of the cookie that holds the overrides of a browser. */
export const cookie = 'vexla'

/** The prefix of override search parameters. */
export const prefix = 'flag.'

/** The overrides of a request, after verification and validation. */
export type Overrides = {
  /** Overrides that were dropped, with the reason. A dropped override never selects a value. */
  readonly errors: readonly Errors.BaseError[]
  /** The expiry of a signed override, in milliseconds since the epoch. */
  readonly expiresAt?: number | undefined
  /** `true` when the input holds `flag.reset`, which clears every override. */
  readonly reset: boolean
  /** `true` when a valid signature covers the overrides. */
  readonly signed: boolean
  /** The override values, keyed by flag key. */
  readonly values: Readonly<Record<string, Definitions.Json>>
}

/**
 * Returns the overrides in `input`: a URL, its search parameters, or a cookie value.
 *
 * - In dev mode, every flag accepts an unsigned override.
 * - In production, an unsigned override applies to a public runtime flag only. A signed override
 *   applies to any runtime flag. A build flag accepts no override.
 *
 * Unknown keys, invalid values, and flags that do not accept the override are dropped, and each
 * is reported in `errors`.
 *
 * @throws {InvalidSignatureError} When `flag.sig` does not match, or the signature has expired.
 */
export async function parse(
  input: URL | URLSearchParams | string,
  options: parse.Options,
): Promise<Overrides> {
  const params = (() => {
    if (input instanceof URL) return input.searchParams
    if (input instanceof URLSearchParams) return input
    return new URLSearchParams(input)
  })()

  const raw = new Map<string, string>()
  for (const [name, value] of params)
    if (name.startsWith(prefix) && !['flag.exp', 'flag.reset', 'flag.sig'].includes(name))
      raw.set(name.slice(prefix.length), value)

  const reset = params.has('flag.reset')
  const signature = params.get('flag.sig')
  const exp = params.get('flag.exp')

  const expiresAt = await (async () => {
    if (signature === null) return undefined

    if (!options.secret) throw new InvalidSignatureError({ reason: 'missing secret' })
    const seconds = exp === null ? Number.NaN : Number(exp)
    if (!Number.isInteger(seconds)) throw new InvalidSignatureError({ reason: 'missing expiry' })

    const valid = await verify(canonical(raw, exp ?? ''), signature, options.secret)
    if (!valid) throw new InvalidSignatureError({ reason: 'mismatch' })

    const expiresAt = seconds * 1000
    if (expiresAt <= (options.now ?? Date.now()))
      throw new InvalidSignatureError({ reason: 'expired' })
    return expiresAt
  })()

  const signed = expiresAt !== undefined
  const errors: Errors.BaseError[] = []
  const values: Record<string, Definitions.Json> = {}

  for (const [key, text] of raw) {
    const definition = options.definitions[key]
    if (!definition) {
      errors.push(new UnknownFlagError({ key }))
      continue
    }

    if (definition.build && !options.dev) {
      errors.push(new NotOverridableError({ key, reason: 'build' }))
      continue
    }

    if (!definition.public && !signed && !options.dev) {
      errors.push(new NotOverridableError({ key, reason: 'private' }))
      continue
    }

    try {
      values[key] = Definitions.decode(definition, text, key)
    } catch (error) {
      errors.push(error as Errors.BaseError)
    }
  }

  return { errors, ...(expiresAt !== undefined ? { expiresAt } : {}), reset, signed, values }
}

export declare namespace parse {
  type Options = {
    /** The definitions of the project. */
    definitions: Definitions.Definitions
    /** Dev mode: every flag accepts an unsigned override. @default false */
    dev?: boolean | undefined
    /** The current time, in milliseconds since the epoch. @default Date.now() */
    now?: number | undefined
    /** The HMAC secret, such as `VEXLA_SECRET`. A signed input needs it. */
    secret?: string | undefined
  }
  type ErrorType = InvalidSignatureError
}

/**
 * Returns the search parameters of `values`. With `secret`, it adds `flag.exp` and `flag.sig`, so
 * the overrides apply to private flags until `expiresAt`.
 */
export async function serialize(
  values: Readonly<Record<string, Definitions.Json>>,
  options: serialize.Options = {},
): Promise<URLSearchParams> {
  const raw = new Map(
    Object.entries(values)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map((entry) => [entry[0], Definitions.encode(entry[1])]),
  )

  const params = new URLSearchParams()
  for (const [key, value] of raw) params.set(prefix + key, value)
  if (!options.secret) return params

  if (options.expiresAt === undefined)
    throw new TypeError(
      '`serialize` needs `expiresAt` with `secret`. Set `expiresAt` in milliseconds since the epoch.',
    )

  const exp = String(Math.floor(options.expiresAt / 1000))
  params.set('flag.exp', exp)
  params.set('flag.sig', await sign(canonical(raw, exp), options.secret))
  return params
}

export declare namespace serialize {
  type Options = {
    /** The expiry of the signature, in milliseconds since the epoch. Required with `secret`. */
    expiresAt?: number | undefined
    /** The HMAC secret, such as `VEXLA_SECRET`. */
    secret?: string | undefined
  }
}

/** Thrown when an override signature does not match, or has expired. */
export class InvalidSignatureError extends Errors.BaseError {
  override name = 'Override.InvalidSignatureError'

  /** Why the signature was rejected. */
  readonly reason: InvalidSignatureError.Reason

  constructor(options: { reason: InvalidSignatureError.Reason }) {
    super(messages[options.reason], {
      steps: [
        options.reason === 'missing secret'
          ? 'Set `secret` on the runtime, such as from `VEXLA_SECRET`.'
          : 'Request a new link with `vexla link`, or `POST /.flags/links`.',
      ],
    })
    this.reason = options.reason
  }
}

export declare namespace InvalidSignatureError {
  type Reason = 'expired' | 'mismatch' | 'missing expiry' | 'missing secret'
}

/** Reported when an override names a flag that does not accept it. */
export class NotOverridableError extends Errors.BaseError {
  override name = 'Override.NotOverridableError'

  /** The key of the flag. */
  readonly key: string

  constructor(options: { key: string; reason: 'build' | 'private' }) {
    super(
      options.reason === 'build'
        ? `The build flag ${options.key} accepts no override outside dev mode.`
        : `The private flag ${options.key} accepts only a signed override outside dev mode.`,
      {
        steps: [
          options.reason === 'build'
            ? 'Set the variable of the flag for the build, or override it in dev mode.'
            : 'Request a signed link with `vexla link`, or `POST /.flags/links`.',
        ],
      },
    )
    this.key = options.key
  }
}

/** Reported when an override names a key that no flag declares. */
export class UnknownFlagError extends Errors.BaseError {
  override name = 'Override.UnknownFlagError'

  /** The key in the override. */
  readonly key: string

  constructor(options: { key: string }) {
    super(`No flag declares the key ${options.key}.`, {
      steps: ['Check the key against the flags file.'],
    })
    this.key = options.key
  }
}

const messages: Record<InvalidSignatureError.Reason, string> = {
  expired: 'The override signature has expired.',
  mismatch: 'The override signature does not match the overrides.',
  'missing expiry': 'The signed override has no valid `flag.exp`.',
  'missing secret': 'The override is signed, but the runtime has no secret to verify it.',
}

/** The signed text: each `key=value` pair in key order, then `exp=<seconds>`, joined with `&`. */
function canonical(raw: ReadonlyMap<string, string>, exp: string): string {
  return [
    ...[...raw].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((entry) => `${entry[0]}=${entry[1]}`),
    `exp=${exp}`,
  ].join('&')
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign', 'verify'],
  )
}

async function sign(text: string, secret: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(text)),
  )
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// `crypto.subtle.verify` compares in constant time.
async function verify(text: string, signature: string, secret: string): Promise<boolean> {
  const bytes = (() => {
    try {
      const base64 = signature.replace(/-/g, '+').replace(/_/g, '/')
      return Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (char) =>
        char.charCodeAt(0),
      )
    } catch {
      return undefined
    }
  })()
  if (!bytes) return false
  return crypto.subtle.verify('HMAC', await key(secret), bytes, new TextEncoder().encode(text))
}
