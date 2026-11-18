// SPDX-License-Identifier: MIT
/**
 * End-to-end verification for the second-app proof.
 *
 * Spawns the TaskBoard stub REST API and the generated WebMCP server
 * (once from the JSON spec, once from the YAML spec), then, as an agent
 * would: lists the tools, creates a task, lists tasks, marks it done,
 * reads it back, and checks a 404 maps to ok:false. Exits 0 only if
 * every check passes; prints PASS/FAIL per check.
 *
 *   node verify.mjs
 */
import { spawn } from "node:child_process";
import { once } from "node:events";

const here = new URL(".", import.meta.url).pathname;

function start(script, args) {
  const child = spawn(process.execPath, [here + script, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) =>
    console.log(`[${script}] ${d.toString().trim()}`),
  );
  child.stderr.on("data", (d) =>
    console.log(`[${script} stderr] ${d.toString().trim()}`),
  );
  child.on("error", (e) => console.log(`[${script} spawn error] ${e.message}`));
  return child;
}

function waitExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return once(child, "exit").catch(() => {});
}

async function waitForPort(port, label, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/tools`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${label} did not come up on port ${port}`);
}

async function waitForStub(port, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/tasks`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`stub API did not come up on port ${port}`);
}

let failures = 0;
function check(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures++;
}

async function callTool(port, name, args) {
  const res = await fetch(`http://localhost:${port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const json = await res.json();
  return json.result ?? json;
}

const stub = start("stub-api.mjs", ["3101"]);
const webmcpJson = start("run-generated-server.mjs", [
  "taskboard-openapi.json",
  "http://localhost:3101",
  "3201",
]);
const webmcpYaml = start("run-generated-server.mjs", [
  "taskboard-openapi.yaml",
  "http://localhost:3101",
  "3202",
]);

try {
  await waitForStub(3101);
  await waitForPort(3201, "webmcp (json spec)");
  await waitForPort(3202, "webmcp (yaml spec)");

  for (const [label, port] of [
    ["json spec", 3201],
    ["yaml spec", 3202],
  ]) {
    const listRes = await fetch(`http://localhost:${port}/tools`);
    const listJson = await listRes.json();
    const names = listJson.tools.map((t) => t.name).sort();
    check(
      `[${label}] tools/list returns the generated tools`,
      JSON.stringify(names) ===
        JSON.stringify(["completeTask", "createTask", "getTask", "listTasks"]),
      names.join(", "),
    );
    check(
      `[${label}] deleteTask is excluded (x-webmcp-disabled)`,
      !names.includes("deleteTask"),
    );
    const listSchema = listJson.tools.find((t) => t.name === "listTasks");
    check(
      `[${label}] listTasks input schema has the done query param`,
      listSchema?.inputSchema?.properties?.done?.type === "boolean",
    );
    const createSchema = listJson.tools.find(
      (t) => t.name === "createTask",
    );
    check(
      `[${label}] createTask input schema resolves the $ref (title required)`,
      createSchema?.inputSchema?.properties?.title?.type === "string" &&
        createSchema.inputSchema.required?.includes("title"),
    );
  }

  // Drive the app through the tools, JSON-spec server.
  const created = await callTool(3201, "createTask", { title: "Verify me" });
  check(
    "tools/call createTask succeeds",
    created.ok === true && created.data?.title === "Verify me",
    JSON.stringify(created.data),
  );
  const listed = await callTool(3201, "listTasks", {});
  check(
    "tools/call listTasks sees the new task",
    listed.ok === true &&
      Array.isArray(listed.data) &&
      listed.data.some((t) => t.title === "Verify me"),
    `${listed.data?.length} tasks`,
  );
  const done = await callTool(3201, "completeTask", {
    id: created.data.id,
    done: true,
  });
  check(
    "tools/call completeTask marks the task done",
    done.ok === true && done.data?.done === true,
  );
  const one = await callTool(3201, "getTask", { id: created.data.id });
  check(
    "tools/call getTask reads the completed task back",
    one.ok === true && one.data?.done === true,
  );
  const missing = await callTool(3201, "getTask", { id: 99999 });
  check(
    "tools/call getTask on a missing id returns ok:false, status 404",
    missing.ok === false && missing.status === 404,
    `status ${missing.status}`,
  );
} finally {
  stub.kill();
  webmcpJson.kill();
  webmcpYaml.kill();
  await Promise.allSettled([
    waitExit(stub),
    waitExit(webmcpJson),
    waitExit(webmcpYaml),
  ]);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
