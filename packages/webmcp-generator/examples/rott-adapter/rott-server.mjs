// SPDX-License-Identifier: MIT
/**
 * ROTT WebMCP server: wires the generator to the ROTT sidecar's OpenAPI
 * spec and serves the generated tools.
 *
 * Spec resolution (first hit wins):
 *   1. argv[2] or ROTT_OPENAPI_SPEC
 *   2. lane-2's docs/openapi.yaml
 *      /home/hatch/workspace/rott-fleet/lane-2-sidecar/outputs/docs/openapi.yaml
 *   3. the stand-in spec examples/rott-adapter/rott-openapi.example.json
 *      (with a warning — it is derived from AGENTS.md, not lane 2)
 *
 *   node rott-server.mjs [spec-path] [port]
 *   ROTT_SIDECAR_URL   base URL of the sidecar REST API (default http://localhost:8787)
 *   WEBMCP_PORT        port to listen on (default 3200)
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateServerFromFile } from "../../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const LANE2_SPEC =
  "/home/hatch/workspace/rott-fleet/lane-2-sidecar/outputs/docs/openapi.yaml";
const STANDIN_SPEC = join(here, "rott-openapi.example.json");

const baseUrl = process.env.ROTT_SIDECAR_URL ?? "http://localhost:8787";
const port = Number(
  process.argv[3] ?? process.env.WEBMCP_PORT ?? 3200,
);

let specPath = process.argv[2] ?? process.env.ROTT_OPENAPI_SPEC;
let usingStandin = false;
if (!specPath) {
  if (existsSync(LANE2_SPEC)) {
    specPath = LANE2_SPEC;
  } else {
    specPath = STANDIN_SPEC;
    usingStandin = true;
  }
}

if (usingStandin) {
  console.warn(
    "WARNING: lane-2 docs/openapi.yaml not found; serving tools from the " +
      "STAND-IN spec (rott-openapi.example.json). Tool names/shapes will " +
      "change when the real spec lands — re-run with the real spec path.",
  );
}

const server = generateServerFromFile(specPath, { baseUrl });
console.log(`ROTT WebMCP server: spec ${specPath}`);
console.log(`  sidecar base URL: ${baseUrl}`);
console.log(
  `  ${server.manifest.toolCount} tools: ${server.tools.map((t) => t.name).join(", ")}`,
);
const httpServer = await server.listen(port);
const address = httpServer.address();
const actualPort =
  typeof address === "object" && address ? address.port : port;
console.log(`  listening on http://localhost:${actualPort}`);
console.log(`  GET  /tools       list tools`);
console.log(`  POST /tools/call  {"name": ..., "arguments": {...}}`);
console.log(`  POST /             JSON-RPC 2.0 (tools/list, tools/call)`);
console.log(
  `  in-browser: import the built browser bundle and call ` +
    `registerInBrowser() — see webmcp-page-snippet.mjs`,
);
