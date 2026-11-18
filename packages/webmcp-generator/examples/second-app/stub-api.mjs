// SPDX-License-Identifier: MIT
/**
 * Stub REST implementation of the TaskBoard API (examples/second-app).
 * In-memory only; exists so the generated WebMCP server has a real
 * backend to call during verification. Not part of the generator.
 *
 *   node stub-api.mjs [port]   (default port 3101)
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? process.env.TASKBOARD_PORT ?? 3101);

const tasks = [
  { id: 1, title: "Buy milk", done: false },
  { id: 2, title: "Read the spec", done: true },
];
let nextId = 3;

function send(res, status, payload) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/tasks") {
      const done = url.searchParams.get("done");
      const out =
        done === null
          ? tasks
          : tasks.filter((t) => String(t.done) === done);
      send(res, 200, out);
      return;
    }
    const idMatch = /^\/tasks\/(\d+)$/.exec(url.pathname);
    if (idMatch) {
      const id = Number(idMatch[1]);
      const task = tasks.find((t) => t.id === id);
      if (req.method === "GET") {
        if (!task) return send(res, 404, { error: "not found" });
        return send(res, 200, task);
      }
      if (req.method === "PATCH") {
        if (!task) return send(res, 404, { error: "not found" });
        const body = await readBody(req);
        if (typeof body.done === "boolean") task.done = body.done;
        return send(res, 200, task);
      }
      if (req.method === "DELETE") {
        const index = tasks.findIndex((t) => t.id === id);
        if (index === -1) return send(res, 404, { error: "not found" });
        tasks.splice(index, 1);
        return send(res, 204);
      }
    }
    if (req.method === "POST" && url.pathname === "/tasks") {
      const body = await readBody(req);
      if (typeof body.title !== "string" || !body.title) {
        return send(res, 400, { error: "title is required" });
      }
      const created = { id: nextId++, title: body.title, done: false };
      if (typeof body.due === "string") created.due = body.due;
      tasks.push(created);
      return send(res, 201, created);
    }
    send(res, 404, { error: "no such route" });
  } catch {
    send(res, 400, { error: "invalid JSON body" });
  }
});

server.listen(port, () => {
  console.log(`taskboard stub API listening on http://localhost:${port}`);
});
