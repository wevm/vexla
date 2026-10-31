/** @module Runs real Vite builds of a fixture app with the plugin. */
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { build } from 'vite'
import vexla from 'vexla/vite'

const src = Path.resolve(import.meta.dirname, '..')

function fixture(main: string) {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'vexla-vite-'))
  Fs.writeFileSync(
    Path.join(root, '.env.flags'),
    [
      '# @type {boolean} @build @public',
      'MAINTENANCE_BANNER=false',
      '',
      '# @type {boolean} @public',
      'NEW_CHECKOUT=false',
      '',
      "# @type {'a' | 'b'}",
      'PRICING=a',
      '',
      '# @type {boolean} @build',
      'SECRET_BUILD=false',
      '',
    ].join('\n'),
  )
  Fs.writeFileSync(Path.join(root, 'main.ts'), main)
  return root
}

async function bundle(root: string, options: { ssr?: boolean } = {}) {
  const output = await build({
    build: {
      minify: false,
      rollupOptions: { input: Path.join(root, 'main.ts'), output: { entryFileNames: 'main.js' } },
      ssr: options.ssr ?? false,
      write: false,
    },
    configFile: false,
    logLevel: 'silent',
    plugins: [vexla()],
    resolve: { alias: { vexla: Path.join(src, 'index.ts') } },
    root,
  })
  const result = Array.isArray(output) ? output[0]! : output
  if (!('output' in result)) throw new Error('Expected a build result.')
  return result.output.map((chunk) => ('code' in chunk ? chunk.code : '')).join('\n')
}

const main = `import { flags } from 'vexla'

if (flags.MAINTENANCE_BANNER) console.log('BANNER_ON')
else console.log('BANNER_OFF')

console.log(flags.NEW_CHECKOUT ? 'NEW' : 'OLD')
`

describe('vexla', () => {
  test('replaces build flags with literals and drops the dead branch', async () => {
    const root = fixture(main)
    const code = await bundle(root)
    expect(code).not.toContain('BANNER_ON')
    expect(code).toContain('BANNER_OFF')
    expect(code).toContain('NEW_CHECKOUT')
    expect(Fs.existsSync(Path.join(root, 'vexla.gen.ts'))).toMatchInlineSnapshot(`true`)
  })

  test('the environment of the build sets a build flag', async () => {
    const root = fixture(main)
    process.env['MAINTENANCE_BANNER'] = 'true'
    const code = await bundle(root).finally(() => delete process.env['MAINTENANCE_BANNER'])
    expect(code).toContain('BANNER_ON')
    expect(code).not.toContain('BANNER_OFF')
  })

  test('a private flag read in browser code fails the build', async () => {
    const root = fixture(`import { flags } from 'vexla'\nconsole.log(flags.PRICING)\n`)
    await expect(bundle(root)).rejects.toThrow(
      'Browser code reads the private flag PRICING in main.ts:2.',
    )
  })

  test('a private build flag read in browser code fails the build', async () => {
    const root = fixture(
      `import { flags } from 'vexla'\nif (flags.SECRET_BUILD) console.log('SECRET')\n`,
    )
    await expect(bundle(root)).rejects.toThrow(
      'Browser code reads the private flag SECRET_BUILD in main.ts:2.',
    )
  })

  test('server builds may read private flags', async () => {
    const root = fixture(
      `import { flags } from 'vexla'\nexport const pricing = () => flags.PRICING\n`,
    )
    expect(await bundle(root, { ssr: true })).toContain('PRICING')
  })
})
