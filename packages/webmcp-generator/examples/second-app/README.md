<!-- SPDX-License-Identifier: MIT -->
# Second-app proof: TaskBoard

A deliberately tiny, unrelated app that proves the WebMCP generator
works for **any** OpenAPI spec, not just ROTT.

- `taskboard-openapi.json` / `.yaml` — the same 4-operation TaskBoard
  API in both formats (`listTasks`, `createTask`, `getTask`,
  `completeTask`; `deleteTask` is present in the spec but marked
  `x-webmcp-disabled: true`, so no tool is generated for it).
- `stub-api.mjs` — an in-memory REST implementation of the API
  (default port 3101). Not part of the generator.
- `run-generated-server.mjs` — generates the WebMCP server for the spec
  and serves it (default: JSON spec, stub base URL, OS-assigned port).
- `verify.mjs` — end-to-end check: spawns the stub + one generated
  server per spec format, lists the tools, and drives the app through
  `tools/call` (create → list → complete → read back, plus a 404 case).

## Run it

```sh
cd packages/webmcp-generator
npm install && npm run build
node examples/second-app/verify.mjs
```

Expected: 13 checks, all PASS, exit 0. See `VERIFICATION.md` for the
recorded run.
