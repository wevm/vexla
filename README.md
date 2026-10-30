<h1 align="center">Flargs</h1>

<p align="center">
  Self-hosted feature flags for TypeScript and Rust
</p>

<p align="center">
  <a href="#overview">Overview</a> · <a href="#motivation">Motivation</a> · <a href="#agent-prompt">Agent Prompt</a> · <a href="#philosophy">Philosophy</a> · <a href="#features">Features</a> · <a href="#documentation">Documentation</a>
</p>

> [!NOTE]
> Flargs is in development. The examples below describe the planned API and do not work yet.

## Overview

```json
{
  "$schema": "./node_modules/flargs/schema.json",
  "newCheckout": { "default": false, "public": true, "type": "boolean" },
  "pricing": { "default": "a", "options": ["a", "b", "c"], "type": "select" }
}
```

```bash
# .env: each flag links to an environment variable.
FEATURE_NEW_CHECKOUT=true
```

```ts
import { flags } from 'flargs/values'

// Typed from flags.json. Resolves on the server, or from the page in a browser.
if (flags.newCheckout) renderNewCheckout()
```

## Motivation

Feature branches drift from `main`, end in large and risky merges, and keep finished work out of production. The fix is to push small changes to `main` continuously, with unfinished work behind a feature flag.

Extra work such as feature flags, staged migrations, and two configurations at once was once tedious, but coding agents now write it at almost no cost. Flargs makes each flag one typed declaration that is easy to add, preview, release, and remove, on infrastructure that the application already owns.

## Agent Prompt

Paste this prompt into a coding agent:

```txt
Read github.com/wevm/flargs, add Flargs to my project, and put my unfinished work behind flags so it merges to main.
```

## Philosophy

- **Declared.** Each flag has one declaration, one type, and one default, in a committed file.
- **Typed.** Every read carries the type of its flag, so Find All References locates every use.
- **Private.** A value stays on the server unless its flag is public.
- **Incremental.** Environment variables, a dev route, and an admin API use the same declarations and the same reads.
- **Self-hosted.** Flags live in the application and its database, with no third-party service.
- **Portable.** The core, server, and browser entries have no dependencies, and run in Node, Bun, Deno, edge runtimes, and browsers.

## Features

- **Flags Files:** `flags.json` or `flags.toml`, validated by one JSON Schema.
- **Environment Variables:** each flag links to a `FEATURE_*` variable, and an undeclared variable fails at startup.
- **Build Flags:** values compile to literals, so dead branches drop from the bundle.
- **Runtime Flags:** values resolve on the server for each request, from an override, a store value, `decide`, or the default.
- **Dev Route:** a page at `/.flags` toggles flags for one browser, or for every request with admin access.
- **Admin API:** an HTTP API reads and writes store values for an admin UI, the CLI, or CI.
- **Overrides:** search parameters override public flags, and signed links override private flags.
- **Stores:** memory, environment variables, Cloudflare KV, a remote Flargs API, or a table in the database of the application.
- **Integrations:** a fetch handler for Next.js, Cloudflare Workers, and Bun, plus Hono, Node, React, and Vite.
- **CLI and MCP:** the `flargs` command lists, sets, and links flags, checks the environment, and generates types.
- **Rust:** `flargs::flags!` reads `flags.toml` at compile time and generates typed flags.

## Documentation

The [plan](.agent/plans/flargs.md) defines the API, the phases, and the acceptance gates until the documentation site exists.

## License

[MIT](LICENSE)
