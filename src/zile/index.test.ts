/** @module Runs the zile transform on emitted library code. */
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import transform from 'flargs/zile'

function inProject<result>(fn: () => result): result {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'flargs-zile-'))
  Fs.writeFileSync(
    Path.join(root, '.env.flags'),
    "# @type {boolean} @build\nNEW_ENCODER=false\n\n# @type {'a' | 'b'}\nPRICING=a\n",
  )
  const cwd = process.cwd()
  process.chdir(root)
  try {
    return fn()
  } finally {
    process.chdir(cwd)
  }
}

describe('transform', () => {
  test('replaces build flags and removes the flargs import', () => {
    const code = `import { flags } from 'flargs';
export function encode(value) {
    if (flags.NEW_ENCODER)
        return encodeV2(value);
    return encodeV1(value);
}
`
    expect(inProject(() => transform(code, 'dist/encode.js'))).toMatchInlineSnapshot(`
      "export function encode(value) {
          if (false)
              return encodeV2(value);
          return encodeV1(value);
      }
      "
    `)
  })

  test('a runtime flag fails the build', () => {
    const code = `import { flags } from 'flargs';\nexport const pricing = () => flags.PRICING;\n`
    expect(() => inProject(() => transform(code, 'dist/pricing.js')))
      .toThrowErrorMatchingInlineSnapshot(`
      [Error: dist/pricing.js:2 reads PRICING, which is not a build flag.

      To resolve: Add \`@build\` to the flag in .env.flags, since a library resolves build flags only.]
    `)
  })

  test('a file without flargs is unchanged', () => {
    const code = `export const a = 1;\n`
    expect(inProject(() => transform(code, 'dist/a.js'))).toBe(code)
  })
})
