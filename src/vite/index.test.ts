/** @module Runs real Vite builds of a fixture app with the plugin. */
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { build } from 'vite'
import flargs from 'flargs/vite'

const src = Path.resolve(import.meta.dirname, '..')

function fixture(main: string) {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'flargs-vite-'))
  Fs.writeFileSync(
    Path.join(root, 'flags.json'),
    JSON.stringify({
      maintenanceBanner: { build: true, default: false, public: true, type: 'boolean' },
      newCheckout: { default: false, public: true, type: 'boolean' },
      pricing: { default: 'a', options: ['a', 'b'], type: 'select' },
    }),
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
    plugins: [flargs()],
    resolve: { alias: { flargs: Path.join(src, 'index.ts') } },
    root,
  })
  const result = Array.isArray(output) ? output[0]! : output
  if (!('output' in result)) throw new Error('Expected a build result.')
  return result.output.map((chunk) => ('code' in chunk ? chunk.code : '')).join('\n')
}

const main = `import { flags } from 'flargs'

if (flags.maintenanceBanner) console.log('BANNER_ON')
else console.log('BANNER_OFF')

console.log(flags.newCheckout ? 'NEW' : 'OLD')
`

describe('flargs', () => {
  test('replaces build flags with literals and drops the dead branch', async () => {
    const root = fixture(main)
    const code = await bundle(root)
    expect(code).not.toContain('BANNER_ON')
    expect(code).toContain('BANNER_OFF')
    expect(code).toContain('newCheckout')
    expect(Fs.existsSync(Path.join(root, 'flargs.gen.ts'))).toMatchInlineSnapshot(`true`)
  })

  test('the environment of the build sets a build flag', async () => {
    const root = fixture(main)
    process.env['FEATURE_MAINTENANCE_BANNER'] = 'true'
    const code = await bundle(root).finally(() => delete process.env['FEATURE_MAINTENANCE_BANNER'])
    expect(code).toContain('BANNER_ON')
    expect(code).not.toContain('BANNER_OFF')
  })

  test('a private flag read in browser code fails the build', async () => {
    const root = fixture(`import { flags } from 'flargs'\nconsole.log(flags.pricing)\n`)
    await expect(bundle(root)).rejects.toThrow(
      'Browser code reads the private flag pricing in main.ts:2.',
    )
  })

  test('server builds may read private flags', async () => {
    const root = fixture(
      `import { flags } from 'flargs'\nexport const pricing = () => flags.pricing\n`,
    )
    expect(await bundle(root, { ssr: true })).toContain('pricing')
  })
})
