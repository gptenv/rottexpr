// SPDX-License-Identifier: MIT

import type {
  HandlerContext,
  ToolCallResult,
  ToolDefinition,
} from "./types.js";

const MAX_ERROR_BODY_CHARS = 2000;
const MAX_JSON_BODY_BYTES = 1_000_000;

/** Build the concrete HTTP request for a tool call. */
export function buildRequest(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  ctx: HandlerContext,
): { url: string; init: RequestInit } {
  const remaining: Record<string, unknown> = { ...args };
  let path = tool.operation.path;
  const query = new URLSearchParams();

  // Path parameters are substituted into the URL template.
  for (const match of tool.operation.path.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1];
    const value = remaining[name];
    if (value === undefined || value === null) {
      throw new Error(
        `missing required path parameter "${name}" for tool "${tool.name}"`,
      );
    }
    path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
    delete remaining[name];
  }

  // Query/header parameters declared in the input schema are not
  // distinguishable from body fields at call time, so the rule is:
  // GET/HEAD/DELETE send leftover scalar args as query parameters;
  // other methods send leftovers as a JSON body.
  const method = tool.operation.method.toUpperCase();
  const init: RequestInit = {
    method,
    headers: { ...ctx.headers },
  };

  if (method === "GET" || method === "HEAD" || method === "DELETE") {
    for (const [key, value] of Object.entries(remaining)) {
      if (value === undefined || value === null) continue;
      if (typeof value === "object") continue;
      query.set(key, String(value));
    }
  } else if (Object.keys(remaining).length > 0) {
    (init.headers as Record<string, string>)["content-type"] =
      "application/json";
    init.body = JSON.stringify(remaining);
  }

  const base = ctx.baseUrl.replace(/\/+$/, "");
  const queryString = query.toString();
  return {
    url: `${base}${path}${queryString ? `?${queryString}` : ""}`,
    init,
  };
}

/**
 * Create the handler for one tool: it calls the REST endpoint the tool was
 * generated from and normalises the outcome into a ToolCallResult.
 * HTTP errors are returned, never thrown; only network failures throw.
 */
export function createHandler(
  tool: ToolDefinition,
  ctx: HandlerContext,
): (args: Record<string, unknown>) => Promise<ToolCallResult> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  return async (args) => {
    const { url, init } = buildRequest(tool, args, ctx);
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      throw new Error(
        `tool "${tool.name}" network error calling ${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const text = await response.text();
    let data: unknown;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (response.ok) {
      return { ok: true, status: response.status, data };
    }
    const message =
      typeof data === "string"
        ? data.slice(0, MAX_ERROR_BODY_CHARS)
        : `HTTP ${response.status}`;
    return {
      ok: false,
      status: response.status,
      error: { code: `http_${response.status}`, message, details: data },
    };
  };
}

export interface ToolExecutor {
  tools: ToolDefinition[];
  handlers: Map<string, ReturnType<typeof createHandler>>;
  callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<ToolCallResult>;
  listTools: () => Array<{
    name: string;
    description: string;
    inputSchema: unknown;
  }>;
}

/** Build an executor over a generated tool set. */
export function createToolExecutor(
  tools: ToolDefinition[],
  ctx: HandlerContext,
): ToolExecutor {
  const handlers = new Map<string, ReturnType<typeof createHandler>>();
  for (const tool of tools) {
    handlers.set(tool.name, createHandler(tool, ctx));
  }
  return {
    tools,
    handlers,
    async callTool(name, args) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`unknown tool: ${name}`);
      return handler(args ?? {});
    },
    listTools() {
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    },
  };
}

type JsonRpcHandler = (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
) => void | Promise<void>;

function sendJson(
  res: import("node:http").ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

async function readBody(
  req: import("node:http").IncomingMessage,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new Error("request body exceeds 1MB limit");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Serve the generated tools over HTTP with a JSON-RPC 2.0 surface plus
 * plain-REST conveniences, so agents and tests can drive the tools without
 * a browser:
 *   POST /  {jsonrpc:"2.0", method:"tools/list"|"tools/call", params, id}
 *   GET  /tools            -> {tools:[...]}
 *   POST /tools/call      {name, arguments} -> ToolCallResult
 */
export function serveJsonRpc(executor: ToolExecutor): JsonRpcHandler {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/tools") {
        sendJson(res, 200, { tools: executor.listTools() });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      const raw = await readBody(req);
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(raw || "{}") as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { error: "request body is not valid JSON" });
        return;
      }

      if (url.pathname === "/tools/call") {
        const name = payload["name"];
        if (typeof name !== "string") {
          sendJson(res, 400, { error: 'missing "name"' });
          return;
        }
        try {
          const result = await executor.callTool(
            name,
            (payload["arguments"] as Record<string, unknown>) ?? {},
          );
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      // JSON-RPC 2.0 on / (and any other POST path).
      const method = payload["method"];
      const id = payload["id"] ?? null;
      const params = (payload["params"] ?? {}) as Record<string, unknown>;
      if (method === "tools/list") {
        sendJson(res, 200, {
          jsonrpc: "2.0",
          id,
          result: { tools: executor.listTools() },
        });
        return;
      }
      if (method === "tools/call") {
        const name = params["name"];
        if (typeof name !== "string") {
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: 'missing param "name"' },
          });
          return;
        }
        try {
          const result = await executor.callTool(
            name,
            (params["arguments"] as Record<string, unknown>) ?? {},
          );
          sendJson(res, 200, { jsonrpc: "2.0", id, result });
        } catch (error) {
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not found: ${String(method)}` },
      });
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
