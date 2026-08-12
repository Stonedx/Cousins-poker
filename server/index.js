// Zero-dependency server: plain Node `http` + a small JSON API the frontend polls.
// No express, no socket.io, no npm install required — just `node server/index.js`.
// (Turn-based poker doesn't need a persistent socket: a ~1s poll from each client
// feels instant and is far more portable across hosts.)

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const { Table, DEFAULT_BLIND_SCHEDULE } = require('./game');
const { randomTableCode } = require('./ids');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** @type {Map<string, Table>} */
const tables = new Map();

function createTable(options) {
  let code;
  do {
    code = randomTableCode();
  } while (tables.has(code));
  const table = new Table(code, null, options);
  tables.set(code, table);
  return table;
}

// Periodic maintenance: advance blind levels, auto-act on timed-out players, and mark
// players as disconnected if they've stopped polling. Also garbage-collect dead tables.
setInterval(() => {
  const now = Date.now();
  for (const [code, table] of tables) {
    if (table.status === 'active') {
      table.maybeAdvanceBlindLevel();
      table.checkActionTimeout();
      table.sweepStalePlayers();
    }
    // Clean up tables nobody has touched in 12 hours (lobby never started, or long-finished).
    const lastActivity = Math.max(0, ...[...table.players.values()].map((p) => p.lastSeenAt));
    if (now - lastActivity > 12 * 60 * 60 * 1000) {
      tables.delete(code);
    }
  }
}, 1000);

// ---------- Tiny static file server ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(PUBLIC_DIR, filePath);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- JSON API ----------

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1e6) {
        reject(new Error('Payload too large.'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function requirePlayer(table, token) {
  const player = table.playerByToken(token);
  if (!player) throw new Error('Not recognized at this table — try rejoining.');
  table.touchPlayer(player);
  return player;
}

const routes = {
  'POST /api/createTable': async (body) => {
    const hostName = String(body.hostName || 'Host').trim();
    const options = {
      startingStack: clampInt(body.startingStack, 500, 1000000, 10000),
      levelDurationMs: clampInt(body.levelMinutes, 1, 120, 15) * 60 * 1000,
      blindSchedule: DEFAULT_BLIND_SCHEDULE,
      tournamentName: String(body.tournamentName || "Cousins' Poker Night").slice(0, 40),
    };
    const table = createTable(options);
    const { player, token } = table.addPlayer(hostName);
    table.hostPlayerId = player.id;
    return { ok: true, tableId: table.id, token, playerId: player.id };
  },

  'POST /api/joinTable': async (body) => {
    const tableId = String(body.tableId || '').trim().toUpperCase();
    const table = tables.get(tableId);
    if (!table) throw new Error('No table found with that code.');
    const name = String(body.name || 'Player').trim();
    const { player, token } = table.addPlayer(name);
    return { ok: true, tableId: table.id, token, playerId: player.id };
  },

  'POST /api/rejoin': async (body) => {
    const tableId = String(body.tableId || '').trim().toUpperCase();
    const table = tables.get(tableId);
    if (!table) throw new Error('That table no longer exists.');
    const player = requirePlayer(table, body.token);
    return { ok: true, tableId: table.id, playerId: player.id };
  },

  'POST /api/startTournament': async (body) => {
    const table = getTable(body.tableId);
    const player = requirePlayer(table, body.token);
    table.startTournament(player.id);
    return { ok: true };
  },

  'POST /api/action': async (body) => {
    const table = getTable(body.tableId);
    const player = requirePlayer(table, body.token);
    table.handleAction(player.id, body.type, body.amount);
    return { ok: true };
  },

  'POST /api/chat': async (body) => {
    const table = getTable(body.tableId);
    const player = requirePlayer(table, body.token);
    const text = String(body.message || '').slice(0, 200).trim();
    if (text) {
      table.addLog(`💬 ${player.name}: ${text}`);
      table.notify();
    }
    return { ok: true };
  },

  'GET /api/state': async (_body, query) => {
    const table = getTable(query.tableId);
    const player = requirePlayer(table, query.token);
    return { ok: true, state: table.getStateFor(player.id) };
  },
};

function getTable(tableId) {
  const table = tables.get(String(tableId || '').trim().toUpperCase());
  if (!table) throw new Error('Table not found.');
  return table;
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const routeKey = `${req.method} ${parsed.pathname}`;

  if (routes[routeKey]) {
    try {
      const body = req.method === 'POST' ? await readJSONBody(req) : {};
      const result = await routes[routeKey](body, parsed.query);
      sendJSON(res, 200, result);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: err.message || 'Something went wrong.' });
    }
    return;
  }

  if (req.method === 'GET' && parsed.pathname.startsWith('/api/')) {
    sendJSON(res, 404, { ok: false, error: 'Unknown endpoint.' });
    return;
  }

  serveStatic(req, res, parsed.pathname);
});

server.listen(PORT, () => {
  console.log(`Cousins' Poker running on http://localhost:${PORT}`);
});

module.exports = { server, tables };
