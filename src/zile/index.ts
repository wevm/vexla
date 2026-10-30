/**
 * @module Zile entry: replaces each read of a build flag in the emitted JavaScript with a literal,
 * and removes the `flargs` import, so a published library has no runtime dependency on Flargs.
 * Set `"zile": { "transform": "flargs/zile" }` in `package.json`.
 */
import * as Errors from '../internal/Errors.js'
import * as Files from '../internal/Files.js'
import * as Inline from '../internal/Inline.js'

/**
 * Rewrites one emitted file. The flags file resolves from the working directory of the build.
 *
 * @throws {Errors.BaseError} When a runtime flag read stays, since a library resolves build flags only.
 */
export default function transform(code: string, file: string): string {
  if (!code.includes('flargs')) return code

  const root = process.cwd()
  const definitions = Files.read({ root })
  const values = Files.buildValues(definitions, { env: process.env })
  const result = Inline.transform(code, { definitions, file, strict: true, values })

  const remaining = result.findings.find(
    (finding) => finding.reason === 'runtime' || finding.reason === 'dynamic',
  )
  if (remaining)
    throw new Errors.BaseError(
      `${file}:${remaining.line} reads ${remaining.key || 'a flag with a computed key'}, which is not a build flag.`,
      {
        steps: [
          'Set `build: true` on the flag in flags.json, since a library resolves build flags only.',
        ],
      },
    )

  return result.code
}
