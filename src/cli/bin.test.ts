/** @module Runs the command-line entry as a real process, against a flags file and a local runtime. */
import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import * as Esbuild from 'esbuild'
import ts from 'typescript'
import { Definitions } from 'flargs'
import { Runtime, Store } from 'flargs/server'
import * as Http from '../../test/Http.js'

const flags = {
  maintenanceBanner: { build: true, default: false, public: true, type: 'boolean' },
  newCheckout: {
    default: false,
    description: 'Use the new checkout flow.',
    expires: '2026-01-31',
    public: true,
    type: 'boolean',
  },
  pricing: { default: 'a', options: ['a', 'b', 'c'], type: 'select' },
}

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
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'flargs-cli-'))
  Fs.writeFileSync(Path.join(root, 'flags.json'), JSON.stringify(flags, null, 2))
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

describe('flargs', () => {
  test('--help', async () => {
    const result = ChildProcess.spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' })
    expect(result.status).toMatchInlineSnapshot(`0`)
    expect(result.stdout).toMatchInlineSnapshot(`
      "flargs — Reads and writes feature flags through the flags file and the admin API of a Flargs server.

      Usage: flargs <command>

      Commands:
        check     Fails when the environment sets an undeclared or invalid FEATURE_* variable. Reports stale flags.
        define    Creates or replaces a flag in the store, for a project with no flags file.
        dev       Serves the dev route for flags.json, for an application with no TypeScript server.
        env       Writes .env.example: each flag variable, its default, and its description.
        generate  Writes flargs.gen.ts from flags.json, or from the manifest of a running server.
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
  test('writes flargs.gen.ts from flags.json', async () => {
    const root = project()
    const result = await run(['generate'], { cwd: root })
    expect(result.status).toMatchInlineSnapshot(`0`)
    const generated = Fs.readFileSync(Path.join(root, 'flargs.gen.ts'), 'utf8')
    expect(generated).toContain('"FEATURE_NEW_CHECKOUT"')
    expect(generated).toContain("declare module 'flargs'")
  })
})

describe('env', () => {
  test('writes .env.example', async () => {
    const root = project()
    expect((await run(['env'], { cwd: root })).status).toMatchInlineSnapshot(`0`)
    expect(Fs.readFileSync(Path.join(root, '.env.example'), 'utf8')).toMatchInlineSnapshot(`
      "# Type: boolean.
      FEATURE_MAINTENANCE_BANNER=false

      # Use the new checkout flow.
      # Type: boolean.
      FEATURE_NEW_CHECKOUT=false

      # One of: a, b, c.
      FEATURE_PRICING=a
      "
    `)
  })
})

describe('check', () => {
  test('fails on an undeclared or invalid variable, and reports stale flags', async () => {
    const root = project()
    expect((await run(['check'], { cwd: root })).status).toMatchInlineSnapshot(`0`)

    const typo = await run(['check'], {
      cwd: root,
      env: { FEATURE_NEW_CHEKOUT: 'true', FEATURE_PRICING: 'z' },
    })
    expect(typo.status).not.toBe(0)
    expect(typo.output).toContain('FEATURE_NEW_CHEKOUT: unknown')
    expect(typo.output).toContain('FEATURE_PRICING: invalid')

    expect((await run(['check', '--strict'], { cwd: root })).status).not.toBe(0)
  })

  test('reads dotenv files', async () => {
    const root = project({ '.env': 'FEATURE_PRICING="z"\n' })
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
            "key": "newCheckout",
          },
        ],
      }
    `)
  })
})

describe('admin API', () => {
  test('list, set, get, link, and prune, with the token from FLARGS_TOKEN', async () => {
    const store = Store.memory({ values: { oldFlag: true } })
    const runtime = Runtime.create({
      authorize: (request) =>
        request.headers.get('authorization') === 'Bearer secret-token' ? 'write' : undefined,
      definitions: Definitions.parse(flags),
      secret: 'test-secret',
      store,
    })
    const server = await Http.serve(runtime.fetch)
    const env = { FLARGS_TOKEN: 'secret-token', FLARGS_URL: `${server.url}/.flags` }

    expect(
      (await run(['list'], { env: { FLARGS_URL: env.FLARGS_URL } })).status,
    ).toMatchInlineSnapshot(`3`)

    const set = await run(['set', 'pricing', 'b'], { env })
    expect(set.status).toMatchInlineSnapshot(`0`)
    expect(set.output).not.toContain('secret-token')

    const list = JSON.parse((await run(['list'], { env })).output)
    expect(list.flags.find((flag: { key: string }) => flag.key === 'pricing'))
      .toMatchInlineSnapshot(`
      {
        "key": "pricing",
        "source": "store",
        "type": "select",
        "value": "b",
      }
    `)

    const link = JSON.parse(
      (
        await run(['link', 'https://app.example.com/checkout', 'pricing=c', '--expires', '1h'], {
          env,
        })
      ).output,
    )
    expect(link.url).toMatch(
      /^https:\/\/app\.example\.com\/checkout\?flag\.pricing=c&flag\.exp=\d+&flag\.sig=[\w-]+$/,
    )

    expect(JSON.parse((await run(['prune'], { env })).output)).toMatchInlineSnapshot(`
      {
        "deleted": false,
        "orphans": [
          "oldFlag",
        ],
      }
    `)
    await run(['prune', '--yes'], { env })
    expect(await store.keys!()).toMatchInlineSnapshot(`
      [
        "pricing",
      ]
    `)
    await server.close()
  })

  test('define on a store with no flags file', async () => {
    const runtime = Runtime.create({ dev: true, store: Store.memory() })
    const server = await Http.serve(runtime.fetch)
    const env = { FLARGS_URL: `${server.url}/.flags` }

    const define = await run(
      ['define', 'beta', '--type', 'boolean', '--default', 'false', '--public'],
      { env },
    )
    expect(define.status).toMatchInlineSnapshot(`0`)
    expect(JSON.parse((await run(['get', 'beta'], { env })).output).value).toMatchInlineSnapshot(
      `false`,
    )
    await server.close()
  })
})

describe('retire', () => {
  test('rewrites every read, removes dead branches, and leaves a project that type checks', async () => {
    const root = project({
      'src/checkout.ts': `import { flags } from 'flargs'

export function checkout(): string {
  if (flags.newCheckout) {
    return 'new'
  } else {
    return 'old'
  }
}

export const label = flags.newCheckout ? 'New checkout' : 'Checkout'
export const disabled = !flags.newCheckout
`,
      'src/view.tsx': `import { useFlag } from 'flargs/react'

export function useLabel(): string {
  return useFlag('newCheckout') ? 'new' : 'old'
}
`,
    })

    const result = await run(['retire', 'newCheckout', '--value', 'true'], { cwd: root })
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
    expect(Object.keys(JSON.parse(Fs.readFileSync(Path.join(root, 'flags.json'), 'utf8'))))
      .toMatchInlineSnapshot(`
      [
        "maintenanceBanner",
        "pricing",
      ]
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
    const code = `import { flags } from 'flargs'\nexport const a = flags.newCheckout\n`
    const root = project({ 'src/a.ts': code })
    const result = JSON.parse(
      (await run(['retire', 'newCheckout', '--dry-run'], { cwd: root })).output,
    )
    expect(result.changed).toMatchInlineSnapshot(`
      [
        "src/a.ts",
      ]
    `)
    expect(Fs.readFileSync(Path.join(root, 'src/a.ts'), 'utf8')).toBe(code)
  })
})
