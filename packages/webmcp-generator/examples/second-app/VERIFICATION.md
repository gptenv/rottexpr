<!-- SPDX-License-Identifier: MIT -->
# Second-app verification record

Run on 2026-11-18, Node v26.13.1, from
`packages/webmcp-generator/` after `npm install && npm run build`:

```sh
node examples/second-app/verify.mjs
```

Result: **13 checks, all PASS, exit 0.**

- `[json spec]` and `[yaml spec]` each: `tools/list` returns the 4
  generated tools (`completeTask, createTask, getTask, listTasks`);
  `deleteTask` excluded (`x-webmcp-disabled`); `listTasks` input schema
  carries the `done` query param; `createTask` input schema resolves
  the `$ref` (`title` required).
- `tools/call createTask` succeeds (created task id 3, title "Verify me").
- `tools/call listTasks` sees the new task (3 tasks).
- `tools/call completeTask` marks it done; `getTask` reads it back done.
- `tools/call getTask` on missing id 99999 returns `ok:false`, status 404.

Unit tests in the same run (`npm test`): **11 pass, 0 fail**, covering
tool naming, schema merging, `$ref` resolution, the YAML subset parser
(including block scalars and flow collections), the executor's HTTP
mapping, and the JSON-RPC server.
