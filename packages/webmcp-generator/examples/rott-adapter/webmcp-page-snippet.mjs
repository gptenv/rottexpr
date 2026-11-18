// SPDX-License-Identifier: MIT
/**
 * Browser-side WebMCP registration for the ROTT app — usage snippet.
 *
 * This file is documentation, not a runnable script on its own: in the
 * real app it is bundled (or served as an ES module with an import map
 * pointing at the built generator dist) alongside the game page, after
 * the W3C WebMCP polyfill has loaded:
 *
 *   <script src="https://cdn.jsdelivr.net/npm/@w3c/webmcp-polyfill@latest/dist/webmcp-polyfill.js"></script>
 *   <!-- the polyfill installs navigator.modelContext when the browser
 *        has no native WebMCP support -->
 *
 * What this snippet does:
 *   1. Loads the ROTT OpenAPI spec (lane-2 docs/openapi.yaml, served by
 *      the app or the sidecar).
 *   2. Generates the tools and points them at the sidecar REST API.
 *   3. Registers them with navigator.modelContext (native WebMCP or the
 *      w3c-oss/webmcp-polyfill), so an agent client in the page can list
 *      and call them to drive the game.
 *
 * Live-browser verification against the polyfill is OUTSTANDING: this
 * lane has no browser. The registration path is structurally verified
 * in Node (detectWebMCP() returns "unavailable" there and
 * registerToolsWithWebMCP() reports every tool skipped, which is the
 * designed no-WebMCP behaviour) — see VERIFICATION.md.
 *
 * Example (adapt paths to the app's bundling):
 *
 *   import { generateServerFromText, detectWebMCP } from "./webmcp-generator/dist/index.js";
 *
 *   const specText = await (await fetch("/docs/openapi.yaml")).text();
 *   const server = generateServerFromText(specText, {
 *     baseUrl: "http://localhost:8787", // sidecar REST API
 *   });
 *
 *   console.log("WebMCP availability:", detectWebMCP());
 *   // "native" | "polyfill" | "unavailable"
 *
 *   const { registered, skipped } = await server.registerInBrowser();
 *   console.log(`registered ${registered.length} tools`, registered);
 *   if (skipped.length) console.warn("not registered:", skipped);
 *
 *   // An agent client can now discover the tools through
 *   // navigator.modelContext and call them; every call goes through
 *   // the same handlers as the Node JSON-RPC server.
 */
export {};
