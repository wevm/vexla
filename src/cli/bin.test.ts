/** @module Runs the command-line entry as a real process. */
import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import * as Esbuild from 'esbuild'

describe('flargs', () => {
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

  test('--help', () => {
    const result = ChildProcess.spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' })

    expect(result.status).toMatchInlineSnapshot(`0`)
    expect(result.stdout).toMatchInlineSnapshot(`
      "flargs — Reads and writes feature flags through the admin API of a Flargs server.

      Usage: flargs <command>

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
