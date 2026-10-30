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

```json
{
  "$schema": "./node_modules/flargs/schema.json",
  "newCheckout": { "default": false, "public": true },
  "pricing": ["a", "b", "c"]
}
```

```bash
# .env (gitignored), or the deploy environment: sets a value for this environment.
FEATURE_NEW_CHECKOUT=true
```

```ts
import { flags } from 'flargs/values'

// Typed from flags.json. Resolves on the server, or from the page in a browser.
if (flags.newCheckout) renderNewCheckout()
flags.pricing // 'a' | 'b' | 'c'
```

The same flags file and the same reads scale from environment variables to a dev route, personal overrides, and an admin API on the database of the application.

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

- **Declared once, set anywhere:** Each flag is one key in `flags.json` or `flags.toml`, with one default and a generated type. An environment variable sets its value. Find All References locates every read.
- **Server-first:** The server resolves flags. A browser receives values, never rules.
- **Private by default:** A private value never leaves the server. Visibility, not a variable prefix, controls what reaches a browser.
- **Incremental:** Environment variables, a dev route, and an admin API use the same flags file and the same reads.
- **Portable:** The core, server, and browser entries have no dependencies. They run in Node, Bun, Deno, edge runtimes, and browsers.
- **Tested:** Every test runs against a real server, browser, or build, with no mocks.

## Features

- **Declarations:** One key for each flag in a committed `flags.json` or `flags.toml`, validated by a JSON Schema.
- **Typed Values:** Generated types for every flag, such as `'a' | 'b' | 'c'` for a select flag.
- **Environment Variables:** Each flag links to a `FEATURE_*` variable. With no flags file, `FEATURE_NEW_CHECKOUT=true` alone declares a flag.
- **Build Flags:** Compile to literals, so dead branches drop from the bundle and the value never reaches an API.
- **Runtime Flags:** Resolve on the server for each request, from an override, a store value, `decide`, or the default.
- **Dev Route:** A page at `/.flags` toggles flags for one browser, or for every request with admin access.
- **Admin API:** Reads and writes store values over HTTP, for an admin UI, the CLI, or CI.
- **Overrides:** Search parameters such as `?flag.newCheckout=true` override public flags. Signed links override private flags.
- **Stores:** Memory, environment variables, Cloudflare KV, a remote Flargs API, or a table in the database of the application.
- **Integrations:** A fetch handler for Next.js, Cloudflare Workers, and Bun, plus Hono middleware, Node listeners, React, and Vite.
- **CLI and MCP:** Lists, sets, and links flags, checks the environment in CI, and generates types.
- **Rust:** `flargs::flags!("flags.toml")` generates a typed struct at compile time.

## Usage

### Definitions

`flags.json` declares every flag and its default. A value alone is the short form, and an object is the long form.

```json
{
  "$schema": "./node_modules/flargs/schema.json",
  "limits": { "default": { "requests": 100 } },
  "maintenanceBanner": { "build": true, "default": false, "public": true },
  "newCheckout": { "default": false, "description": "Use the new checkout flow.", "public": true },
  "pricing": ["a", "b", "c"]
}
```

| Value of a key      | Flag                                           |
| ------------------- | ---------------------------------------------- |
| `true` or `false`   | a boolean flag with that default               |
| a number            | a number flag with that default                |
| a string            | a string flag with that default                |
| an array of strings | a select flag. The first option is the default |
| an object           | the long form, with the fields below           |

| Field         | Meaning                                                                                    | Default                                          |
| ------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `build`       | `true` makes a build flag, which resolves when the bundle builds                           | `false`                                          |
| `default`     | the default value. An object or an array makes a JSON flag                                 | required                                         |
| `description` | the description, for the dev route, the admin API, and `.env.example`                      | none                                             |
| `env`         | the environment variable name                                                              | `FEATURE_` and the key in `SCREAMING_SNAKE_CASE` |
| `options`     | the values of a select flag. `default` must be one of them                                 | none                                             |
| `public`      | `true` lets the value reach the browser                                                    | `false`                                          |
| `type`        | `'boolean'`, `'json'`, `'number'`, `'select'`, or `'string'`, when inference is not enough | inferred                                         |

Each flag links to an environment variable: `newCheckout` reads `FEATURE_NEW_CHECKOUT`. A `.env` file, `.env.local`, or the deploy environment sets values that differ from the defaults. A `FEATURE_*` variable that the flags file does not declare throws at startup, so a typo does not fail silently.

```bash
# Writes .env.example: every variable, its default, and its description.
flargs env
```

### Types

`flargs/vite` and `flargs generate` read `flags.json` and write `flargs.gen.ts`, which holds the parsed definitions and their types.

```bash
# Writes flargs.gen.ts. flargs/vite runs the same step on each change of flags.json.
flargs generate
```

With no flags file, Flargs reads every `FEATURE_*` variable as a private, untyped flag. Flargs configuration uses a separate prefix: `FLARGS_SECRET`, `FLARGS_TOKEN`, and `FLARGS_URL`.

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
  // Reads flags.json, writes flargs.gen.ts, and resolves build flags from the environment.
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

| Command                            | Purpose                                                   |
| ---------------------------------- | --------------------------------------------------------- |
| `flargs list`                      | lists every flag with its value and source                |
| `flargs get <key>`                 | returns one flag                                          |
| `flargs set <key> <value>`         | sets the store value                                      |
| `flargs unset <key>`               | deletes the store value                                   |
| `flargs link <url> <key=value...>` | returns a signed share link                               |
| `flargs check`                     | validates the environment against the flags file          |
| `flargs env`                       | writes `.env.example` from the flags file                 |
| `flargs generate`                  | writes `flargs.gen.ts` from `flags.json`, or from `--url` |
| `flargs dev`                       | serves the dev route for a flags file                     |

## Rust

```toml
#:schema https://unpkg.com/flargs/schema.json
# flags.toml: the same schema as flags.json. Keys are snake_case and map to camelCase.
pricing = ["a", "b", "c"]

[limits]
default = { requests = 100 }

[maintenance_banner]
build = true
default = false
public = true

[new_checkout]
default = false
description = "Use the new checkout flow."
public = true
```

```rust
// Reads flags.toml at compile time. A bad declaration fails the build at its key.
flargs::flags!("flags.toml");

// Typed keys and enums come from the file.
let pricing: Pricing = runtime.get(&parts, Flags::PRICING).await?;
```

```rust
// axum: serves /.flags, and evaluates flags for each request.
let app = Router::new()
    .nest_service("/.flags", runtime.service())
    .route("/checkout", get(checkout))
    .layer(runtime.layer());
```

The crate uses the same schema, overrides, and signatures as TypeScript. A project with a TypeScript app and a Rust service keeps one file, through the `path` option.

## License

[MIT](LICENSE) License
