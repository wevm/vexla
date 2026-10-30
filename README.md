<h1 align="center">Flargs</h1>

<p align="center">
  Self-hosted feature flags for TypeScript and Rust
</p>

<p align="center">
  <a href="#overview">Overview</a> · <a href="#motivation">Motivation</a> · <a href="#agent-prompt">Agent Prompt</a> · <a href="#philosophy">Philosophy</a> · <a href="#features">Features</a> · <a href="#usage">Usage</a> · <a href="#cli">CLI</a> · <a href="#rust">Rust</a>
</p>

> [!NOTE]
> Flargs is in development. [`.agent/plans/flargs.md`](.agent/plans/flargs.md) defines the API and the phases. The examples below describe the planned API and do not work yet.

## Overview

```bash
# flags.env (committed): declares each flag and its default.

# Use the new checkout flow.
# @public
FEATURE_NEW_CHECKOUT=false

# @options a b c
FEATURE_PRICING=a
```

```bash
# .env (gitignored), or the deploy environment: sets a value for this environment.
FEATURE_NEW_CHECKOUT=true
```

```ts
import { flags } from 'flargs/values'

// Typed from flags.env. Resolves on the server, or from the page in a browser.
if (flags.newCheckout) renderNewCheckout()
flags.pricing // 'a' | 'b' | 'c'
```

The same `flags.env` and the same reads scale from environment variables to a dev route, personal overrides, and an admin API on the database of the application.

## Motivation

Feature branches drift from `main`, end in large and risky merges, and keep finished work out of production. The fix is to push small changes to `main` continuously, with unfinished work behind a feature flag.

Extra work such as feature flags, staged migrations, and two configurations at once was once tedious, but coding agents now write it at almost no cost. Flargs makes each flag one typed line that is easy to add, preview, release, and remove, on infrastructure that the application already owns.

The [Vercel Flags SDK](https://flags-sdk.dev) established flags as code. Flargs keeps that model and replaces the hosted parts: a store in place of a provider, a dev route in place of a toolbar, and build flags in place of precompute.

## Agent Prompt

Paste this prompt into a coding agent:

```txt
Read github.com/wevm/flargs, add Flargs to my project, and put my unfinished work behind flags so it merges to main.
```

## Philosophy

- **Flags are environment variables:** Each flag is one line in `flags.env`, with one default and a generated type. Find All References locates every read.
- **Server-first:** The server resolves flags. A browser receives values, never rules.
- **Private by default:** A private value never leaves the server. Visibility, not a variable prefix, controls what reaches a browser.
- **Incremental:** Environment variables, a dev route, and an admin API use the same `flags.env` and the same reads.
- **Portable:** The core, server, and browser entries have no dependencies. They run in Node, Bun, Deno, edge runtimes, and browsers.
- **Tested:** Every test runs against a real server, browser, or build, with no mocks.

## Features

- **Declarations:** One `FEATURE_*` line for each flag in a committed `flags.env`, with JSDoc-style tags for options, visibility, and build flags.
- **Typed Values:** Generated types for every flag, such as `'a' | 'b' | 'c'` for a select flag.
- **Zero Config:** With no `flags.env`, `FEATURE_NEW_CHECKOUT=true` alone declares a flag.
- **Build Flags:** Compile to literals, so dead branches drop from the bundle and the value never reaches an API.
- **Runtime Flags:** Resolve on the server for each request, from an override, a store value, `decide`, or the default.
- **Dev Route:** A page at `/.flags` toggles flags for one browser, or for every request with admin access.
- **Admin API:** Reads and writes store values over HTTP, for an admin UI, the CLI, or CI.
- **Overrides:** Search parameters such as `?flag.newCheckout=true` override public flags. Signed links override private flags.
- **Stores:** Memory, environment variables, Cloudflare KV, a remote Flargs API, or a table in the database of the application.
- **Integrations:** A fetch handler for Next.js, Cloudflare Workers, and Bun, plus Hono middleware, Node listeners, React, and Vite.
- **CLI and MCP:** Lists, sets, and links flags, checks the environment in CI, and generates types.
- **Rust:** `flargs::flags!("flags.env")` generates a typed struct at compile time from the same file.

## Usage

### Definitions

`flags.env` declares every flag in dotenv syntax. The value of each variable is its default, and comment lines above it hold the description and tags.

```bash
# flags.env

# Show the maintenance banner. Resolves when the bundle builds.
# @build @public
FEATURE_MAINTENANCE_BANNER=false

# Use the new checkout flow. May reach the browser.
# @public
FEATURE_NEW_CHECKOUT=false

# Pricing page variant. Private: the value never leaves the server.
# @options a b c
FEATURE_PRICING=a

# A JSON value. The type comes from the default.
FEATURE_LIMITS={"requests":100}
```

| Declaration            | Meaning                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `FEATURE_NEW_CHECKOUT` | the key `newCheckout`                                                                  |
| `=false`               | the default. Booleans, numbers, and JSON keep their type, and other values are strings |
| comment lines          | the description, shown in the dev route                                                |
| `@options a b c`       | a select flag, typed `'a' \| 'b' \| 'c'`                                               |
| `@public`              | the value may reach the browser. Flags are private otherwise                           |
| `@build`               | a build flag, written into the bundle at build time                                    |

A `.env` file, `.env.local`, or the deploy environment sets values that differ from the defaults. A `FEATURE_*` variable that `flags.env` does not declare throws at startup, so a typo does not fail silently.

### Types

`flargs/vite` and `flargs generate` read `flags.env` and write `flargs.gen.ts`, which holds the parsed definitions and their types.

```bash
# Writes flargs.gen.ts. flargs/vite runs the same step on each change of flags.env.
flargs generate
```

With no `flags.env`, Flargs reads every `FEATURE_*` variable as a private, untyped flag. Flargs configuration uses a separate prefix: `FLARGS_SECRET`, `FLARGS_TOKEN`, and `FLARGS_URL`.

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

`flargs/values` exports `flags`. A read is synchronous and takes no request argument.

```ts
import { flags } from 'flargs/values'

// On the server: the values of the current request. In a browser: the public values of the page.
if (flags.newCheckout) renderNewCheckout()
```

| Where      | Source of `flags`                                                                      |
| ---------- | -------------------------------------------------------------------------------------- |
| Server     | the current request, through Hono middleware, a Node listener, or `Values.run`         |
| Browser    | the JSON script from `runtime.script`, or `Values.load` for a client on another origin |
| No runtime | environment variables, then defaults                                                   |

```tsx
// React: renders again when the values change. No provider is necessary.
import { useFlag } from 'flargs/react'

const newCheckout = useFlag('newCheckout')
```

### Build Flags

`flargs/vite` replaces each read of a build flag with a literal. A read of a private flag in browser code is a build error.

```ts
import { defineConfig } from 'vite'
import flargs from 'flargs/vite'

export default defineConfig({
  // Reads flags.env, writes flargs.gen.ts, and resolves build flags from the environment.
  plugins: [flargs()],
})
```

### Overrides

| Mode       | Private runtime flag | Public runtime flag | Build flag                       |
| ---------- | -------------------- | ------------------- | -------------------------------- |
| Dev        | unsigned             | unsigned            | unsigned, through the dev server |
| Production | signed only          | unsigned or signed  | rejected                         |

```txt
https://app.example.com/checkout?flag.newCheckout=true
https://app.example.com/checkout?flag.pricing=c&flag.exp=1767225600&flag.sig=3q2-7w
https://app.example.com/?flag.reset
```

The server stores valid overrides in a signed `HttpOnly` cookie, so they persist across navigation.

### Admin API

The admin API lives under `/.flags`. `authorize` returns the access of each request, and Flargs defines no credential format.

| Route                        | Access  | Purpose                                  |
| ---------------------------- | ------- | ---------------------------------------- |
| `GET /.flags`                | `read`  | the dev route page                       |
| `GET /.flags/manifest`       | `read`  | definitions, store values, and overrides |
| `PUT /.flags/values/:key`    | `write` | sets a store value for every request     |
| `DELETE /.flags/values/:key` | `write` | deletes a store value                    |
| `PUT /.flags/overrides`      | `read`  | sets personal overrides                  |
| `POST /.flags/links`         | `write` | returns a signed share link              |
| `GET /.flags/values`         | none    | public values for the request            |

```ts
// The admin UI session writes. CI tokens from Handshakes read.
authorize: async (request) => {
  if (await Admin.verify(request)) return 'write'

  const result = await resource.verify(request)
  if (result.status !== 'valid') return resource.challenge(result)

  return result.principal.scopes.includes('flags:write') ? 'write' : 'read'
},
```

## CLI

The CLI uses [incur](https://github.com/wevm/incur), so every command supports `--llms`, `--mcp`, and `--format`.

```bash
# Lists every flag of a running server. FLARGS_TOKEN holds the token.
flargs list --url https://api.example.com/.flags

# Sets a store value for every request.
flargs set newCheckout true

# Returns a signed link that overrides a private flag for one week.
flargs link https://app.example.com/checkout pricing=c --expires 7d

# Fails when the environment sets an undeclared or invalid FEATURE_* variable.
flargs check

# Writes types for a client in another repository.
flargs generate --url https://api.example.com/.flags --out src/flargs.gen.ts
```

| Command                            | Purpose                                                  |
| ---------------------------------- | -------------------------------------------------------- |
| `flargs list`                      | lists every flag with its value and source               |
| `flargs get <key>`                 | returns one flag                                         |
| `flargs set <key> <value>`         | sets the store value                                     |
| `flargs unset <key>`               | deletes the store value                                  |
| `flargs link <url> <key=value...>` | returns a signed share link                              |
| `flargs check`                     | validates the environment against `flags.env`            |
| `flargs generate`                  | writes `flargs.gen.ts` from `flags.env`, or from `--url` |
| `flargs dev`                       | serves the dev route for `flags.env`                     |

## Rust

```rust
// Reads flags.env at compile time. A bad declaration fails the build at its line.
flargs::flags!("flags.env");

// Typed keys and enums come from the same file as in TypeScript.
let pricing: Pricing = runtime.get(&parts, Flags::PRICING).await?;
```

```rust
// axum: serves /.flags, and evaluates flags for each request.
let app = Router::new()
    .nest_service("/.flags", runtime.service())
    .route("/checkout", get(checkout))
    .layer(runtime.layer());
```

The crate reads the same `flags.env`, overrides, and signatures as TypeScript, so one file serves a TypeScript web app and a Rust API.

## License

[MIT](LICENSE) License
