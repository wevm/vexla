/** @module Shared options of the CLI: the flags file, the admin API, and the mapping of errors to CLI errors. */
import * as Path from 'node:path'
import { z } from 'incur'
import * as Definitions from '../Definitions.js'
import * as Errors from '../internal/Errors.js'
import * as Files from '../internal/Files.js'

/** Options of the commands that read the flags file. */
export const file = z.object({
  path: z.string().optional().describe('Path of the flags file. Default: .env.flags'),
  root: z.string().optional().describe('Project root. Default: the working directory'),
})

/** Options of the commands that call the admin API. */
export const server = z.object({
  url: z
    .string()
    .optional()
    .describe('URL of the admin API, such as https://api.example.com/.flags. Default: VEXLA_URL'),
})

/** Returns the definitions in the flags file. */
export function definitions(options: z.output<typeof file>): Definitions.Definitions {
  return Files.read({ path: options.path, root: root(options) })
}

/** Returns the project root. */
export function root(options: z.output<typeof file>): string {
  return Path.resolve(options.root ?? process.cwd())
}

/**
 * Calls the admin API. The token comes from `VEXLA_TOKEN`, never from argv, and never appears
 * in output.
 */
export async function api(
  options: z.output<typeof server>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const base = options.url ?? process.env['VEXLA_URL']
  if (!base) throw new NoUrlError()

  const token = process.env['VEXLA_TOKEN']
  const response = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    method,
  })

  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok)
    throw new ApiError({
      error: typeof json['error'] === 'string' ? json['error'] : undefined,
      status: response.status,
    })
  return json
}

/** Returns the CLI error of an error. */
export function error(cause: unknown): { code: string; exitCode?: number; message: string } {
  if (cause instanceof ApiError)
    return {
      code: 'API',
      exitCode: cause.status === 401 || cause.status === 403 ? 3 : 1,
      message: Errors.inline(cause),
    }
  if (cause instanceof Errors.BaseError)
    return {
      code:
        cause.name
          .split('.')
          .pop()!
          .replace(/Error$/, '')
          .toUpperCase() || 'ERROR',
      message: Errors.inline(cause),
    }
  if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')
    return {
      code: 'NO_FLAGS_FILE',
      message: 'The flags file does not exist. To resolve: Create .env.flags, or pass `--path`.',
    }
  return { code: 'ERROR', message: cause instanceof Error ? cause.message : String(cause) }
}

/** Thrown when the admin API returns an error status. */
export class ApiError extends Errors.BaseError {
  override name = 'Context.ApiError'

  readonly status: number

  constructor(options: { error?: string | undefined; status: number }) {
    super(
      `The admin API returned ${options.status}${options.error ? ` (${options.error})` : ''}.`,
      {
        steps: [
          options.status === 401 || options.status === 403
            ? 'Set VEXLA_TOKEN to a token that `authorize` accepts with the access that the command needs.'
            : 'Check the command arguments against the flags of the server, with `vexla list`.',
        ],
      },
    )
    this.status = options.status
  }
}

/** Thrown when no URL names the admin API. */
export class NoUrlError extends Errors.BaseError {
  override name = 'Context.NoUrlError'

  constructor() {
    super('No URL names the admin API.', { steps: ['Pass `--url`, or set VEXLA_URL.'] })
  }
}
