// SPDX-License-Identifier: MIT
// L39 verification: boots the mock REST server (port 8787) and the
// generated ROTT WebMCP server (port 3000), then exercises every tool
// through GET /webmcp/tools and POST /webmcp/call. Exits non-zero on
// any failure. Run: node verify.mjs
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const MOCK_PORT = 8787;
const WEBMCP_PORT = 3000;
const BASE = `http://localhost:${WEBMCP_PORT}`;

const FULL_CONFIG = {
  video: { resolution: '640x400', fullscreen: false, brightness: 5, gamma: 5 },
  audio: { musicVolume: 70, sfxVolume: 80, musicEnabled: true, sfxEnabled: true },
  controls: {
    forward: 'w', back: 's', strafeLeft: 'a', strafeRight: 'd',
    turnLeft: 'ArrowLeft', turnRight: 'ArrowRight', fire: 'Control', use: 'Space', run: 'Shift',
  },
  difficulty: 'normal',
  options: { crosshair: true, autoRun: false, mouseLook: true, showMessages: true, hudScale: 'normal' },
};

// [tool, input, check(result)]
const CALLS = [
  ['getHealth', {}, (r) => r.status === 'ok' && r.bridgeConnected === true && typeof r.uptimeSeconds === 'number'],
  ['getState', {}, (r) => r.status === 'playing' && r.episode === 1 && Array.isArray(r.saveSlots) && r.saveSlots.length === 10],
  ['getScreen', {}, (r) => typeof r === 'string' && r.length > 0],
  ['postInputKey', { key: 'w', action: 'press', holdMs: 50 }, (r) => r.accepted === true && r.echoed.key === 'w'],
  ['postInputMouse', { x: 320, y: 200, button: 'left', action: 'click' }, (r) => r.accepted === true],
  ['postInputText', { text: 'hello' }, (r) => r.accepted === true],
  ['postInputSequence', { events: [{ key: { key: 'w', action: 'press' }, delayMs: 0 }, { mouse: { x: 10, y: 10, button: 'left', action: 'move' }, delayMs: 0 }] }, (r) => r.accepted === true && r.executed === 2],
  ['getConfig', {}, (r) => r.difficulty === 'normal' && r.video.resolution === '640x400'],
  ['updateConfig', { ...FULL_CONFIG, difficulty: 'hard' }, (r) => r.difficulty === 'hard'],
  ['getConfigSection', { section: 'audio' }, (r) => r.musicVolume === 70 && r.sfxEnabled === true],
  ['listSaves', {}, (r) => Array.isArray(r) && r.length === 10 && r[0].slot === 0],
  ['saveGame', { slot: 3, label: 'verify-save' }, (r) => r.slot === 3 && r.exists === true && r.label === 'verify-save'],
  ['loadGame', { slot: 3 }, (r) => r.status === 'playing' && r.saveSlots[3].exists === true],
  ['playDemo', { demo: 'DEMO1_3', loop: false }, (r) => r.status === 'demo'],
  ['stopDemo', {}, (r) => r.status === 'playing'],
  ['listMods', {}, (r) => Array.isArray(r) && r.length === 0],
  ['loadMod', { id: 'mod-a' }, (r) => r.id === 'mod-a' && r.loaded === true],
  ['getMod', { id: 'mod-a' }, (r) => r.id === 'mod-a'],
  ['unloadMod', { id: 'mod-a' }, (r) => r.unloaded === true],
  ['applyRecodeScript', { id: 'verify', action: 'apply', target: 'script-layer', script: '1 + 1' }, (r) => r.applied === true],
  ['getRecodeStatus', {}, (r) => r.status === 'script-applied' && r.scriptVersion === 1],
  ['hotSwapRecodeModule', { moduleUrl: 'http://localhost:1/rott.wasm', saveSlot: 9 }, (r) => r.status === 'playing'],
  ['createMatch', { mode: 'commbat', agents: ['agent-a', 'agent-b'], timeLimitSeconds: 300 }, (r) => r.status === 'pending' && typeof r.id === 'string'],
  ['listMatches', {}, (r) => Array.isArray(r) && r.length === 1],
  ['getMatch', { id: 'm1' }, (r) => r.id === 'm1'],
  ['startMatch', { id: 'm1' }, (r) => r.status === 'running'],
  ['stopMatch', { id: 'm1' }, (r) => r.status === 'finished' && r.result.winner === 'agent-a'],
  ['getLeaderboard', {}, (r) => Array.isArray(r)],
];

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; console.log(`FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

async function waitFor(url, label, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

async function main() {
  const mock = spawn('node', ['mock-rest.mjs'], { cwd: new URL('.', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });
  const webmcp = spawn('node', ['rott-server.mjs'], {
    cwd: new URL('.', import.meta.url).pathname,
    env: { ...process.env, PORT: String(WEBMCP_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  mock.stdout.on('data', (d) => process.stdout.write(`[mock] ${d}`));
  webmcp.stdout.on('data', (d) => process.stdout.write(`[webmcp] ${d}`));
  mock.stderr.on('data', (d) => process.stdout.write(`[mock:err] ${d}`));
  webmcp.stderr.on('data', (d) => process.stdout.write(`[webmcp:err] ${d}`));
  try {
    await waitFor(`http://localhost:${MOCK_PORT}/health`, 'mock REST');
    await waitFor(`${BASE}/`, 'generated WebMCP server');

    const root = await (await fetch(`${BASE}/`)).json();
    check('GET / lists 28 tools', root.webmcp.toolCount === 28 && root.tools.length === 28, JSON.stringify(root.webmcp));

    const toolsRes = await fetch(`${BASE}/webmcp/tools`);
    const { tools } = await toolsRes.json();
    check('GET /webmcp/tools returns 28 tools', Array.isArray(tools) && tools.length === 28, `got ${tools?.length}`);
    const names = tools.map((t) => t.name);
    check('tool names match spec operationIds', CALLS.every(([n]) => names.includes(n)) && names.length === 28);
    check('every tool has description + inputSchema', tools.every((t) => typeof t.description === 'string' && t.description.length > 0 && t.inputSchema?.type === 'object'));
    check('getConfigSection inputSchema requires section', tools.find((t) => t.name === 'getConfigSection')?.inputSchema?.required?.includes('section') === true);
    check('postInputKey inputSchema requires key+action', (() => {
      const s = tools.find((t) => t.name === 'postInputKey')?.inputSchema;
      return s?.required?.includes('key') && s?.required?.includes('action');
    })());

    const clientJs = await (await fetch(`${BASE}/webmcp/client.js`)).text();
    check('GET /webmcp/client.js registers tools via modelContext', clientJs.includes('registerTool') && clientJs.includes('postInputKey'));

    for (const [tool, input, assertFn] of CALLS) {
      const res = await fetch(`${BASE}/webmcp/call`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, input }),
      });
      const body = await res.json();
      if (!res.ok) { check(`call ${tool}`, false, `HTTP ${res.status}: ${JSON.stringify(body)}`); continue; }
      let ok = false;
      try { ok = assertFn(body.result); } catch (e) { ok = false; }
      check(`call ${tool}`, ok, `result=${JSON.stringify(body.result)?.slice(0, 200)}`);
    }

    // Mock recorded the player-layer inputs (proves calls reached the REST layer).
    const log = await (await fetch(`http://localhost:${MOCK_PORT}/__mock/log`)).json();
    const kinds = log.inputs.map((i) => i.kind);
    check('mock recorded key+mouse+text+sequence inputs', ['key', 'mouse', 'text', 'sequence'].every((k) => kinds.includes(k)), JSON.stringify(kinds));

    // Negative cases: unknown tool, missing required input, REST 404.
    const badTool = await fetch(`${BASE}/webmcp/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'noSuchTool', input: {} }) });
    check('unknown tool -> HTTP 500', badTool.status === 500);
    const missing = await fetch(`${BASE}/webmcp/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'postInputKey', input: { action: 'press' } }) });
    check('postInputKey missing key -> HTTP 500 (generator required check)', missing.status === 500);
    const notFound = await fetch(`${BASE}/webmcp/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'getMod', input: { id: 'nope' } }) });
    check('getMod unknown id -> HTTP 500 (REST 404 propagates)', notFound.status === 500);

    console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    mock.kill();
    webmcp.kill();
  }
}

main().catch((err) => { console.error('VERIFY ERROR:', err); process.exit(1); });
