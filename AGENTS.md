# Adapted from wevm/handshakes

Source: https://github.com/wevm/handshakes/blob/main/AGENTS.md
Source commit: `78decd57e6823ec5de899a5acb8bbdb9c227b3a3`. Retrieved 2026-10-30. Handshakes adapts `wevm/ondine`, which adapts `wevm/zyzz`. General TypeScript, module, testing, prose, and Git conventions are retained. Rust conventions are adapted from `wevm/ondine`. Project principles, security, documentation, layout, and commands are adapted for Flargs.

# Agent Guidelines

## Project Principles

- Flargs is a self-hosted feature flag library. It declares flags in a committed `.env.flags` file, evaluates them on the server, and serves a dev route and an admin API from the host application. It is a self-hosted alternative to the Vercel Flags SDK.
- Flargs supports trunk-based development. Unfinished work merges to `main` behind a flag, and the flag, not the branch, controls the release.
- Flargs covers four roles: the definitions (`.env.flags`, parsed by `Definitions` in `flargs`), the instance (`Flargs.create` in `flargs/server`, served through `flargs.fetch`), the values (`flags` in `flargs`), and the build (`flargs/vite`). The CLI and the Rust crate use the same wire format. Stay general purpose. Never add code for one product or one deployment.
- A flag resolves at one of two times. A `build` flag resolves when the bundle is built, compiles to a literal, and never reaches the API. A `runtime` flag resolves on the server for each request.
- `.env.flags` or the store declares each flag. In `.env.flags`, each variable is a flag, its name is the key (`flags.NEW_CHECKOUT`), and its value is the default, and comment lines above it hold the description and JSDoc-style tags: `@type`, `@public`, `@build`, and `@expires`. Without `@type`, the type is inferred from the default. A project uses one source: with `definitions`, the store holds values only. A gitignored `.env` or the deploy environment sets values.
- `public: true`, not a variable prefix, controls whether a value reaches the browser. Flargs configuration variables use the `FLARGS_` prefix.
- `flargs generate` and `flargs/vite` write `flargs.gen.ts` from `.env.flags`. No runtime reads the flags file from disk. Rust parses `.env.flags` at compile time with `flargs::flags!`.
- The server resolves a runtime flag value in one order: an override, the store value, `decide`, then `default`. Change this order only in `.agent/plans/flargs.md` first.
- A flag is `private` unless it declares `visibility: 'public'`. A private flag value never leaves the server, except through the authorized admin API.
- In dev mode, every flag accepts an override. In production, an unsigned override applies only to a public runtime flag. A private flag accepts only a signed override. A build flag accepts no override.
- The dev route sets personal overrides in a cookie. The admin API writes the store, which applies to every request. Keep these two paths separate.
- Keep `flargs/server` and the `browser` condition of `flargs` free of dependencies and of Node built-ins, so they run in Node, Bun, Deno, edge runtimes, and browsers. Sign and verify with WebCrypto. The server condition of `flargs` uses only `AsyncLocalStorage` from `node:async_hooks`, which Node, Bun, Deno, and Workers (`nodejs_compat`) provide.
- The browser snapshot of `flags` in `flargs` is the only module-scope state. Every other module follows the instance conventions below.
- The `.env.flags` format and the JSON manifest of the admin API are the contract between TypeScript, the CLI, and Rust. Shared vectors in `test/vectors/` prove that every implementation evaluates, parses, and signs the same way.
- `.agent/plans/flargs.md` defines the public API, the phases, and the acceptance gates. Update it in the same change as an API decision.

## Security Conventions

- Secrets (`FLARGS_SECRET`, admin tokens, signatures) never appear in errors, logs, CLI output, MCP output, or snapshots.
- The values endpoint, `flargs.script`, and the output of `flargs types` contain public flags only, unless `--visibility all` is set. Return a private value only to a request that `authorize` grants `read` or `write`.
- `authorize` is the only check on the admin API. Write a store value or sign a link only with `write`. `FLARGS_SECRET` signs overrides and never authenticates a request.
- Never serve the dev route in production without `authorize`. Dev mode is an explicit option, never inferred from a hostname or a header.
- Sign overrides and share links with HMAC-SHA256 over the canonical override string. Verify before parsing values, and reject an expired signature.
- Validate every override and store value against the flag definition. Reject an unknown key or a value outside `options`. Never evaluate an override as code.
- Escape embedded JSON with `safeJson` so a flag value cannot close a `<script>` element.
- Compare signatures and tokens in constant time.
- Never read a secret from argv. Read it from an environment variable that the caller names.

## TypeScript Conventions

- Treat `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` as design constraints. Include `| undefined` when an optional property can explicitly receive `undefined`, and narrow indexed reads before use.
- Use `readonly T[]` for array types. Preserve mutable arrays only when mutation is part of the contract.
- Use `type` for project-owned shapes. Use `interface` only when declaration merging or an external ambient contract requires it.
- Include `.js` extensions on relative imports and exports so source remains valid under NodeNext ESM.
- Author every source file and script in TypeScript. `.js` files are banned. Node runs TypeScript natively (`node script.ts`), so scripts need no build step.
- Import module-shaped internal files as namespaces (`import * as Store from './Store.js'`) and access members through the module name. Named imports are fine for types, leaf helpers, command handlers, and third-party APIs that are not module namespaces.
- Import Node built-ins as namespaces unless the neighboring code or API is clearer with a named import.
- Re-export public module files as namespaces (`export * as Store from './Store.js'`). Avoid flattening sibling-module symbols into a barrel.
- Use static imports. Reserve dynamic imports for a real runtime or bundle boundary, not dependency-cycle workarounds.
- Use `import type` and `export type` where an import or export is type-only.
- Use functions and plain data for normal APIs. Classes are limited to errors and framework-required entrypoints.
- Keep error classes in the module that throws them, ordered alphabetically with its public exports. Set custom error `name` values to the namespaced form, such as `Override.InvalidSignatureError`.
- Extend `Errors.BaseError` from `src/internal/Errors.ts` for every error class. Pass `details`, what failed, and `steps`, the imperative sentences that resolve it. The message lists the steps under `To resolve:`, and the CLI prints them on one line with `Errors.inline`. A `TypeError` for a wrong option names the fix in its message.
- Use unions or `as const` objects instead of enums.
- Prefer `camelCase` constants. Preserve uppercase names only when they mirror an external protocol or established neighboring code.
- Use `const` generic parameters when callers should retain literal or tuple types.
- Default optional option bags in the signature (`options: fn.Options = {}`), not with `options?: fn.Options` and downstream fallback logic.
- Name typed option bags `options`. Use a domain noun only when the value is not an options bag.
- Prefer one named object parameter over several positional parameters. An instance-like receiver such as `client` or `store` may be the first positional parameter, followed by an options bag.
- Put a function's parameter, return, and error types in a matching `declare namespace` (`create.Options`, `create.ReturnType`, `create.ErrorType`). Keep a sibling exported type only when several functions share the domain type.
- Avoid inline object types on local variables. When an explicit local object type improves clarity, name it directly above the use.
- Do not extract a named type until it is reused or makes a difficult shape materially easier to read.
- Keep shared domain types beside the module that owns the concept.
- Group a module's Zod schemas in a `schema` namespace, and derive their types beside them (`schema.Metadata`). Export the namespace only when another module validates against the same shape.
- Let declared return types constrain intermediate expressions. Avoid redundant local annotations.
- Return values directly unless a binding is reused or gives a complex expression a useful name.
- Prefer immediately invoked function expressions (IIFEs) with explicit branches and early returns over nested or complex ternary expressions. Keep simple two-way ternaries when both branches are easy to scan. This applies to executable code, not TypeScript conditional types.
- For a fallible local derivation, prefer an IIFE expression over a mutable variable assigned across `try` and `catch` blocks.
- Never destructure parameters in function definitions, including arrow functions, callbacks, and methods. Accept a named parameter and destructure inside the body when reading several properties. When normalizing one field, read `options.field` directly instead of creating a second name.
- Prefer short names whose meaning is clear from local context, such as `options`, `client`, `entry`, and `fn`.
- Keep wire formats, ordered tuples, protocol fields, and other order-sensitive shapes explicit. Do not alphabetize data whose order has meaning. Manifest and wire fields keep their documented names at the wire boundary only.
- Avoid new `any`. Use a precise boundary type, validation, narrowing, or the smallest justified assertion.
- Express times as `expiresAt` in milliseconds since the epoch.
- Separate distinct contexts and logical steps with one blank line in every maintained module, including source, adapters, scripts, and test fixtures. Group setup, guard clauses, derivation, mutation or emission, and final returns so each step is easy to scan.
- Keep a lookup with its immediate guard, related local declarations, and consecutive assertions together. Separate independent branches, loops, local helper functions, and the work following a completed control-flow block. Avoid both dense uninterrupted logic and a blank line after every statement.
- Separate test setup, execution, and assertions. Keep each assertion group beside the operation it verifies. Preserve spacing inside generated source strings, snapshots, and other whitespace-sensitive fixtures.
- Audit logical spacing when adding or editing a module, since formatting tools do not infer context boundaries. Review the surrounding function as well as the changed lines, and keep spacing-only edits free of behavior changes.
- Do not use section-divider comments. Use exports, TSDoc, and whitespace to express module structure.
- Comment invariants and non-obvious reasons, not line-by-line mechanics. Keep comments independent of plans, task IDs, and prior versions.

## Alphabetical Ordering

- Alphabetize imports, named import/export specifiers, public exports, type/interface properties, object properties, enum/union members, unordered lists, configuration maps, scripts, and dependencies. Use case-insensitive lexical order consistently.
- Keep attached documentation with the declaration or property it describes. Keep function overloads and their namespace together. Order local declarations alphabetically within dependency-compatible groups. Do not introduce use-before-initialization or reorder execution.
- Preserve order with observable semantics: the resolution order, tuples, package file inclusions followed by exclusions, workflow steps, test aliases, and regression fixtures testing those orders. Mark intentional exceptions in nearby documentation or comments.
- Keep `name` and `on` first in GitHub workflows, and alphabetize the remaining top-level keys. Preserve the scaffold package.json group order around `[!start-pkg]`, and alphabetize entries within each group. Do not alphabetize prose sections or sequential implementation phases mechanically.

## Module and Instance Conventions

- Organize each module file as one conceptual namespace containing its public types, constants, functions, and errors. Consumers should read calls as `Module.operation(...)`.
- Prefer stateless module functions for pure behavior. Do not create an instance when inputs fully describe the operation.
- When behavior needs dependencies or lifecycle state, expose a factory such as `Flargs.create(options)` that returns a plain object of operations and data.
- Construct instances explicitly at the application boundary and pass them down. Do not hide construction in imports or module-scope singletons.
- Scope an instance to the lifecycle that owns its state, such as one CLI run, one serverless instance, or one test. Do not share mutable state more broadly than required.
- Inject environment-specific capabilities through factory options: `env`, `fetch`, and `store`. Read `process.env` and `globalThis.fetch` only as defaults at that boundary, so tests inject them and nothing stubs a global.
- Type dependencies by the smallest capability the module consumes, not by the concrete SDK client. This keeps adapters interchangeable without wrapper classes.
- Let factory operations close over shared dependencies and state. Do not return methods that depend on `this` or require binding.
- Name the returned public shape after its role (`Client`, `Flargs`, `Store`) when that role is meaningful. Use `create.ReturnType` for a factory-specific shape that has no independent domain name.
- Keep one authoritative instance value. Derive related helpers and views from that instance instead of duplicating configuration or state.
- Keep mutable caches private to the instance. Expose explicit operations, such as `invalidate`, and provide reset or disposal only when the lifecycle requires it.
- Avoid side-effect registration. `sideEffects: false` means an import used only to install global behavior can disappear from a bundle.
- Keep default implementations directly reachable from the factory or resolver that selects them so bundlers can tree-shake unused paths.
- Keep request building, response parsing, and policy matching pure. Put file system, process, and network behavior in thin adapters around that core.
- Keep internal helpers under `internal/` and export them only when another module has a real contract with them.
- Add new public modules through the owning entrypoint as documented namespace exports. Keep the public surface lean and derive values that the library already knows.

## Type Inference Conventions

- Preserve literal inputs through public helpers when those literals affect the output type.
- Keep generic types flowing from inputs through callbacks and return values. Do not erase them to `any` at an internal seam.
- Prevent public callbacks, options, and return values from leaking `any`.
- Add consumer `.test-d.ts` fixtures beside their owning module (for example, `src/Client.test-d.ts`) with `expectTypeOf` and expected compiler errors when public inference or narrowing changes. Import public entrypoints, and make sure TypeScript checks the fixtures.
- Revisit inference after changing an API. Prefer a narrower useful contract over a broad type that merely compiles.

## Abstraction Conventions

- Start with concrete code and extract only after repeated uses reveal a stable shared contract.
- Prefer small local duplication over an abstraction that adds flags, modes, or call-site-specific branches.
- Wait for at least three concrete uses before introducing a general abstraction unless a hard boundary already exists.
- Optimize for code that is easy to change, not maximum DRYness.
- Keep authoritative state, configuration, schemas, and constants in one place. Derive dependent values.
- Avoid wrappers that only rename another function or mirror an SDK without narrowing capabilities or adding a domain contract.

## Code Documentation

- Start every maintained TypeScript module with a brief standalone TSDoc `@module` comment describing its responsibility. Place it before imports, or after a required shebang. Include entrypoints, internal modules, tooling, fixtures, integration tests, and type fixtures. Describe the module rather than repeating its filename. Keep export-level TSDoc separately.
- Add TSDoc to every public export and public type property. Write or update the contract documentation alongside the implementation.
- Document caller-visible purpose, inputs, output, defaults, errors, and side effects. Keep low-level wiring in nearby implementation comments.
- Update the owning entrypoint documentation when adding or changing a public module.

## Writing Documentation

Applies to the README, guides, and other Markdown documentation. Prose Conventions also apply.

- Write for developers who know HTTP and have shipped behind a feature flag. Define each term (override, store value, build flag) at first use, and use that term everywhere after.
- Explain behavior through a request, its response, and the code that sends it.
- Keep guides platform-neutral. When setup differs by platform, such as Next.js, Vite, or Cloudflare Workers, show every platform.
- Organize each guide into Overview, Walkthrough, Recipes, and More sections. Give each framework a guide.
- Keep each paragraph to one idea in about 40 words, and at most three paragraphs per section.
- Use bullets for enumerable content and tables for comparisons. Start each item of a topic list with a bold label that ends in a colon.
- Write headings in Title Case with fewer than four words.
- Give every code block at least one comment. Formats without comments, such as JSON and HTTP, are exempt.
- Mark unimplemented APIs with `> [!NOTE]` callouts, or `:::note` in Vocs pages. Examples must not imply that they already work.
- Add each new page of `docs/` to the sidebar in `docs/vocs.config.ts`, and update the API and CLI reference pages in the same change as the API or the command.

## Prose Conventions

Applies to documentation, comments, TSDoc, interface copy, commit messages, and pull requests.

- Write about the code, not about the person using it. Avoid second person outside interface copy.
- Describe behavior in technical terms rather than by the experience it produces.
- Write formally, concisely, and technically. Use precise verbs such as "returns", "requests", "evaluates", "resolves", "rejects", and "throws", not conversational ones such as "hands", "gets", "gives", "sees", "knows", "says", or "tells".
- State an invariant or a reason the code cannot show on its own. Leave out justification the code already makes plain.
- Write close to ASD-STE100 Simplified Technical English. Apply its writing rules below, but not its full dictionary.
- Use the short, common word: "use", "start", "before", "about", "make sure", not "utilize", "commence", "prior to", "approximately", "ensure". Technical names and project terms, such as "override", "store value", and "manifest", are always valid.
- Use one word for one thing, and give each word one meaning and one part of speech. Do not use a synonym for variety.
- Keep an instruction to 20 words or fewer, and a descriptive sentence to 25 words or fewer. Give one instruction in each sentence, unless the actions occur at the same time.
- Keep each paragraph to one topic and six sentences or fewer. Use a vertical list for sequential steps or several conditions.
- Put a condition before the instruction it controls: "If the signature expires, run `flargs link` again."
- Use the active voice in instructions. Use the passive voice in descriptions only when the agent is unknown or not important.
- Use the imperative, simple present, simple past, and simple future. Do not use a progressive (`-ing`) or perfect form as the main verb. An `-ing` word in a technical name, such as "signing secret", is valid.
- Do not stack more than three nouns, except in a technical name. Break a longer cluster with a preposition.
- Do not leave out "the", "a", or "this" to make a sentence shorter.
- Start sentences in different ways, but keep each sentence simple.
- Use a diagram, not prose, to show a flow or how components connect, and keep it to about 12 nodes. Use a Mermaid `sequenceDiagram` for requests between participants. Use a table, not a paragraph, to compare options or map inputs to outputs.
- Do not use semicolons or em dashes in prose. Split the sentence, or use a comma, colon, or parenthesis. Semicolons remain valid inside code.
- Keep PR titles and bodies short and concrete. Explain the problem and resulting behavior in a few sentences, include one small example, and add one validation line.

## Testing Conventions

- Keep one runtime test file per module (`Module.test.ts`) and one type-test file (`Module.test-d.ts`). Express contexts with named `describe` blocks inside those files. Do not create `Module.context.test.ts`. Scope context-specific fixtures and lifecycle hooks to their `describe` block.
- Encapsulate every `.test-d.ts` assertion and expected compiler error in a named `test` inside a `describe` for the public function.
- Group tests in a `describe` named after the public function under test, such as `describe('create')`. These groups exercise complete integration flows, not isolated function implementations.
- Runtime coverage is integration-only. Do not write unit tests, private-helper tests, or per-function suites disguised as integration tests.
- Colocate integration suites and consumer type fixtures with their owning module: `Client.test.ts` and `Client.test-d.ts` beside `Client.ts`. Keep the shared harness under `test/`.
- No mocking, stubbing, fake implementations, module replacements, fake timers, or stubbed globals. Run every flow against a real server or platform:
  - **Server:** `flargs.fetch` behind a local HTTP server on a random port, with its own `Store.memory()`.
  - **Admin store:** a second `Flargs.create` instance as the remote store for `Store.http`, so writes travel over real HTTP.
  - **Browser:** the dev route and `flargs/react` in a real browser through Vitest browser mode.
  - **Build:** a real Vite build of a fixture app, with assertions on the emitted bundle.
  - **Processes:** the built CLI against a local `flargs.fetch`, and the Rust crate against the same server and vectors.
- Write store values through the admin API. Never write into a store directly in a test that covers the server.
- Cover complete supported flows as they land. Before a later stage exists, test the real available public boundary, and do not fabricate a downstream stage.
- Exclude colocated tests and type fixtures from published files and build outputs.
- Snapshot values and results individually. Do not assemble unrelated values into an object or array only to combine snapshot assertions.
- Assert observable runtime results and public diagnostics with inline snapshots (`toMatchInlineSnapshot` or `toThrowErrorMatchingInlineSnapshot`). Pass property matchers for genuinely nondeterministic fields, such as ports, times, and signatures. Review generated snapshots before accepting them. Never derive expected output from the implementation under test.
- Assert that no snapshot holds a secret or a signature. Replace it with a property matcher, never with a recorded value.
- Add an integration regression scenario for every bug fix.
- Use bounded waits for observable conditions, isolate real resources, and clean them up after success or failure. Do not hide flakes with arbitrary sleeps or retries.

## Rust Conventions

The `flargs` crate evaluates the same manifest, overrides, and signatures as the TypeScript packages. These conventions are adapted from `wevm/ondine`. Project principles, TypeScript conventions, and testing rules still apply wherever they have a Rust equivalent.

- Keep evaluation, override parsing, and signing pure in the `flargs` crate. Put HTTP behind the `client` feature, the dev route behind the `server` feature (a `tower::Service`), the extractor behind `axum`, and `build.rs` support behind `build`.
- Keep `flargs-macros` a thin proc-macro crate. It reads `.env.flags` with the parser that the vectors cover, reports errors with `syn::Error` spans that name the key, and emits calls into `flargs`. Runtime logic in the macro is a defect.
- Use edition 2024 and pin the toolchain in `rust-toolchain.toml`. Declare `rust-version` in the workspace.
- Configure `[workspace.lints]` with `clippy::all` and `clippy::pedantic` at `warn` (priority `-1`), plus `allow_attributes`, `dbg_macro`, `get_unwrap`, `print_stderr`, `print_stdout`, `todo`, `undocumented_unsafe_blocks`, and `unimplemented`. Allow only `module_name_repetitions`, `must_use_candidate`, `similar_names`, and `too_many_lines`.
- Suppress a lint locally with `#[expect(lint, reason = "...")]`, never `#[allow]`. Deny `unsafe_code`.
- Encode invariants in types instead of `unwrap`, `expect`, slicing, or `panic!`. Production paths use `get`, pattern matching, and `let` chains.
- Use plain data, functions, and enums. Traits exist for real polymorphism, such as `Store`, not for namespacing.
- Order `use` declarations, struct fields, and enum variants alphabetically unless order is observable. Mark observable order with a comment.
- Start every module with a `//!` comment describing its responsibility, and document every public item. Enable `missing_docs` and `unreachable_pub`.
- Rust tests live in `crates/flargs/tests/`, run the shared vectors and the TypeScript server end to end, and assert with inline `insta` snapshots. Unit tests of private helpers and mocks are banned, as in TypeScript.
- Cover macro diagnostics with `trybuild` compile-fail fixtures in `crates/flargs/tests/ui/`, the Rust equivalent of `.test-d.ts` fixtures.

## Workflow Conventions

- Use the smallest repository script that covers the changed behavior. Run focused tests while iterating.
- Run `pnpm check:types` after TypeScript changes.
- `pnpm check` runs formatting and syntax-only lint with fixes. Run `pnpm check:types` separately for type checks. Inspect and keep only task-related changes.
- Run `git diff --check` and inspect the final diff before reporting completion.

## Git Conventions

- Conventional commits, lowercase, no trailing period: `feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `test:`, `chore:`. Scope optional.
- Name the thing that changed, in the identifiers the codebase already uses. Prefer `feat: add Flargs.create` over `feat: let apps read flags`.
- State the change, not the reason for it. Leave `because`, `so that`, and `in order to` out of the subject.
- Write each message to stand alone for a reader who has not seen the pull request or the task that produced it.
- Never force push and never amend a pushed commit. Correct a mistake with a follow-up commit.
- Always commit and push directly to `main`. Never create or push to another branch, and never open a pull request.

## Repository Layout

- `src/`: flat PascalCase modules of the core entry (`Definitions`, `Override`, `Values`), with colocated tests. `src/index.ts` re-exports them as namespaces, and exports `flags` directly.
- `src/hono/`, `src/node/`, `src/react/`, `src/server/`, `src/vite/`, `src/zile/`: the `flargs/hono`, `flargs/node`, `flargs/react`, `flargs/server`, `flargs/vite`, and `flargs/zile` entries.
- `src/server/internal/Page.ts`: the dev route page, one HTML document with inline styles and no runtime dependency.
- `src/cli/`: the incur CLI. `bin.ts` is the entry, and each command lives in its own file.
- `src/internal/`: helpers that no entry exports.
- `crates/flargs/`: the Rust crate. `crates/flargs-definitions/`: the parser that the crate and the macro share. `crates/flargs-macros/`: the `flargs::flags!` macro.
- `test/`: the shared harness. `test/vectors/`: evaluation, override, and signature vectors that TypeScript and Rust both run.
- `docs/`: the Vocs documentation site, a private workspace package. Pages live in `docs/src/pages/`, organized as Introduction, Guides, API Reference, and CLI Reference. `docs/vocs.config.ts` holds the sidebar.
- `.agent/plans/flargs.md`: the plan, the public API, and the acceptance gate of each phase.

## Tooling

- Declare all package dependencies with `catalog:` references. Keep versions in `pnpm-workspace.yaml`, never inline in package manifests.
- Prettier is banned. Use Vite Plus with oxfmt for formatting and oxlint for linting, configured in `vite.config.ts`.
- Use zile for library builds and development linking.
- Put scripts, devDependencies, and packageManager before `[!start-pkg]` in package.json. Package metadata and runtime dependencies follow it. Alphabetize entries within each group.
- Use the single scaffold tsconfig.json for the package. `docs/` has its own tsconfig.json, and the root one excludes it. Zile derives build inputs from package entrypoints. Add each entry to `paths` in `tsconfig.json` and to the test aliases in `vite.config.ts`.
- `incur` is the one runtime dependency, for the CLI. `hono`, `react`, `vite`, and `zile` are optional peers.
- Use Vocs for the documentation site. `docs/src/pages/_root.css` holds the theme overrides: black and a lighter black in dark mode, and square corners.

## Commands

- `pnpm build` builds the package with zile. `pnpm dev` links source entrypoints with `zile dev`.
- `pnpm check` runs `vp check --fix`. `pnpm check:types` runs TypeScript.
- `pnpm test` runs the integration and vector suites with `vp test`.
- `pnpm docs:dev` serves the documentation site. `pnpm docs:build` builds it and fails on a dead link.
- `node src/cli/bin.ts` runs the CLI from source while it imports only dependencies. The CLI test bundles it with esbuild.
- `cargo test --workspace`, `cargo fmt --all --check`, and `cargo clippy --workspace --all-targets -- -D warnings` check Rust.
