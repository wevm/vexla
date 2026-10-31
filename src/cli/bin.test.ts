/** @module Runs the command-line entry as a real process, against a flags file and a local runtime. */
import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import * as Esbuild from 'esbuild'
import ts from 'typescript'
import { Definitions } from 'vexla'
import { Vexla, Store } from 'vexla/server'
import * as Http from '../../test/Http.js'

const file = [
  '# @type {boolean} @build @public',
  'MAINTENANCE_BANNER=false',
  '',
  '# Use the new checkout flow.',
  '# @type {boolean} @public @expires 2026-01-31',
  'NEW_CHECKOUT=false',
  '',
  "# @type {'a' | 'b' | 'c'}",
  'PRICING=a',
  '',
].join('\n')

let bin: string
let dir: string

// Node cannot resolve the source's `.js` specifiers to `.ts`, so the CLI runs as a bundle. The
// bundle stays inside the repository, so it resolves the package's dependencies.
beforeAll(async () => {
  dir = Fs.mkdtempSync(Path.join(import.meta.dirname, '.bin-'))
  bin = Path.join(dir, 'bin.mjs')
  await Esbuild.build({
    bundle: true,
    entryPoints: [Path.join(import.meta.dirname, 'bin.ts')],
    format: 'esm',
    outfile: bin,
    packages: 'external',
    platform: 'node',
  })
})

afterAll(() => {
  Fs.rmSync(dir, { force: true, recursive: true })
})

function project(files: Record<string, string> = {}) {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'vexla-cli-'))
  Fs.writeFileSync(Path.join(root, '.env.flags'), file)
  for (const [file, content] of Object.entries(files)) {
    Fs.mkdirSync(Path.dirname(Path.join(root, file)), { recursive: true })
    Fs.writeFileSync(Path.join(root, file), content)
  }
  return root
}

// Asynchronous, so a server in this process answers the requests of the CLI.
function run(
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ output: string; status: number | null }> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry) => !entry[0].startsWith('FEATURE_')),
  )
  return new Promise((resolve) => {
    const child = ChildProcess.spawn(process.execPath, [bin, ...args, '--format', 'json'], {
      cwd: options.cwd,
      env: { ...env, ...options.env },
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk))
    child.on('close', (status) => resolve({ output, status }))
  })
}

describe('vexla', () => {
  test('--help', async () => {
    const result = ChildProcess.spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' })
    expect(result.status).toMatchInlineSnapshot(`0`)
    expect(result.stdout).toMatchInlineSnapshot(`
      "vexla — Reads and writes feature flags through the flags file and the admin API of a Vexla server.

      Usage: vexla <command>

      Commands:
        check     Fails when the environment sets an invalid flag value, or an undeclared variable with --prefix. Reports stale flags.
        define    Creates or replaces a flag in the store, for a project with no flags file.
        dev       Serves the dev route for .env.flags, for an application with no TypeScript server.
        generate  Writes vexla.gen.ts from .env.flags, or from the manifest of a running server.
        get       Returns one flag of a running server, with its definition, value, and source.
        link      Returns a signed link that overrides flags, including private flags, until it expires.
        list      Lists every flag of a running server, with its value and source.
        prune     Lists store values of removed flags. --yes deletes them.
        retire    Replaces each read of a flag with its final value, deletes the declaration, and prunes the store.
        set       Sets the store value of a flag for every request.
        stale     Lists flags past their expires date, which are due for retirement.
        undefine  Deletes a flag from the store, with its value.
        unset     Deletes the store value of a flag.

      Integrations:
        completions  Generate shell completion script
        mcp          Register as MCP server (add, doctor)
        skills       Sync skill files to agents (add, list)

      Global Options:
        --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        --format <toon|json|yaml|md|jsonl>  Output format
        --full-output                       Show full output envelope
        --help                              Show help
        --llms, --llms-full                 Print LLM-readable manifest
        --mcp                               Start as MCP stdio server
        --schema                            Show JSON Schema for command
        --token-count                       Print token count of output (instead of output)
        --token-limit <n>                   Limit output to n tokens
        --token-offset <n>                  Skip first n tokens of output
        --update                            Update to latest version
        --version                           Show version
      "
    `)
  })
})

describe('generate', () => {
  test('writes vexla.gen.ts from .env.flags', async () => {
    const root = project()
    const result = await run(['generate'], { cwd: root })
    expect(result.status).toMatchInlineSnapshot(`0`)
    const generated = Fs.readFileSync(Path.join(root, 'vexla.gen.ts'), 'utf8')
    expect(generated).toContain('"NEW_CHECKOUT"')
    expect(generated).toContain("declare module 'vexla'")
  })
})

describe('check', () => {
  test('fails on an undeclared or invalid variable, and reports stale flags', async () => {
    const root = project()
    expect((await run(['check'], { cwd: root })).status).toMatchInlineSnapshot(`0`)

    const typo = await run(['check', '--prefix', 'NEW_'], {
      cwd: root,
      env: { NEW_CHEKOUT: 'true', PRICING: 'z' },
    })
    expect(typo.status).not.toBe(0)
    expect(typo.output).toContain('NEW_CHEKOUT: unknown')
    expect(typo.output).toContain('PRICING: invalid')

    expect((await run(['check', '--strict'], { cwd: root })).status).not.toBe(0)
  })

  test('reads dotenv files', async () => {
    const root = project({ '.env': 'PRICING="z"\n' })
    expect((await run(['check', '--env-file', '.env'], { cwd: root })).status).not.toBe(0)
  })
})

describe('stale', () => {
  test('lists flags past expires', async () => {
    const result = await run(['stale'], { cwd: project() })
    expect(JSON.parse(result.output)).toMatchInlineSnapshot(`
      {
        "stale": [
          {
            "expires": "2026-01-31",
            "key": "NEW_CHECKOUT",
          },
        ],
      }
    `)
  })
})

describe('admin API', () => {
  test('list, set, get, link, and prune, with the token from VEXLA_TOKEN', async () => {
    const store = Store.memory({ values: { OLD_FLAG: true } })
    const vexla = Vexla.create({
      authorize(request) {
        return request.headers.get('authorization') === 'Bearer secret-token' ? 'write' : undefined
      },
      definitions: Definitions.parseFile(file),
      secret: 'test-secret',
      store,
    })
    const server = await Http.serve(vexla.fetch)
    const env = { VEXLA_TOKEN: 'secret-token', VEXLA_URL: `${server.url}/.flags` }

    expect(
      (await run(['list'], { env: { VEXLA_URL: env.VEXLA_URL } })).status,
    ).toMatchInlineSnapshot(`3`)

    const set = await run(['set', 'PRICING', 'b'], { env })
    expect(set.status).toMatchInlineSnapshot(`0`)
    expect(set.output).not.toContain('secret-token')

    const list = JSON.parse((await run(['list'], { env })).output)
    expect(list.flags.find((flag: { key: string }) => flag.key === 'PRICING'))
      .toMatchInlineSnapshot(`
      {
        "key": "PRICING",
        "source": "store",
        "type": "select",
        "value": "b",
      }
    `)

    const link = JSON.parse(
      (
        await run(['link', 'https://app.example.com/checkout', 'PRICING=c', '--expires', '1h'], {
          env,
        })
      ).output,
    )
    expect(link.url).toMatch(
      /^https:\/\/app\.example\.com\/checkout\?flag\.PRICING=c&flag\.exp=\d+&flag\.sig=[\w-]+$/,
    )

    expect(JSON.parse((await run(['prune'], { env })).output)).toMatchInlineSnapshot(`
      {
        "deleted": false,
        "orphans": [
          "OLD_FLAG",
        ],
      }
    `)
    await run(['prune', '--yes'], { env })
    expect(await store.keys!()).toMatchInlineSnapshot(`
      [
        "PRICING",
      ]
    `)
    await server.close()
  })

  test('define on a store with no flags file', async () => {
    const vexla = Vexla.create({ dev: true, store: Store.memory() })
    const server = await Http.serve(vexla.fetch)
    const env = { VEXLA_URL: `${server.url}/.flags` }

    const define = await run(
      ['define', 'BETA', '--type', 'boolean', '--default', 'false', '--public'],
      { env },
    )
    expect(define.status).toMatchInlineSnapshot(`0`)
    expect(JSON.parse((await run(['get', 'BETA'], { env })).output).value).toMatchInlineSnapshot(
      `false`,
    )
    await server.close()
  })
})

describe('retire', () => {
  test('rewrites every read, removes dead branches, and leaves a project that type checks', async () => {
    const root = project({
      'src/checkout.ts': `import { flags } from 'vexla'

export function checkout(): string {
  if (flags.NEW_CHECKOUT) {
    return 'new'
  } else {
    return 'old'
  }
}

export const label = flags.NEW_CHECKOUT ? 'New checkout' : 'Checkout'
export const disabled = !flags.NEW_CHECKOUT
`,
      'src/view.tsx': `import { useFlag } from 'vexla/react'

export function useLabel(): string {
  return useFlag('NEW_CHECKOUT') ? 'new' : 'old'
}
`,
    })

    const result = await run(['retire', 'NEW_CHECKOUT', '--value', 'true'], { cwd: root })
    expect(result.status).toMatchInlineSnapshot(`0`)

    expect(Fs.readFileSync(Path.join(root, 'src/checkout.ts'), 'utf8')).toMatchInlineSnapshot(`
      "export function checkout(): string {
        return 'new'
      }

      export const label = 'New checkout'
      export const disabled = false
      "
    `)
    expect(Fs.readFileSync(Path.join(root, 'src/view.tsx'), 'utf8')).toMatchInlineSnapshot(`
      "export function useLabel(): string {
        return 'new'
      }
      "
    `)
    expect(Fs.readFileSync(Path.join(root, '.env.flags'), 'utf8')).toMatchInlineSnapshot(`
      "# @type {boolean} @build @public
      MAINTENANCE_BANNER=false

      # @type {'a' | 'b' | 'c'}
      PRICING=a
      "
    `)

    const program = ts.createProgram(
      ['src/checkout.ts', 'src/view.tsx'].map((file) => Path.join(root, file)),
      { jsx: ts.JsxEmit.Preserve, noEmit: true, strict: true, types: [] },
    )
    expect(
      ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.messageText),
    ).toMatchInlineSnapshot(`[]`)
  })

  test('--dry-run writes nothing', async () => {
    const code = `import { flags } from 'vexla'\nexport const a = flags.NEW_CHECKOUT\n`
    const root = project({ 'src/a.ts': code })
    const result = JSON.parse(
      (await run(['retire', 'NEW_CHECKOUT', '--dry-run'], { cwd: root })).output,
    )
    expect(result.changed).toMatchInlineSnapshot(`
      [
        "src/a.ts",
      ]
    `)
    expect(Fs.readFileSync(Path.join(root, 'src/a.ts'), 'utf8')).toBe(code)
  })
})
