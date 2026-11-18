// SPDX-License-Identifier: MIT

import type { ToolDefinition } from "./types.js";
import type { ToolExecutor } from "./runtime.js";

export type WebMcpAvailability = "native" | "polyfill" | "unavailable";

/**
 * The W3C WebMCP surface: `navigator.modelContext.registerTool`.
 * The w3c-oss/webmcp-polyfill implements the same surface in browsers
 * without native support, and marks itself so callers can tell the two
 * apart. This module is safe to import in Node: every access is guarded
 * by a `typeof navigator` check.
 */
interface ModelContextLike {
  registerTool: (
    name: string,
    description: string,
    inputSchema: unknown,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ) => unknown;
}

function getModelContext(): ModelContextLike | undefined {
  if (typeof navigator === "undefined") return undefined;
  const nav = navigator as unknown as Record<string, unknown>;
  const mc = nav["modelContext"];
  if (!mc || typeof mc !== "object") return undefined;
  const registerTool = (mc as Record<string, unknown>)["registerTool"];
  if (typeof registerTool !== "function") return undefined;
  return mc as unknown as ModelContextLike;
}

/** Detect whether WebMCP is available, and in what form. */
export function detectWebMCP(): WebMcpAvailability {
  if (typeof navigator === "undefined") return "unavailable";
  const nav = navigator as unknown as Record<string, unknown>;
  if (nav["__webmcpPolyfill"]) return "polyfill";
  return getModelContext() ? "native" : "unavailable";
}

export interface BrowserRegistrationResult {
  webmcpAvailable: boolean;
  registered: string[];
  skipped: string[];
}

/**
 * Register generated tools with the page's WebMCP surface (native or
 * polyfill). Each handler delegates to the same executor the Node
 * JSON-RPC server uses, so browser and server behaviour match.
 * In Node (or a browser without WebMCP) every tool is reported skipped.
 */
export async function registerToolsWithWebMCP(
  tools: ToolDefinition[],
  executor: ToolExecutor,
): Promise<BrowserRegistrationResult> {
  const modelContext = getModelContext();
  if (!modelContext) {
    return {
      webmcpAvailable: false,
      registered: [],
      skipped: tools.map((tool) => tool.name),
    };
  }
  const registered: string[] = [];
  const skipped: string[] = [];
  for (const tool of tools) {
    try {
      await modelContext.registerTool(
        tool.name,
        tool.description,
        tool.inputSchema,
        async (args) => {
          const result = await executor.callTool(tool.name, args ?? {});
          if (!result.ok) {
            throw new Error(
              result.error?.message ?? `tool ${tool.name} failed`,
            );
          }
          return result.data;
        },
      );
      registered.push(tool.name);
    } catch {
      skipped.push(tool.name);
    }
  }
  return { webmcpAvailable: true, registered, skipped };
}
