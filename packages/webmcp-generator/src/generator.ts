// SPDX-License-Identifier: MIT

import type {
  JsonSchema,
  OpenApiOperation,
  OpenApiSpec,
  ToolDefinition,
  ToolManifest,
} from "./types.js";

const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
]);

const MAX_DEREF_DEPTH = 10;

/** Resolve a local `#/components/schemas/<Name>` $ref, recursively. */
export function deref(
  schema: JsonSchema,
  spec: OpenApiSpec,
  depth = 0,
): JsonSchema {
  if (!schema || typeof schema !== "object") return schema;
  if (depth >= MAX_DEREF_DEPTH) return schema;
  if (typeof schema.$ref === "string") {
    const match = /^#\/components\/schemas\/([^/]+)$/.exec(schema.$ref);
    if (match) {
      const target = spec.components?.schemas?.[match[1]];
      if (target) {
        const { $ref: _ignored, ...rest } = schema;
        void _ignored;
        return deref({ ...target, ...rest }, spec, depth + 1);
      }
    }
    return schema;
  }
  const out: JsonSchema = { ...schema };
  if (out.properties) {
    const props: Record<string, JsonSchema> = {};
    for (const [key, value] of Object.entries(out.properties)) {
      props[key] = deref(value, spec, depth + 1);
    }
    out.properties = props;
  }
  if (out.items) out.items = deref(out.items, spec, depth + 1);
  if (out.additionalProperties && typeof out.additionalProperties === "object") {
    out.additionalProperties = deref(
      out.additionalProperties as JsonSchema,
      spec,
      depth + 1,
    );
  }
  return out;
}

function sanitizeOperationId(operationId: string): string {
  return operationId.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Derive a stable tool name from an operation. */
export function toolNameFor(
  method: string,
  path: string,
  operationId?: string,
): string {
  if (operationId) return sanitizeOperationId(operationId);
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const param = /^\{(.+)\}$/.exec(segment);
      if (param) return `by_${param[1]}`;
      return segment.replace(/[^A-Za-z0-9]+/g, "_");
    });
  const slug = segments.join("_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return `${method.toLowerCase()}${slug ? `_${slug}` : ""}`;
}

/**
 * Build the JSON Schema for a tool's input from the operation's parameters
 * and request body. Parameters become top-level properties; request-body
 * object properties merge in (request body wins on name clash). A
 * non-object request body becomes a single `body` property.
 */
export function buildInputSchema(
  operation: OpenApiOperation,
  spec: OpenApiSpec,
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const param of operation.parameters ?? []) {
    if (!param || typeof param.name !== "string") continue;
    // Cookie parameters cannot be expressed as tool inputs; skip them.
    if (param.in === "cookie") continue;
    const schema: JsonSchema = param.schema
      ? deref(param.schema, spec)
      : { type: "string" };
    if (param.description && !schema.description) {
      schema.description = param.description;
    }
    properties[param.name] = schema;
    if (param.required) required.push(param.name);
  }

  const bodySchema = operation.requestBody?.content?.["application/json"]
    ?.schema;
  if (bodySchema) {
    const resolved = deref(bodySchema, spec);
    if (
      resolved.type === "object" &&
      resolved.properties &&
      typeof resolved.properties === "object"
    ) {
      for (const [key, value] of Object.entries(resolved.properties)) {
        properties[key] = value;
      }
      for (const key of resolved.required ?? []) {
        if (!required.includes(key)) required.push(key);
      }
    } else {
      properties["body"] = resolved;
      if (operation.requestBody?.required) required.push("body");
    }
  }

  return { type: "object", properties, required };
}

/** Generate one tool per operation in the spec. */
export function generateTools(spec: OpenApiSpec): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const [rawMethod, operation] of Object.entries(pathItem)) {
      const method = rawMethod.toLowerCase();
      if (!HTTP_METHODS.has(method)) continue;
      if (!operation || typeof operation !== "object") continue;
      if (operation["x-webmcp-disabled"] === true) continue;
      const description =
        [operation.summary, operation.description]
          .filter(Boolean)
          .join(" — ") || `${method.toUpperCase()} ${path}`;
      tools.push({
        name: toolNameFor(method, path, operation.operationId),
        description,
        inputSchema: buildInputSchema(operation, spec),
        operation: {
          method: method.toUpperCase(),
          path,
          operationId: operation.operationId,
        },
      });
    }
  }
  return tools;
}

/** Build a manifest describing the generated tool set. */
export function buildManifest(
  spec: OpenApiSpec,
  tools: ToolDefinition[],
): ToolManifest {
  return {
    name: spec.info?.title ?? "Untitled API",
    version: spec.info?.version ?? "0.0.0",
    toolCount: tools.length,
    tools,
  };
}
