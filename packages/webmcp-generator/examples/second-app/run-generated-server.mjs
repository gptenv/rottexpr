// SPDX-License-Identifier: MIT
/**
 * Run the generated WebMCP server for the TaskBoard example.
 *
 *   node run-generated-server.mjs [spec] [rest-base-url] [port]
 *
 * Defaults: taskboard-openapi.json, http://localhost:3101, port 0
 * (OS-assigned, printed on stdout).
 */
import { existsSync } from "node:fs";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateServerFromFile } from "../../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));

// A relative spec path resolves against this script's directory first
// (so the script works from any cwd), then against the cwd.
function resolveSpecPath(specPath) {
  if (isAbsolute(specPath)) return specPath;
  const besideScript = join(here, specPath);
  return existsSync(besideScript) ? besideScript : resolve(specPath);
}

const specPath = resolveSpecPath(
  process.argv[2] ?? "taskboard-openapi.json",
);
const baseUrl = process.argv[3] ?? "http://localhost:3101";
const port = Number(process.argv[4] ?? 0);

const server = generateServerFromFile(specPath, { baseUrl });
const httpServer = await server.listen(port);
const address = httpServer.address();
const actualPort =
  typeof address === "object" && address ? address.port : port;
console.log(
  `taskboard webmcp server: ${server.manifest.toolCount} tools ` +
    `at http://localhost:${actualPort}`,
);
console.log(`tools: ${server.tools.map((t) => t.name).join(", ")}`);
