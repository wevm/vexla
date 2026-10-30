<h1 align="center">Flargs</h1>

<p align="center">
  Feature flags for trunk-based development
</p>

<p align="center">
  <a href="#overview">Overview</a> · <a href="#motivation">Motivation</a> · <a href="#agent-prompt">Agent Prompt</a> · <a href="#philosophy">Philosophy</a> · <a href="#features">Features</a> · <a href="#usage">Usage</a> · <a href="#cli">CLI</a> · <a href="#documentation">Documentation</a>
</p>

## Overview

```bash
# .env.flags

# Use the new checkout flow.
# @type {boolean} @public
NEW_CHECKOUT=false

# @type {'a' | 'b' | 'c'}
PRICING=a
```

```ts
import { flags } from 'flargs'

// Typed from .env.flags. Resolves on the server, or from the page in a browser.
if (flags.NEW_CHECKOUT) renderNewCheckout()
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
- **Typed.** Every read carries the type of its flag, so a misspelled or removed flag fails the type check.
- **Private.** A flag can stay on the server. Only a `@public` flag reaches a browser.
- **Short-lived.** A flag has an end. `@expires` marks it as due, `flargs stale` lists it, `flargs retire` replaces its reads with the final value, and `flargs prune` clears stored values of removed flags.
- **Incremental.** Environment variables, a dev route, and an admin API use the same declarations and the same reads.
- **Self-hosted.** Flags live in the application and its database, with no third-party service.
- **Portable.** The core, server, and browser entries have no dependencies, and run in Node, Bun, Deno, edge runtimes, and browsers.

## Features

- **Flags File:** `.env.flags` declares each flag as a variable, with JSDoc-style tags for its type.
- **Environment Variables:** a flag reads the variable of the same name, such as `NEW_CHECKOUT`.
- **Build Flags:** values compile to literals, so dead branches drop from the bundle.
- **Runtime Flags:** values resolve on the server for each request, from an override, a store value, `decide`, or the default.
- **Dev Route:** a page at `/.flags` toggles flags for one browser, or for every request with admin access.
- **Admin API:** an HTTP API reads and writes store values for an admin UI, the CLI, or CI.
- **Overrides:** search parameters override public flags, and signed links override private flags.
- **Retirement:** `flargs retire` replaces each read with the final value and deletes the flag, and `expires` marks flags that are due.
- **Stores:** memory, environment variables, Cloudflare KV, a remote Flargs API, or a table in the database of the application.
- **Integrations:** a fetch handler for Next.js, Cloudflare Workers, and Bun, plus Hono, Node, React, and Vite.
- **CLI and MCP:** the `flargs` command lists, sets, and links flags, checks the environment, and generates types.
- **Rust:** `flargs::flags!` reads `.env.flags` at compile time and generates typed flags.

## Usage

### Flags File

`.env.flags` declares every flag in dotenv syntax. Each variable is a flag, its name is the key, and its value is the default. Comment lines directly above it hold the description and JSDoc-style tags.

```bash
# .env.flags (committed)

# Use the new checkout flow.
# @type {boolean}
# @public
NEW_CHECKOUT=false

# Pricing page variant.
# @type {'a' | 'b' | 'c'}
PRICING=a

# @type {json}
LIMITS={"requests":100}

# Show the maintenance banner. Tags may share one line.
# @type {boolean} @build @public @expires 2027-01-31
MAINTENANCE_BANNER=false
```

`@type` is required: `{boolean}`, `{number}`, `{string}`, `{json}`, or a union of string literals for a select flag. A flag is private unless it has `@public`, and a private value never reaches a browser. A `@build` flag resolves when the bundle builds.

A `.gitignore` entry such as `.env*` also ignores `.env.flags`. Add `!.env.flags` after it, so the file is committed.

### Environment Variables

A flag reads the environment variable of the same name. A `.env` file, `.env.local`, or the deploy environment sets values that differ from the defaults.

```bash
# .env (gitignored): values for this environment.
NEW_CHECKOUT=true
PRICING=b
```

`flargs check` fails when a variable holds a value that is not a value of its flag. With `--prefix`, it also fails on an undeclared variable with that prefix, so a typo does not fail silently.

### Store Definitions

A project with no flags file declares its flags in the store. An admin UI or the CLI then creates flags with no deploy, and `flargs generate --url` writes the types from the running server.

```ts
// No .env.flags: the store holds the definitions and the values.
const flargs = Flargs.create({
  authorize,
  secret: process.env.FLARGS_SECRET,
  store: Store.from(database.flags),
})
```

A project uses one source: a flags file, reviewed with the code that reads it, or the store, changed at runtime.

### Types

`flargs generate` reads `.env.flags` and writes `flargs.gen.ts`, which holds the definitions and their types. `flargs/vite` runs the same step on each change of `.env.flags`.

```ts
import { flags } from 'flargs'

flags.NEW_CHECKOUT // boolean
flags.PRICING // 'a' | 'b' | 'c'
flags.LIMITS // { requests: number }
```

### Server

`Flargs.create` adds overrides, a store, `decide`, the dev route, and the admin API. `flargs.fetch` is a fetch handler.

```ts
import { Flargs, Store } from 'flargs/server'
import { definitions } from './flargs.gen.js'

export const flargs = Flargs.create({
  authorize: (request) => Admin.access(request),
  decide: {
    // Returns undefined to fall through to the store value or the default.
    PRICING: (user) => (user?.plan === 'enterprise' ? 'c' : undefined),
  },
  definitions,
  dev: process.env.NODE_ENV === 'development',
  identify: (request) => Session.user(request),
  secret: process.env.FLARGS_SECRET,
  store: Store.from(database.flags),
})

// Evaluates one flag for one request.
const pricing = await flargs.get(request, 'PRICING')

// Serves the dev route and the admin API under /.flags.
const response = await flargs.fetch(request)
```

```ts
// Hono: serves /.flags and resolves `flags` for each request.
import { middleware } from 'flargs/hono'

app.use(middleware(flargs))
```

```ts
// Node: serves /.flags, and resolves `flags` for each request of the app.
import * as Http from 'node:http'
import { Request } from 'flargs/node'

Http.createServer(Request.toNodeListener(app.fetch, { flargs })).listen(3000)
```

### Values

`flargs` exports `flags`. A read is synchronous and takes no request argument. On the server, `flags` holds the values of the current request. In a browser, it holds the public values that the server embeds in the page.

```tsx
import { flags } from 'flargs'
import { useFlag } from 'flargs/react'

// A plain read, on the server or in a browser.
if (flags.NEW_CHECKOUT) renderNewCheckout()

// React: renders again when the values change. No provider is necessary.
const pricing = useFlag('PRICING')
```

### Build Flags

`flargs/vite` replaces each read of a build flag with a literal, so dead branches drop from the bundle. A read of a private flag in browser code is a build error.

```ts
import { defineConfig } from 'vite'
import flargs from 'flargs/vite'

export default defineConfig({
  // Reads .env.flags, writes flargs.gen.ts, and resolves build flags from the environment.
  plugins: [flargs()],
})
```

### Libraries

A library declares build flags only, and publishes from `main` with unfinished work off. Zile replaces each read after `tsc`, so the published files contain a literal and no `flargs` import.

```jsonc
// package.json
"zile": { "transform": "flargs/zile" }
```

```ts
import { flags } from 'flargs'

// Becomes `if (false)` in the published files.
if (flags.NEW_ENCODER) return encodeV2(value)
```

### Overrides

In dev mode, search parameters override any flag. In production, they override public flags, and a signed link overrides a private flag. The server stores valid overrides in a signed `HttpOnly` cookie.

```txt
https://app.example.com/checkout?flag.NEW_CHECKOUT=true
https://app.example.com/checkout?flag.PRICING=c&flag.exp=1767225600&flag.sig=3q2-7w
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
PUT /.flags/values/NEW_CHECKOUT

{ "value": true }
```

### Rust

`flargs::flags!` reads the same `.env.flags` at compile time, so a bad declaration fails the build, and one file serves a TypeScript app and a Rust service.

```rust
// Generates `Flags`, typed keys, and the `Pricing` enum from .env.flags.
flargs::flags!(".env.flags");

let pricing: Pricing = flargs.get(&parts, Flags::PRICING).await?;

// axum: serves /.flags, and evaluates flags for each request.
let app = Router::new()
    .nest_service("/.flags", flargs.service())
    .route("/checkout", get(checkout))
    .layer(flargs.layer());
```

## CLI

The CLI uses [incur](https://github.com/wevm/incur), so every command supports `--llms`, `--mcp`, and `--format`. `FLARGS_URL` and `FLARGS_TOKEN` select the server and its token.

```bash
# Writes flargs.gen.ts from .env.flags.
flargs generate

# Fails when the environment sets an invalid flag value.
flargs check

# Lists every flag of a running server, with its value and source.
flargs list --url https://api.example.com/.flags

# Sets and deletes a store value for every request.
flargs set NEW_CHECKOUT true
flargs unset NEW_CHECKOUT

# Creates a flag in the store, for a project with no flags file.
flargs define NEW_CHECKOUT --type boolean --default false --public

# Lists stored values of removed flags, and deletes them with --yes.
flargs prune

# Lists flags past their expiry date.
flargs stale

# Replaces each read of a flag with its final value, then deletes the flag.
flargs retire NEW_CHECKOUT --value true

# Returns a signed link that overrides a private flag for one week.
flargs link https://app.example.com/checkout PRICING=c --expires 7d

# Serves the dev route for a flags file, for an application with no TypeScript server.
flargs dev
```

## Documentation

The documentation site lives in [`docs/`](docs). `pnpm docs:dev` serves it, and `pnpm docs:build` builds it.

## License

[MIT](LICENSE)
