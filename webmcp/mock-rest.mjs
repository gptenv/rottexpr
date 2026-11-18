// SPDX-License-Identifier: MIT
// Mock ROTT sidecar REST server for L39 verification only.
// Implements every endpoint in ../spec-draft.yaml with in-memory state
// (defaults per ~/workspace/rott/fleet/work/server/CONTRACT.md).
// NOT part of the deliverable server; the generated WebMCP server talks
// to this mock over HTTP to prove the hookup end to end.
// Extra test-only route GET /__mock/log returns the inputs the mock
// received; it is not in the spec.
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8787);

// 1x1 transparent PNG.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
);

const defaultConfig = {
  video: { resolution: '640x400', fullscreen: false, brightness: 5, gamma: 5 },
  audio: { musicVolume: 70, sfxVolume: 80, musicEnabled: true, sfxEnabled: true },
  controls: {
    forward: 'w', back: 's', strafeLeft: 'a', strafeRight: 'd',
    turnLeft: 'ArrowLeft', turnRight: 'ArrowRight', fire: 'Control', use: 'Space', run: 'Shift',
  },
  difficulty: 'normal',
  options: { crosshair: true, autoRun: false, mouseLook: true, showMessages: true, hudScale: 'normal' },
};

const state = {
  config: structuredClone(defaultConfig),
  status: 'playing',
  bridgeConnected: true,
  saveSlots: Array.from({ length: 10 }, (_, slot) => ({
    slot, label: '', levelName: null, savedAt: null, exists: false,
  })),
  inputs: [],
  mods: new Map(),
  scriptVersion: 0,
  recodeStatus: 'idle',
  matches: new Map(),
  matchSeq: 0,
  leaderboard: new Map(),
};

function observableState() {
  return {
    status: state.status,
    bridgeConnected: state.bridgeConnected,
    episode: 1,
    level: 1,
    levelName: 'Episode 1, Level 1',
    difficulty: state.config.difficulty,
    health: 100,
    armor: 0,
    ammo: { Pistol: 50 },
    weapons: ['Pistol'],
    score: 0,
    lives: 3,
    screenHash: 'mock-screen-hash',
    screenCapturedAt: new Date().toISOString(),
    hudText: '',
    saveSlots: state.saveSlots,
    updatedAt: new Date().toISOString(),
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}
function sendError(res, status, code, message) {
  sendJson(res, status, { code, message });
}
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/__mock/log') {
      return sendJson(res, 200, { inputs: state.inputs });
    }
    if (req.method === 'GET' && p === '/health') {
      return sendJson(res, 200, {
        status: 'ok', bridgeConnected: state.bridgeConnected,
        uptimeSeconds: process.uptime(), version: '1.0.0',
      });
    }
    if (req.method === 'GET' && p === '/api/v1/state') {
      if (!state.bridgeConnected) return sendError(res, 503, 'bridge_offline', 'bridge offline');
      return sendJson(res, 200, observableState());
    }
    if (req.method === 'GET' && p === '/api/v1/screen') {
      if (!state.bridgeConnected) return sendError(res, 503, 'bridge_offline', 'bridge offline');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG_1X1.length });
      return res.end(PNG_1X1);
    }
    if (req.method === 'POST' && p === '/api/v1/input/key') {
      const body = await readJson(req);
      if (!body.key || !['down', 'up', 'press'].includes(body.action)) {
        return sendError(res, 400, 'bad_request', 'KeyInput requires key and a valid action');
      }
      state.inputs.push({ kind: 'key', ...body });
      return sendJson(res, 200, { accepted: true, echoed: body });
    }
    if (req.method === 'POST' && p === '/api/v1/input/mouse') {
      const body = await readJson(req);
      if (typeof body.x !== 'number' || typeof body.y !== 'number' || !body.button || !body.action) {
        return sendError(res, 400, 'bad_request', 'MouseInput requires x, y, button, action');
      }
      state.inputs.push({ kind: 'mouse', ...body });
      return sendJson(res, 200, { accepted: true });
    }
    if (req.method === 'POST' && p === '/api/v1/input/text') {
      const body = await readJson(req);
      if (!body.text) return sendError(res, 400, 'bad_request', 'TextInput requires text');
      state.inputs.push({ kind: 'text', ...body });
      return sendJson(res, 200, { accepted: true });
    }
    if (req.method === 'POST' && p === '/api/v1/input/sequence') {
      const body = await readJson(req);
      if (!Array.isArray(body.events) || body.events.length === 0) {
        return sendError(res, 400, 'bad_request', 'InputSequence requires a non-empty events array');
      }
      state.inputs.push({ kind: 'sequence', events: body.events });
      return sendJson(res, 200, { accepted: true, executed: body.events.length });
    }
    if (req.method === 'GET' && p === '/api/v1/config') {
      return sendJson(res, 200, state.config);
    }
    if (req.method === 'PUT' && p === '/api/v1/config') {
      const body = await readJson(req);
      if (!body.video || !body.audio || !body.controls || !body.difficulty || !body.options) {
        return sendError(res, 400, 'bad_request', 'Config requires video, audio, controls, difficulty, options');
      }
      state.config = body;
      return sendJson(res, 200, state.config);
    }
    const sectionMatch = p.match(/^\/api\/v1\/config\/(video|audio|controls|difficulty|options)$/);
    if (req.method === 'GET' && sectionMatch) {
      return sendJson(res, 200, state.config[sectionMatch[1]]);
    }
    if (req.method === 'GET' && p === '/api/v1/config/unknown-section') {
      return sendError(res, 404, 'not_found', 'unknown config section');
    }
    if (req.method === 'GET' && p === '/api/v1/saves') {
      return sendJson(res, 200, state.saveSlots);
    }
    if (req.method === 'POST' && p === '/api/v1/save') {
      const body = await readJson(req);
      if (typeof body.slot !== 'number' || body.slot < 0 || body.slot > 9) {
        return sendError(res, 400, 'bad_request', 'slot must be 0-9');
      }
      const slot = { slot: body.slot, label: body.label ?? '', levelName: 'Episode 1, Level 1', savedAt: new Date().toISOString(), exists: true };
      state.saveSlots[body.slot] = slot;
      return sendJson(res, 200, slot);
    }
    if (req.method === 'POST' && p === '/api/v1/load') {
      const body = await readJson(req);
      if (typeof body.slot !== 'number' || body.slot < 0 || body.slot > 9) {
        return sendError(res, 400, 'bad_request', 'slot must be 0-9');
      }
      if (!state.saveSlots[body.slot].exists) {
        return sendError(res, 400, 'bad_request', 'save slot is empty');
      }
      return sendJson(res, 200, observableState());
    }
    if (req.method === 'POST' && p === '/api/v1/demo/play') {
      const body = await readJson(req);
      if (!['DEMO1_3', 'DEMO2_3', 'DEMO3_3', 'DEMO4_3'].includes(body.demo)) {
        return sendError(res, 400, 'bad_request', 'unknown demo');
      }
      state.status = 'demo';
      return sendJson(res, 200, observableState());
    }
    if (req.method === 'POST' && p === '/api/v1/demo/stop') {
      state.status = 'playing';
      return sendJson(res, 200, observableState());
    }
    if (req.method === 'GET' && p === '/api/v1/mods') {
      return sendJson(res, 200, [...state.mods.values()]);
    }
    if (req.method === 'POST' && p === '/api/v1/mods/load') {
      const body = await readJson(req);
      if (!body.id) return sendError(res, 400, 'bad_request', 'Mod load requires id');
      const mod = { id: body.id, name: body.name ?? body.id, loaded: true, manifest: body };
      state.mods.set(body.id, mod);
      return sendJson(res, 200, mod);
    }
    if (req.method === 'POST' && p === '/api/v1/mods/unload') {
      const body = await readJson(req);
      if (!state.mods.has(body.id)) return sendError(res, 404, 'not_found', 'no such mod is loaded');
      state.mods.delete(body.id);
      return sendJson(res, 200, { unloaded: true });
    }
    const modMatch = p.match(/^\/api\/v1\/mods\/([^/]+)$/);
    if (req.method === 'GET' && modMatch) {
      const mod = state.mods.get(decodeURIComponent(modMatch[1]));
      if (!mod) return sendError(res, 404, 'not_found', 'no such mod');
      return sendJson(res, 200, mod);
    }
    if (req.method === 'POST' && p === '/api/v1/recode/script') {
      const body = await readJson(req);
      if (!body.script && !body.code) return sendError(res, 400, 'bad_request', 'ScriptChange requires script');
      state.scriptVersion += 1;
      state.recodeStatus = 'script-applied';
      return sendJson(res, 200, { applied: true });
    }
    if (req.method === 'POST' && p === '/api/v1/recode/hot-swap') {
      state.recodeStatus = 'idle';
      return sendJson(res, 200, observableState());
    }
    if (req.method === 'GET' && p === '/api/v1/recode/status') {
      return sendJson(res, 200, { status: state.recodeStatus, scriptVersion: state.scriptVersion });
    }
    if (req.method === 'POST' && p === '/api/v1/matches') {
      const body = await readJson(req);
      if (!body.mode && !body.format) return sendError(res, 400, 'bad_request', 'MatchConfig requires mode');
      const id = `m${++state.matchSeq}`;
      const match = { id, status: 'pending', config: body, result: null };
      state.matches.set(id, match);
      return sendJson(res, 200, match);
    }
    if (req.method === 'GET' && p === '/api/v1/matches') {
      return sendJson(res, 200, [...state.matches.values()]);
    }
    const matchIdMatch = p.match(/^\/api\/v1\/matches\/([^/]+)$/);
    if (req.method === 'GET' && matchIdMatch) {
      const match = state.matches.get(decodeURIComponent(matchIdMatch[1]));
      if (!match) return sendError(res, 404, 'not_found', 'no such match');
      return sendJson(res, 200, match);
    }
    const matchStart = p.match(/^\/api\/v1\/matches\/([^/]+)\/start$/);
    if (req.method === 'POST' && matchStart) {
      const match = state.matches.get(decodeURIComponent(matchStart[1]));
      if (!match) return sendError(res, 404, 'not_found', 'no such match');
      match.status = 'running';
      return sendJson(res, 200, match);
    }
    const matchStop = p.match(/^\/api\/v1\/matches\/([^/]+)\/stop$/);
    if (req.method === 'POST' && matchStop) {
      const match = state.matches.get(decodeURIComponent(matchStop[1]));
      if (!match) return sendError(res, 404, 'not_found', 'no such match');
      match.status = 'finished';
      match.result = { winner: match.config.agents?.[0] ?? null, scores: {}, durationSeconds: 60 };
      return sendJson(res, 200, match);
    }
    if (req.method === 'GET' && p === '/api/v1/leaderboard') {
      return sendJson(res, 200, [...state.leaderboard.values()]);
    }
    return sendError(res, 404, 'not_found', `no route ${req.method} ${p}`);
  } catch (err) {
    return sendError(res, 500, 'internal', err.message);
  }
});

server.listen(PORT, () => console.log(`[mock-rest] listening on http://localhost:${PORT}`));
