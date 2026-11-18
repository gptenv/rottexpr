<!-- SPDX-License-Identifier: MIT -->
# Generator usage guide

How to point `@rott/webmcp-generator` at **any** OpenAPI 3.1 spec and get
a WebMCP server for it. The generator is application-agnostic: it contains
no ROTT-specific code. The worked example in this guide is the TaskBoard
proof in `packages/webmcp-generator/examples/second-app/` — a tiny,
unrelated app that exists precisely to demonstrate that any spec works.

For the package's own reference, see
`packages/webmcp-generator/README.md`. For the ROTT wiring that uses the
same generator, see `packages/webmcp-generator/examples/rott-adapter/`.

## What the generator does

Input: an OpenAPI 3.1 spec (JSON or YAML), plus the base URL of the REST
API that implements it.

Output: a WebMCP server whose tools come from the spec's operations:

- one **tool per operation** in the spec's `paths`, named from the
  `operationId` (sanitized to `[A-Za-z0-9_-]`), or from `method_path`
  (for example `get_tasks_by_id`) when an operation has no `operationId`;
- an **input schema** (JSON Schema) merged from the operation's
  path/query/header parameters and its `application/json` request body,
  with `$ref`s to `#/components/schemas/...` resolved;
- a **handler** that calls the same REST endpoint the tool was generated
  from, over HTTP to the configured base URL — the same functions as the
  REST API, reached through the API itself.

Operations marked `x-webmcp-disabled: true` are skipped: no tool is
generated for them. The generator never talks to the application any
other way — HTTP to the REST API, and the WebMCP surface. It never links
into, modifies, or reads the memory of any engine.

## Requirements

- Node via nvm (see the repo `AGENTS.md` environment notes). The package
  builds with the repo's TypeScript setup; no dependency pins, rolling
  targets.
- The REST API your spec describes must actually be running at the base
  URL you pass. The generator does not implement the API — it proxies
  tool calls to it.

Build the package first:

```sh
cd packages/webmcp-generator
npm install
npm run build
```

## CLI

```sh
node dist/cli.js --spec <openapi.json|yaml> --base-url <rest base URL> [--port <n>] [--list-only]
```

Flags:

| Flag | Required | Meaning |
| --- | --- | --- |
| `--spec <path>` | yes | OpenAPI 3.1 spec file, JSON or YAML |
| `--base-url <url>` | yes | Base URL of the REST API the tools call |
| `--port <n>` | no | Port to listen on. Default `0`, i.e. an OS-assigned port, printed on stdout |
| `--list-only` | no | Print the generated tool manifest as JSON and exit, without serving |

Examples:

```sh
# Serve tools for a spec, proxying to its REST API on port 3200:
node dist/cli.js --spec ./openapi.yaml --base-url http://localhost:8787 --port 3200

# Or just print the generated manifest, to check what would be generated:
node dist/cli.js --spec ./openapi.yaml --base-url http://localhost:8787 --list-only
```

`--list-only` is the cheapest way to validate a new spec: it loads the
spec, generates every tool, and prints the manifest (tool names, input
schemas, count) without needing the REST API to be running.

## Programmatic API

```js
import { generateServerFromFile } from "@rott/webmcp-generator";

const server = generateServerFromFile("./openapi.yaml", {
  baseUrl: "http://localhost:8787",
});
console.log(server.manifest.toolCount, "tools");
await server.listen(3200);
const result = await server.executor.callTool("getState", {});
// In a page with WebMCP (native or polyfill):
await server.registerInBrowser();
```

Entry points (all exported from the package index):

- `generateServer(spec, ctx)` / `generateServerFromFile(specPath, ctx)` /
  `generateServerFromText(specText, ctx)` — one-call wiring. Returns a
  server object with `spec`, `tools`, `manifest`, `executor`,
  `jsonRpcHandler`, `registerInBrowser()`, `detectWebMCP()`, and
  `listen(port)` (port `0` = OS-assigned). The same executor backs both
  the Node server and browser registration, so behaviour matches on both
  transports.
- `generateTools(spec)` / `buildManifest(spec, tools)` / `toolNameFor` /
  `buildInputSchema` / `deref` — pure generation, no serving
  (`src/generator.ts`).
- `createToolExecutor(tools, ctx)` / `createHandler` / `serveJsonRpc` —
  execution + HTTP serving (`src/runtime.ts`).
- `detectWebMCP()` / `registerToolsWithWebMCP(tools, executor)` — browser
  registration (`src/browser.ts`).
- `loadSpecFile(path)` / `loadSpecFromText(text)` / `SpecLoadError` — spec
  loading (`src/loadSpec.ts`).

The handler context `ctx` is `{ baseUrl }`: the base URL of the REST API
the generated handlers call.

## Writing a spec the generator accepts

- **OpenAPI 3.1**, JSON or YAML. `info.title` becomes the manifest name.
- **Give every operation an `operationId`.** It becomes the tool name
  (after sanitizing non-`[A-Za-z0-9_-]` characters to `_`). Without one,
  the tool is named `method_path` (for example `get_tasks_by_id`) —
  usable, but harder for an agent to guess, so prefer explicit
  `operationId`s.
- **Parameters and request bodies become the input schema.** Path, query,
  and header parameters plus the `application/json` request body are
  merged into one JSON Schema per tool. `$ref`s under
  `#/components/schemas/...` are resolved, so shared schemas work.
  Describe each parameter and body field: the `description` text is what
  the agent sees when deciding how to call the tool.
- **To hide an operation, set `x-webmcp-disabled: true` on it.** The
  operation stays in the spec and in the REST API; it just gets no tool.
  Use this for destructive or admin operations you do not want agents to
  reach.
- **YAML support is a subset parser.** `loadSpecFile` / `loadSpecFromText`
  accept JSON, or YAML via a small built-in subset parser: nested maps,
  `- ` lists, quoted/plain scalars, numbers, booleans, null, literal `|`
  and folded `>` block scalars, and flow collections of scalars
  (`[a, b]`, `{k: v}`). Anchors, aliases, tags, and block scalars in list
  items are rejected with a clear `SpecLoadError`. For full YAML, convert
  the spec to JSON first.
- **Responses do not affect generation.** Tools are generated from
  operations, parameters, and request bodies only; response schemas are
  ignored. The handler returns whatever the REST endpoint returns.

## Worked example: TaskBoard

The proof that the generator works for any app is the TaskBoard example
at `packages/webmcp-generator/examples/second-app/`:

- `taskboard-openapi.json` / `taskboard-openapi.yaml` — the same
  4-operation TaskBoard API in both formats: `listTasks`, `createTask`,
  `getTask`, `completeTask`. A fifth operation, `deleteTask`, is present
  in the spec but marked `x-webmcp-disabled: true`, so no tool is
  generated for it — the generated server has 4 tools, not 5.
- `stub-api.mjs` — an in-memory REST implementation of the API (default
  port 3101). Not part of the generator; it stands in for "your app's
  REST API".
- `run-generated-server.mjs` — generates the WebMCP server for the spec
  and serves it (defaults: JSON spec, stub base URL
  `http://localhost:3101`, OS-assigned port).
- `verify.mjs` — end-to-end check: spawns the stub plus one generated
  server per spec format, lists the tools, and drives the app through
  `tools/call` (create → list → complete → read back, plus a 404 case).
  See `VERIFICATION.md` for the recorded run.

Run it:

```sh
cd packages/webmcp-generator
npm install && npm run build
node examples/second-app/verify.mjs
```

Expected: 13 checks, all PASS, exit 0.

To point the generator at your own spec instead, copy the shape of
`run-generated-server.mjs`: load your spec with
`generateServerFromFile`, pass your API's base URL, and listen:

```sh
# 1. Start your REST API (whatever it is) on its usual port.
# 2. Serve its generated WebMCP tools:
node dist/cli.js --spec ./my-api.yaml --base-url http://localhost:3101 --port 3200
# 3. Check what was generated:
node dist/cli.js --spec ./my-api.yaml --base-url http://localhost:3101 --list-only
```

## Transports

The generated server can be reached two ways, backed by one executor, so
behaviour is the same on both.

### Node HTTP server

The CLI (and `server.listen(port)`) serves a JSON-RPC 2.0 / plain-REST
HTTP server:

- `GET /tools` — list tools: `{ tools: [...] }`.
- `POST /tools/call` — call a tool: `{"name": ..., "arguments": {...}}`
  → the tool-call result.
- `POST /` — JSON-RPC 2.0: `{jsonrpc: "2.0", method: "tools/list" |
  "tools/call", params, id}`.

Calling a generated tool with `curl`:

```sh
# List the tools:
curl http://localhost:3200/tools

# Call one (TaskBoard example — create a task):
curl -X POST http://localhost:3200/tools/call \
  -H 'Content-Type: application/json' \
  -d '{"name": "createTask", "arguments": {"title": "Buy milk"}}'

# Same call over JSON-RPC:
curl -X POST http://localhost:3200/ \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc": "2.0", "method": "tools/call",
       "params": {"name": "createTask", "arguments": {"title": "Buy milk"}},
       "id": 1}'
```

This is how agents and tests drive the tools without a browser.

### Browser (native WebMCP or polyfill)

`registerInBrowser()` registers the same tools with
`navigator.modelContext` — native WebMCP where the browser supports it,
or the `w3c-oss/webmcp-polyfill` where it does not. `detectWebMCP()`
reports which case applies. The browser registration uses the same
executor as the Node server, so a tool behaves identically in the page
and over HTTP. Note the origin-trial status of native WebMCP in Chrome
is time-limited (the trial runs to Mar 30, 2027); the polyfill is the
fallback when native support is absent.

## Troubleshooting

- **`SpecLoadError` on load** — the spec uses YAML the subset parser
  rejects (anchors, aliases, tags, block scalars in list items). Convert
  the spec to JSON and retry; JSON loads without the subset limits.
- **Tool calls fail with connection errors** — the REST API is not
  running at `--base-url`, or the base URL is wrong. The generator only
  proxies; check the API itself first (`curl <base-url>` on a known
  endpoint). The generated ROTT adapter logs this shape explicitly: a
  failed `fetch` to the sidecar is reported, not hidden.
- **A tool is missing** — check whether its operation has
  `x-webmcp-disabled: true`, and check `--list-only` output: if the tool
  is absent from the manifest, it was never generated. If it is in the
  manifest but the call fails, the problem is the REST endpoint, not the
  generator.
- **Tool name is not what you expected** — without an `operationId` the
  name falls back to `method_path`. Add an `operationId` to the operation
  in the spec.
- **Port already in use** — omit `--port` (default `0` picks an
  OS-assigned port, printed on stdout) or pick a free port.
- **The generated server serves tools but nothing happens** — the tools
  call the REST API; if the API is a stub or the game/app is not running,
  calls return the API's own errors. Start the app first, then the
  generated server.

## Tests

```sh
cd packages/webmcp-generator
npm test   # node --test; 11 tests, no external services
```

## License

MIT. The generator is separate MIT sidecar code: it talks to apps only
over HTTP and the WebMCP surface. It never links into, modifies, or reads
the memory of any engine.
