// Ronda's second room server, for the game host on Kinetic (GeneralGames, next to Chess Tactics and Juntos).
//
// Kleider, 2026-11-18: "I don't want the app relaying forever onto the same service, all parts of the app should work
// even if one the pieces break down". The live rooms (worker/src/index.js) run on Cloudflare as Durable Objects;
// this runs the very same Room class on Node, with a small stand-in for the Durable Object parts it uses (its
// websockets with their attachments, its storage, its alarm). Same code, same messages: the app uses one server or
// the other and nothing else changes. Codes made here have an odd digit sum (SIDE=odd), Cloudflare's an even one.
//
// Game host contract (ChessTactics/docs/HOSTING.md "Adding a future game"): listen on PORT; keep files in
// DATA_DIR; stop on "stop" read from the input; GET /api/health as JSON. The host strips the public path
// (/ronda), so this sees /api/new and /ws/<code>, and passes the visitor's address in x-forwarded-for.
import http from "node:http";
import { webcrypto, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (typeof Response.json !== "function")
  Response.json = (d, init = {}) => new Response(JSON.stringify(d), { ...init, headers: { ...(init.headers || {}), "content-type": "application/json" } });

const { Room, newRoom, ipKey, idleClose } = await import(process.env.RONDA_ROOM || "./room.mjs");

const PORT = Number(process.env.PORT) || 8789;
const BIND = process.env.BIND || "0.0.0.0";
const DATA = process.env.DATA_DIR || join(process.cwd(), "data");
const MAX_ROOMS = 2000; // rooms held in memory at once (a room with nobody in it is put away after IDLE_MS)
const IDLE_MS = 10 * 60 * 1000;
const MAX_SOCKETS = 3000;
const MAX_MSG = 256 * 1024 + 1024; // a whole quiz arrives in one message
const NEW_PER_MINUTE = 30; // rooms one address may start in a minute
mkdirSync(DATA, { recursive: true });
// how busy this server is goes only to whoever has the ops key (data/ops-key; the deploy's "is anyone online?"),
// everyone else hears "ok" (audit R17)
let opsKey = process.env.OPS_KEY || "";
if (!opsKey) try { opsKey = readFileSync(join(DATA, "ops-key"), "utf8").trim(); } catch (_) {}
const isOps = (req) => {
  const k = String(req.headers["x-ops-key"] || "");
  if (!opsKey || k.length !== opsKey.length) return false;
  let d = 0;
  for (let i = 0; i < k.length; i++) d |= k.charCodeAt(i) ^ opsKey.charCodeAt(i);
  return d === 0;
};


// What the sweep needs to know of each room file on disk: read once at start, then kept up to date on every write,
// so the sweep never re-reads the folder (APP-RULES safety 14: work proportional to what changed).
const MAX_FILES = 50000; // the data folder shares a disk with the other games: no new rooms past this
const disk = new Map(); // file -> { name, alarm, ... }
const summary = (m) => ({ name: m.__name || "", alarm: Number(m.__alarm) || 0, g: !!m.g });
for (const f of readdirSync(DATA)) {
  if (!f.endsWith(".json")) continue;
  try { disk.set(join(DATA, f), summary(JSON.parse(readFileSync(join(DATA, f), "utf8")))); } catch (_) {}
}

// ---- the Durable Object stand-in ----

const fileOf = (name) => join(DATA, createHash("sha256").update(name).digest("hex").slice(0, 32) + ".json");
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

class Storage {
  constructor(name) {
    this.name = name;
    this.file = fileOf(name);
    try {
      this.map = new Map(Object.entries(JSON.parse(readFileSync(this.file, "utf8"))));
      this.map.delete("__name");
    } catch (_) {
      this.map = new Map();
    }
  }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }
  flush() {
    clearTimeout(this.timer);
    try {
      if (!this.map.size) {
        disk.delete(this.file);
        return void unlinkSync(this.file);
      }
      const all = { __name: this.name, ...Object.fromEntries(this.map) };
      writeFileSync(this.file + ".tmp", JSON.stringify(all));
      renameSync(this.file + ".tmp", this.file);
      disk.set(this.file, summary(all));
    } catch (_) {}
  }
  async get(k) {
    if (Array.isArray(k)) return new Map(k.filter((x) => this.map.has(x)).map((x) => [x, clone(this.map.get(x))]));
    return clone(this.map.get(k));
  }
  async put(k, v) {
    if (typeof k === "object") for (const [a, b] of Object.entries(k)) this.map.set(a, clone(b));
    else this.map.set(k, clone(v));
    this.save();
  }
  async delete(k) {
    const ks = Array.isArray(k) ? k : [k];
    let n = 0;
    for (const x of ks) n += this.map.delete(x) ? 1 : 0;
    this.save();
    return Array.isArray(k) ? n : n > 0;
  }
  async deleteAll() {
    this.map.clear();
    this.save();
  }
  async setAlarm(t) {
    this.map.set("__alarm", Number(t));
    this.save();
  }
  async getAlarm() {
    return this.map.get("__alarm") ?? null;
  }
}

class State {
  constructor(name) {
    this.storage = new Storage(name);
    this.sockets = new Set();
  }
  acceptWebSocket(ws, tags) {
    ws.tags = tags || [];
    this.sockets.add(ws);
  }
  getTags(ws) {
    return ws.tags || [];
  }
  getWebSockets() {
    return [...this.sockets];
  }
}

const rooms = new Map(); // name -> { room, state, idle }

function roomOf(name) {
  let r = rooms.get(name);
  if (!r) {
    if (rooms.size >= MAX_ROOMS) sweep(true);
    const state = new State(name);
    r = { name, state, room: new Room(state, ENV), idle: Date.now() };
    rooms.set(name, r);
  }
  return r;
}
// one room's work is done one piece at a time, in order (a Durable Object does the same)
const run = (r, f) => (r.chain = (r.chain || Promise.resolve()).then(f).catch((e) => console.error("ronda room error:", e && e.message)));

// what newRoom() expects of Cloudflare's Durable Object namespace
// the key both servers sign hosts' tokens with (worker/src/index.js proven()); never printed
let resumeKey = process.env.RESUME_KEY || "";
if (!resumeKey) try { resumeKey = readFileSync(join(DATA, "resume-key"), "utf8").trim(); } catch (_) {}
if (!resumeKey) console.log("no resume key: games can't move here from the other server");
// the game host's copy of Cloudflare's JOINS limit (100 per address per minute); JOIN_LIMIT only for tests
const joins = new Map();
const JOIN_LIMIT = Number(process.env.JOIN_LIMIT) || 100;
setInterval(() => joins.clear(), 60000).unref();
const ENV = {
  RESUME_KEY: resumeKey,
  JOINS: { limit: async ({ key }) => { const n = (joins.get(key) || 0) + 1; joins.set(key, n); return { success: n <= JOIN_LIMIT }; } },
  SIDE: process.env.SIDE || "odd", // "even" makes it stand in for the Cloudflare side (tests)
  ROOMS: {
    idFromName: (name) => name,
    get: (name) => ({
      fetch: (url, init) => {
        const r = roomOf(name);
        return run(r, () => r.room.fetch(new Request(url, init)));
      },
    }),
  },
};

// due alarms run; rooms nobody is in are put away (their storage stays on disk, their alarm still runs)
async function sweep(force) {
  const now = Date.now();
  for (const [name, r] of rooms) {
    const due = r.state.storage.map.get("__alarm");
    if (due && due <= now) {
      r.state.storage.map.delete("__alarm");
      await run(r, () => r.room.alarm());
    }
    if (!r.state.sockets.size && (force || now - r.idle > IDLE_MS)) {
      r.state.storage.flush();
      rooms.delete(name);
    }
  }
  if (force) return;
  for (const [file, s] of [...disk]) {
    if (!s.name || rooms.has(s.name)) continue;
    try {
      if (s.alarm && s.alarm <= now) {
        const r = roomOf(s.name);
        r.state.storage.map.delete("__alarm");
        await run(r, () => r.room.alarm());
      } else if (!s.alarm && !s.g) {
        disk.delete(file);
        unlinkSync(file);
      }
    } catch (_) {}
  }
}
setInterval(sweep, 15 * 1000).unref();

const started = Date.now();
let sockets = 0;
const starts = new Map(); // address -> rooms started this minute
setInterval(() => starts.clear(), 60 * 1000).unref();

// ---- http and websockets ----

const server = http.createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0];
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST", "Cache-Control": "no-store" };
  if (path === "/api/health" || path === "/health") {
    res.writeHead(200, { "content-type": "application/json", ...cors });
    if (!isOps(req)) return res.end(JSON.stringify({ ok: true }));
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, people: sockets, upMinutes: Math.round((Date.now() - started) / 60000) }));
  }
  if (path === "/api/new" && req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }
  if (path === "/api/new" && req.method === "POST") {
    if (disk.size >= MAX_FILES) {
      res.writeHead(503, { "content-type": "application/json", ...cors });
      return res.end(JSON.stringify({ error: "busy" }));
    }
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
    const n = (starts.get(ip) || 0) + 1;
    starts.set(ip, n);
    if (n > NEW_PER_MINUTE) {
      res.writeHead(429, cors);
      return res.end();
    }
    const r = await newRoom(ENV);
    res.writeHead(r.status, { "content-type": "application/json", ...cors });
    return res.end(await r.text());
  }
  const m = path.match(/^\/ws\/(\d{6})$/);
  res.writeHead(m ? 426 : 404, { "content-type": "text/plain", ...cors });
  res.end(m ? "expected a websocket" : "not found");
});

const MAX_PER_ROOM = 550; // the same as the Worker's MAX_SOCKETS
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG });
server.on("upgrade", (req, socket, head) => {
  const m = (req.url || "").split("?")[0].match(/^\/ws\/(\d{6})$/);
  if (!m || sockets >= MAX_SOCKETS) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    const r = roomOf(m[1]);
    if (r.state.sockets.size >= MAX_PER_ROOM) return ws.close(1013, "full");
    sockets++;
    let att = null;
    ws.serializeAttachment = (v) => (att = clone(v));
    ws.deserializeAttachment = () => clone(att);
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
    r.state.acceptWebSocket(ws, [m[1], "ip:none"]);
    idleClose(ws);
    ipKey(ip).then((k) => (ws.tags[1] = k));
    ws.on("message", (data, binary) => {
      if (binary) return;
      run(r, () => r.room.webSocketMessage(ws, data.toString()));
    });
    ws.on("close", () => {
      sockets--;
      run(r, async () => {
        r.state.sockets.delete(ws);
        await r.room.webSocketClose(ws);
        r.idle = Date.now();
      });
    });
    ws.on("error", () => {});
  });
});

server.listen(PORT, BIND, () => console.log(`Ronda room server on ${BIND}:${PORT}`));

process.stdin.on("data", (d) => {
  const cmd = String(d).trim();
  if (cmd === "stop") {
    console.log("stopping");
    for (const r of rooms.values()) r.state.storage.flush();
    setTimeout(() => process.exit(0), 300);
  } else if (cmd === "status") console.log(`rooms ${rooms.size}, people ${sockets}, up ${Math.round((Date.now() - started) / 60000)} min`);
});
process.stdin.resume();
