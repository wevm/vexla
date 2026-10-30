<h1 align="center">Flargs</h1>

<p align="center">
  Self-hosted feature flags for TypeScript and Rust
</p>

<p align="center">
  <a href="#overview">Overview</a> · <a href="#motivation">Motivation</a> · <a href="#agent-prompt">Agent Prompt</a> · <a href="#philosophy">Philosophy</a> · <a href="#features">Features</a> · <a href="#usage">Usage</a> · <a href="#cli">CLI</a> · <a href="#documentation">Documentation</a>
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
import { flags } from 'flargs'

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

## Usage

### Flags File

`flags.json` declares every flag with its type and default. The JSON Schema validates the file and completes keys in editors.

```json
{
  "$schema": "./node_modules/flargs/schema.json",
  "limits": { "default": { "requests": 100 }, "type": "json" },
  "maintenanceBanner": { "build": true, "default": false, "public": true, "type": "boolean" },
  "newCheckout": {
    "default": false,
    "description": "Use the new checkout flow.",
    "public": true,
    "type": "boolean"
  },
  "pricing": { "default": "a", "options": ["a", "b", "c"], "type": "select" }
}
```

A flag is private unless `public` is `true`, and a private value never reaches a browser. A `build` flag resolves when the bundle builds.

### Environment Variables

Each flag links to an environment variable: `newCheckout` reads `FEATURE_NEW_CHECKOUT`, and `env` sets another name. A `.env` file or the deploy environment sets values that differ from the defaults.

```bash
# .env (gitignored): values for this environment.
FEATURE_NEW_CHECKOUT=true
FEATURE_PRICING=b
```

A `FEATURE_*` variable that `flags.json` does not declare throws at startup, so a typo does not fail silently.

### Store Definitions

A project with no flags file declares its flags in the store. An admin UI or the CLI then creates flags with no deploy, and `flargs generate --url` writes the types from the running server.

```ts
// No flags.json: the store holds the definitions and the values.
const runtime = Runtime.create({
  authorize,
  secret: process.env.FLARGS_SECRET,
  store: Store.from(database.flags),
})
```

A project uses one source: a flags file, reviewed with the code that reads it, or the store, changed at runtime.

### Types

`flargs generate` reads `flags.json` and writes `flargs.gen.ts`, which holds the definitions and their types. `flargs/vite` runs the same step on each change of `flags.json`.

```ts
import { flags } from 'flargs'

flags.newCheckout // boolean
flags.pricing // 'a' | 'b' | 'c'
flags.limits // { requests: number }
```

### Runtime

`Runtime.create` adds overrides, a store, `decide`, the dev route, and the admin API. `runtime.fetch` is a fetch handler.

```ts
import { Runtime, Store } from 'flargs/server'
import { definitions } from './flargs.gen.js'

export const runtime = Runtime.create({
  authorize: (request) => Admin.access(request),
  decide: {
    // Returns undefined to fall through to the store value or the default.
    pricing: (user) => (user?.plan === 'enterprise' ? 'c' : undefined),
  },
  definitions,
  dev: process.env.NODE_ENV === 'development',
  identify: (request) => Session.user(request),
  secret: process.env.FLARGS_SECRET,
  store: Store.from(database.flags),
})

// Evaluates one flag for one request.
const pricing = await runtime.get(request, 'pricing')

// Serves the dev route and the admin API under /.flags.
const response = await runtime.fetch(request)
```

```ts
// Hono: serves /.flags and resolves `flags` for each request.
import * as Flargs from 'flargs/hono'

app.use(Flargs.middleware(runtime))
```

```ts
// Node: converts the fetch handler to a request listener.
import * as Http from 'node:http'
import { Request } from 'flargs/node'

Http.createServer(Request.toNodeListener(runtime.fetch, { runtime })).listen(3000)
```

### Values

`flargs` exports `flags`. A read is synchronous and takes no request argument. On the server, `flags` holds the values of the current request. In a browser, it holds the public values that the server embeds in the page.

```tsx
import { flags } from 'flargs'
import { useFlag } from 'flargs/react'

// A plain read, on the server or in a browser.
if (flags.newCheckout) renderNewCheckout()

// React: renders again when the values change. No provider is necessary.
const pricing = useFlag('pricing')
```

### Build Flags

`flargs/vite` replaces each read of a build flag with a literal, so dead branches drop from the bundle. A read of a private flag in browser code is a build error.

```ts
import { defineConfig } from 'vite'
import flargs from 'flargs/vite'

export default defineConfig({
  // Reads flags.json, writes flargs.gen.ts, and resolves build flags from the environment.
  plugins: [flargs()],
})
```

### Overrides

In dev mode, search parameters override any flag. In production, they override public flags, and a signed link overrides a private flag. The server stores valid overrides in a signed `HttpOnly` cookie.

```txt
https://app.example.com/checkout?flag.newCheckout=true
https://app.example.com/checkout?flag.pricing=c&flag.exp=1767225600&flag.sig=3q2-7w
https://app.example.com/?flag.reset
```

### Admin API

The admin API lives under `/.flags`. `authorize` returns the access of each request: `'read'`, `'write'`, `undefined`, or a `Response`. Flargs defines no credential format.

```ts
// The admin UI session writes. CI tokens from Handshakes read.
authorize: async (request) => {
  if (await Admin.verify(request)) return 'write'

  const result = await resource.verify(request)
  if (result.status !== 'valid') return resource.challenge(result)

  return result.principal.scopes.includes('flags:write') ? 'write' : 'read'
},
```

```http
GET /.flags/manifest
PUT /.flags/values/newCheckout

{ "value": true }
```

### Rust

`flags.toml` follows the same schema as `flags.json`. `flargs::flags!` reads it at compile time, so a bad declaration fails the build.

```toml
#:schema https://unpkg.com/flargs/schema.json
[new_checkout]
default = false
public = true
type = "boolean"

[pricing]
default = "a"
options = ["a", "b", "c"]
type = "select"
```

```rust
// Generates `Flags`, typed keys, and the `Pricing` enum from flags.toml.
flargs::flags!("flags.toml");

let pricing: Pricing = runtime.get(&parts, Flags::PRICING).await?;

// axum: serves /.flags, and evaluates flags for each request.
let app = Router::new()
    .nest_service("/.flags", runtime.service())
    .route("/checkout", get(checkout))
    .layer(runtime.layer());
```

## CLI

The CLI uses [incur](https://github.com/wevm/incur), so every command supports `--llms`, `--mcp`, and `--format`. `FLARGS_URL` and `FLARGS_TOKEN` select the server and its token.

```bash
# Writes flargs.gen.ts from flags.json.
flargs generate

# Writes .env.example: every variable, its default, and its description.
flargs env

# Fails when the environment sets an undeclared or invalid FEATURE_* variable.
flargs check

# Lists every flag of a running server, with its value and source.
flargs list --url https://api.example.com/.flags

# Sets and deletes a store value for every request.
flargs set newCheckout true
flargs unset newCheckout

# Creates a flag in the store, for a project with no flags file.
flargs define newCheckout --type boolean --default false --public

# Returns a signed link that overrides a private flag for one week.
flargs link https://app.example.com/checkout pricing=c --expires 7d

# Serves the dev route for a flags file, for an application with no TypeScript server.
flargs dev
```

## Documentation

The [plan](.agent/plans/flargs.md) defines the API, the phases, and the acceptance gates until the documentation site exists.

## License

[MIT](LICENSE)
