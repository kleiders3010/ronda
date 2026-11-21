// Ronda: the web app (static files) and its live rooms, one Worker.
// One Durable Object per room code runs one live game: the host's quiz, who joined, their answers and points.
// Nothing is kept after the room closes (6 hours after the last activity at most).
//
// The same code runs on two servers (Kleider, 2026-11-18: "all parts of the app should work even if one the pieces
// break down"): here on Cloudflare, and on Node on our game host (kinetic/server.mjs, games.jurisgames.com/ronda).
// A room code says where it was made: the digits add up to an even number here, odd there (SIDE), so the two never
// hand out the same code. If its server stops answering, the host's screen moves the game to the other one
// ("resume", from the copy it keeps) and players follow.

const MAX_PLAYERS = 500;
// limits (APP-RULES safety 5), far above what a real game does: a phone sends a message when someone presses
const BUDGET_MS = 10000;
const BUDGET = { player: 40, host: 300, none: 10 }; // messages per socket per 10 s, then it is closed
const MAX_SOCKETS = MAX_PLAYERS + 50; // per room
const JOIN_MS = 10000; // a socket that has not joined or hosted by then is closed
// New joins and failed lookups per address per minute (wrangler.toml JOINS; APP-RULES safety 5): codes can't be
// tried by the thousand. Rejoins and hosts with their token don't count.
export async function lookupOk(env, ws) {
  if (!env || !env.JOINS) return true;
  try { return (await env.JOINS.limit({ key: ws.__ip || "" })).success; } catch (_) { return true; }
}
const MAX_MSG = 256 * 1024; // a whole quiz arrives in one message
const ROOM_TTL = 6 * 3600 * 1000;
const KINDS = ["quiz", "poll", "words", "scale", "type", "order", "slider"];
const MAX_ANSWERS = 6;
// audience questions (like Slido's Q&A): people ask the host, everyone upvotes
const MAX_QA = 100;
const QA_PER_PLAYER = 10;
const QA_LEN = 160;
const QA_ST = ["", "wait", "hi", "done"]; // shown, waiting for the host's OK, on the big screen, answered

// teams (like Kahoot's team mode on personal devices): everyone plays on their own phone for a team; a team's points
// for a question are the average of what its members got (Kahoot: "an average of team player scores")
const MAX_TEAMS = 10; // pinned: Kahoot's larger plans allow 10 teams
const TALK_MS = 5000; // pinned: Kahoot's team talk, "5 seconds to discuss the question and answers"
const READ_MS = 1500;
export const TEAM_RULES = { MAX_TEAMS, TALK_MS, READ_MS };
export function cleanTeams(t) {
  if (!t || typeof t !== "object" || !Array.isArray(t.names)) return null;
  const names = t.names.slice(0, MAX_TEAMS).map((n, i) => str(n, 20) || `Team ${i + 1}`);
  if (names.length < 2) return null;
  const score = names.map((_, i) => Math.max(0, Math.min(1e7, Math.trunc(Number(t.score?.[i])) || 0)));
  return { names, talk: t.talk !== false, score };
}
// the team with the fewest people (the first of those): where a newcomer goes
export function smallestTeam(players, n) {
  const size = Array(n).fill(0);
  for (const p of Object.values(players)) if (!p.out && p.team >= 0 && p.team < n) size[p.team]++;
  return size.indexOf(Math.min(...size));
}

// assignments (like Kahoot's "Assign", help 'How to assign a kahoot'): no big screen; everyone plays the whole quiz
// on their own phone, at their own pace, until a deadline. The results stay for the host a while after it.
const MAX_DAYS = 28; // pinned: Kahoot, "a deadline up to 28 days ahead"
const KEEP_MS = 30 * 86400000; // pinned: privacy page, results deleted 30 days after the deadline
export const SELF_RULES = { MAX_DAYS, KEEP_MS, READ_MS };
// when a room is deleted: a live game 6 hours after the last activity, an assignment 30 days after its deadline
export const expiry = (g) => (g.self ? g.self.until + KEEP_MS : g.touched + ROOM_TTL);
// an answer as it arrives, checked against the question (prev: what this person already sent for it)
function parseAnswer(q, raw, prev) {
  if (q.kind === "scale") {
    const v = Number(raw);
    return Number.isInteger(v) && v >= 1 && v <= 5 ? v : undefined;
  }
  if (q.kind === "words") {
    const w = str(raw, 40).toLowerCase();
    const have = prev?.v || [];
    if (!w || have.length >= 3 || have.includes(w)) return undefined;
    return [...have, w];
  }
  if (prev) return undefined; // one answer, no changes (speed counts)
  if (q.kind === "quiz" || q.kind === "poll") {
    const v = Number(raw);
    return Number.isInteger(v) && v >= 0 && v < q.answers.length ? v : undefined;
  }
  if (q.kind === "type") return str(raw, 60) || undefined;
  if (q.kind === "slider") {
    const v = typeof raw === "number" ? raw : NaN;
    if (!Number.isFinite(v) || v < q.min || v > q.max) return undefined;
    return Math.round(v * 10 ** q.dec) / 10 ** q.dec;
  }
  if (q.kind === "order") {
    const v = Array.isArray(raw) ? raw.map(Number) : null;
    return isPerm(v, q.answers.length) ? v : undefined;
  }
  return undefined;
}

// the questions the host's copy carries over to the other server (bounded, only people of this game)
export function cleanQa(x, players) {
  const qa = { open: x?.open !== false, mod: !!x?.mod, list: [] }; // pinned: open by default, no review step
  const seen = new Set();
  let hi = false;
  for (const it of (Array.isArray(x?.list) ? x.list : []).slice(0, MAX_QA)) {
    const id = String(it?.id || "");
    const text = str(it?.text, QA_LEN);
    if (!/^[a-z0-9]{6,12}$/.test(id) || seen.has(id) || !text) continue;
    seen.add(id);
    let st = QA_ST.includes(it.st) ? it.st : "";
    if (st === "hi") (hi ? (st = "") : (hi = true));
    const up = [...new Set((Array.isArray(it.up) ? it.up : []).map(String))].filter((p) => players[p]);
    qa.list.push({ id, by: players[it.by] ? String(it.by) : "", name: str(it.name, 30), text,
      at: Math.trunc(Number(it.at)) || Date.now(), up, st });
  }
  return qa;
}
// kinds with a right answer: points, ranking, podium
export const scored = (kind) => kind === "quiz" || kind === "type" || kind === "order" || kind === "slider";
// Kahoot's Slider (help 'Kahoot! question types'): a number between min and max; answers within the margin count
// (none: only the right number ... maximum: every answer), and the closer, the more points (80% precision, 20% speed).
// The margin is a part of the range: none, low, medium, high, maximum.
export const MARGINS = [0, 0.05, 0.1, 0.2, 1];
export const sliderTol = (q) => MARGINS[q.margin ?? 2] * (q.max - q.min);
const near = (q, v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v - q.ans) <= sliderTol(q) + 1e-9 * (1 + Math.abs(q.ans));
// a typed answer counts when it matches one of the accepted ones, ignoring case, accents, spaces and punctuation
export const norm = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export function isRight(q, v) {
  if (q.kind === "quiz") return q.correct.includes(v);
  if (q.kind === "type") return typeof v === "string" && !!norm(v) && q.accept.some((a) => norm(a) === norm(v));
  if (q.kind === "order") return Array.isArray(v) && v.length === q.answers.length && v.every((x, i) => x === i);
  if (q.kind === "slider") return near(q, v);
  return false;
}
// "Put in order": everyone sees the same mix, never already in order
export function shuffle(n) {
  const a = [...Array(n).keys()];
  if (n < 2) return a;
  do {
    for (let i = n - 1; i > 0; i--) {
      const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
  } while (a.every((x, i) => x === i));
  return a;
}
const isPerm = (v, n) => Array.isArray(v) && v.length === n && v.every((x) => Number.isInteger(x) && x >= 0 && x < n) && new Set(v).size === n;

// 0: a code made on Cloudflare, 1: one made on the game host
export const sideOf = (code) => [...String(code)].reduce((a, d) => a + Number(d), 0) % 2;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/new" && req.method === "POST") return newRoom(env);
    if (url.pathname === "/api/new" && req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const m = url.pathname.match(/^\/ws\/(\d{6})$/);
    if (m) {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("expected a websocket", { status: 426 });
      const h = new Headers(req.headers);
      h.set("x-room", m[1]);
      h.set("x-ip-key", await ipKey(req.headers.get("CF-Connecting-IP")));
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(new Request(req, { headers: h }));
    }
    if (url.pathname === "/health") return new Response("ok");
    return new Response("not found", { status: 404 });
  },
};

function randomToken(n = 24) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
}

const ALPH = "abcdefghijkmnpqrstuvwxyz23456789";
const enc = (s) => new TextEncoder().encode(s);

// Only a hash of the address is kept (never the address), and only for that day: for the limits.
export async function ipKey(ip) {
  const day = new Date().toISOString().slice(0, 10);
  const h = await crypto.subtle.digest("SHA-256", enc(day + "|ronda|" + (ip || "unknown")));
  return "ip:" + [...new Uint8Array(h).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A host's token proves the room was made by one of our two servers (APP-RULES safety 2): its last 12 characters
// are a signature over the room code and the first 12, made with RESUME_KEY, which only the two servers know. A
// server that lost a game (or never had it) takes it over only with such a token, never "nobody is here".
async function sig(env, code, rand) {
  if (!env || !env.RESUME_KEY) return null;
  const key = await crypto.subtle.importKey("raw", enc(env.RESUME_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc("ronda|" + code + "|" + rand)));
  return [...s.slice(0, 12)].map((b) => ALPH[b % 32]).join("");
}
// a socket that never says who it is does not stay open
export function idleClose(ws) {
  setTimeout(() => {
    if (!(ws.deserializeAttachment() || {}).role) try { ws.close(1008, "no join"); } catch (_) {}
  }, JOIN_MS);
}
// each socket's message budget; over it, the socket is closed
export function overBudget(room, ws) {
  const b = (room.budget ||= new Map());
  const now = Date.now();
  let x = b.get(ws);
  if (!x || now - x.t > BUDGET_MS) b.set(ws, (x = { t: now, n: 0 }));
  const role = (ws.deserializeAttachment() || {}).role || "none";
  if (++x.n <= (BUDGET[role] || BUDGET.none)) return false;
  try { ws.close(1008, "too many messages"); } catch (_) {}
  return true;
}

export async function handleOf(code, raw) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc("ronda-player|" + code + "|" + raw)));
  return [...h.slice(0, 16)].map((b) => ALPH[b % 32]).join("");
}
export async function hostToken(env, code) {
  const rand = randomToken(12);
  const s = await sig(env, code, rand);
  return s ? rand + s : randomToken(24);
}
export function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export async function proven(env, code, token) {
  if (typeof token !== "string" || !/^[a-z0-9]{24}$/.test(token) || !/^\d{6}$/.test(String(code))) return false;
  const s = await sig(env, code, token.slice(0, 12));
  if (!s) return false;
  let d = 0;
  for (let i = 0; i < 12; i++) d |= s.charCodeAt(i) ^ token.charCodeAt(12 + i);
  return d === 0;
}

// the site copy on GitHub Pages and the other server's site start rooms here too
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST", "Cache-Control": "no-store" };

export async function newRoom(env) {
  const side = env.SIDE === "odd" ? 1 : 0;
  for (let i = 0; i < 8; i++) {
    let code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    if (sideOf(code) !== side) code = code.slice(0, 5) + ((Number(code[5]) + 1) % 10);
    const token = await hostToken(env, code);
    const r = await env.ROOMS.get(env.ROOMS.idFromName(code)).fetch("https://room/claim", { method: "POST", body: token });
    if (r.ok) return Response.json({ code, token }, { headers: CORS });
  }
  return Response.json({ error: "busy" }, { status: 503, headers: CORS });
}

// a game the host's screen brings over from the other server, cleaned like everything else that arrives
export function cleanSnap(s, host) {
  const quiz = cleanQuiz(s?.quiz);
  if (!quiz) return null;
  const last = quiz.questions.length - 1;
  const phases = ["lobby", "question", "reveal", "board", "end"];
  let phase = phases.includes(s.phase) ? s.phase : "lobby";
  let qi = Math.max(-1, Math.min(last, Math.trunc(Number(s.qi)) || 0));
  if (Number(s.qi) === -1 || phase === "lobby") (qi = -1), (phase = "lobby");
  const players = {};
  for (const p of (Array.isArray(s.players) ? s.players : []).slice(0, MAX_PLAYERS)) {
    const id = String(p?.id || "");
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(id) || players[id]) continue;
    players[id] = { name: str(p.name, 30) || "Player", score: Math.max(0, Math.min(1e7, Math.trunc(Number(p.score)) || 0)) };
    const streak = Math.max(0, Math.min(1000, Math.trunc(Number(p.streak)) || 0));
    if (streak) players[id].streak = streak;
    if (p.out) players[id].out = true;
    if (Number.isInteger(p.team) && p.team >= 0 && p.team < MAX_TEAMS) players[id].team = p.team;
  }
  const teams = cleanTeams(s.teams);
  for (const p of Object.values(players)) {
    if (!teams) delete p.team;
    else if (!(p.team < teams.names.length)) p.team = smallestTeam(players, teams.names.length);
  }
  const log = [];
  for (let i = 0; i <= Math.max(qi, 0) && i < (Array.isArray(s.log) ? s.log.length : 0); i++) {
    const q = s.log[i];
    if (!q || typeof q !== "object") continue;
    const kind = quiz.questions[i].kind;
    const row = {};
    for (const [id, v] of Object.entries(q)) {
      if (!players[id]) continue;
      if (kind === "words") {
        if (Array.isArray(v)) row[id] = v.slice(0, 3).map((w) => str(w, 40).toLowerCase()).filter(Boolean);
      } else if (kind === "type") {
        if (str(v, 60)) row[id] = str(v, 60);
      } else if (kind === "order") {
        if (isPerm(v, quiz.questions[i].answers.length)) row[id] = v;
      } else if (kind === "slider") {
        const s = quiz.questions[i];
        if (typeof v === "number" && v >= s.min && v <= s.max) row[id] = v;
      } else if (Number.isInteger(v)) row[id] = v;
    }
    log[i] = row;
  }
  const g = { host, phase, quiz, qi, players, ans: {}, log, touched: Date.now(), boardShown: phase === "board" || !!s.boardShown,
    qa: cleanQa(s.qa, players) };
  if (teams) g.teams = teams;
  if (phase === "question") {
    // the question starts again: the answers given to it were on the server that went away
    const q = quiz.questions[qi];
    g.startedAt = Date.now();
    g.readMs = readMsOf(g, q);
    g.endsAt = q.time ? g.startedAt + q.time * 1000 + g.readMs : 0;
    g.boardShown = false;
  }
  if (phase !== "lobby" && quiz.questions[qi].kind === "order") {
    g.shuf = isPerm(s.shuf, quiz.questions[qi].answers.length) ? s.shuf : shuffle(quiz.questions[qi].answers.length);
  }
  return g;
}

// ---- quiz validation: the host's device sends the quiz; keep only what the game uses, bounded ----
const str = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function cleanQuiz(q) {
  if (!q || typeof q !== "object" || !Array.isArray(q.questions)) return null;
  const questions = [];
  for (const x of q.questions.slice(0, 100)) {
    const kind = KINDS.includes(x?.kind) ? x.kind : "quiz";
    const text = str(x?.text, 300);
    if (!text) continue;
    const out = { kind, text };
    if (kind === "type") {
      const seen = new Set();
      out.accept = (Array.isArray(x.accept) ? x.accept : []).map((a) => str(a, 60)).filter((a) => norm(a) && !seen.has(norm(a)) && seen.add(norm(a))).slice(0, 4);
      if (!out.accept.length) continue;
    }
    if (kind === "order") {
      out.answers = (Array.isArray(x.answers) ? x.answers : []).map((a) => str(a?.text ?? a, 120)).filter(Boolean).slice(0, MAX_ANSWERS);
      if (out.answers.length < 2) continue;
    }
    if (kind === "slider") {
      const num = (v) => {
        const n = v === "" || v == null ? NaN : Number(v);
        return Number.isFinite(n) && Math.abs(n) <= 1e9 ? Math.round(n * 100) / 100 : null;
      };
      const min = num(x.min), max = num(x.max), ans = num(x.ans);
      if (min == null || max == null || ans == null || min >= max || ans < min || ans > max) continue;
      Object.assign(out, { min, max, ans, dec: Math.max(decOf(min), decOf(max), decOf(ans)) });
      const m = Number(x.margin);
      out.margin = Number.isInteger(m) && m >= 0 && m <= 4 ? m : 2;
      const unit = str(x.unit, 20);
      if (unit) out.unit = unit;
    }
    if (kind === "quiz" || kind === "poll") {
      const answers = (Array.isArray(x.answers) ? x.answers : []).map((a) => str(a?.text ?? a, 120)).slice(0, MAX_ANSWERS);
      const keep = answers.map((a, i) => [a, i]).filter(([a]) => a);
      if (keep.length < 2) continue;
      out.answers = keep.map(([a]) => a);
      if (kind === "quiz") {
        const right = new Set((Array.isArray(x.correct) ? x.correct : []).map(Number));
        out.correct = keep.map(([, i], j) => (right.has(i) ? j : -1)).filter((j) => j >= 0);
        if (!out.correct.length) out.kind = "poll";
      }
    }
    const t = Number(x?.time);
    out.time = [0, 10, 20, 30, 60, 90, 120].includes(t) ? t : scored(out.kind) ? 20 : 0;
    if (scored(out.kind) && !out.time) out.time = 20;
    // Kahoot's "Points": standard (left out), double or none, per question with a right answer
    if (scored(out.kind) && (x.pts === 2 || x.pts === 0)) out.pts = x.pts;
    questions.push(out);
  }
  if (!questions.length) return null;
  return { title: str(q.title, 120) || "Ronda", questions };
}

// digits after the point a number needs (up to 2): the slider moves in steps of that size
const decOf = (n) => (String(n).split(".")[1] || "").length;

export function points(q, elapsedMs, v) {
  const limit = (q.time || 20) * 1000;
  const f = Math.min(1, Math.max(0, elapsedMs / limit));
  if (q.kind === "slider") {
    const tol = sliderTol(q);
    const close = tol ? Math.max(0, 1 - Math.abs(v - q.ans) / tol) : 1;
    return Math.round(1000 * (q.pts ?? 1) * (0.8 * close + 0.2 * (1 - f)));
  }
  return Math.round(1000 * (q.pts ?? 1) * (1 - f / 2));
}

// before a timed question counts down: 1.5 s to read it, or team talk when the teams have it on
export const readMsOf = (g, q) => (g.teams?.talk && q.time ? TALK_MS : READ_MS);

// what a phone needs to show a slider (never the right number while asking)
const rangeOf = (q) => (q.kind === "slider" ? { min: q.min, max: q.max, dec: q.dec, unit: q.unit || "" } : null);

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env || {};
    this.g = null; // the game, loaded from storage on first use (the object may have slept)
    this.flushTimer = null;
  }

  async game() {
    if (!this.g) this.g = (await this.state.storage.get("g")) || null;
    if (this.g && !this.g.qa) this.g.qa = cleanQa(null, {});
    return this.g;
  }

  async save(now = false) {
    if (!this.g) return;
    this.g.touched = Date.now();
    if (now) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      await this.state.storage.put("g", this.g);
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.state.storage.put("g", this.g);
      }, 800);
    }
  }

  async plan() {
    const g = this.g;
    if (!g) return;
    let at = expiry(g);
    if (g.phase === "question" && g.endsAt) at = Math.min(at, g.endsAt + 300);
    await this.state.storage.setAlarm(at);
  }

  async alarm() {
    const g = await this.game();
    if (!g) return;
    if (Date.now() >= expiry(g)) {
      for (const ws of this.state.getWebSockets()) ws.close(1000, "closed");
      this.g = null;
      await this.state.storage.deleteAll();
      return;
    }
    if (g.phase === "question" && g.endsAt && Date.now() >= g.endsAt) await this.reveal();
    await this.plan();
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/claim") {
      const g = await this.game();
      if (g && Date.now() < expiry(g)) return new Response("taken", { status: 409 });
      await this.state.storage.deleteAll();
      this.g = { host: await req.text(), phase: "lobby", quiz: null, qi: -1, players: {}, ans: {}, log: [], touched: Date.now(), qa: cleanQa(null, {}) };
      await this.save(true);
      await this.plan();
      return new Response("ok");
    }
    if (this.state.getWebSockets().length >= MAX_SOCKETS) return new Response("full", { status: 429 });
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1], [req.headers.get("x-room") || "", req.headers.get("x-ip-key") || "ip:none"]);
    idleClose(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (_) {}
  }

  // what someone without the token or key hears: exactly what a code nobody uses says
  async nope(ws) {
    if (!(await lookupOk(this.env, ws))) return this.send(ws, { t: "slow" });
    this.send(ws, { t: "gone" });
  }

  sockets(role) {
    return this.state.getWebSockets().filter((ws) => (ws.deserializeAttachment() || {}).role === role);
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_MSG) return;
    if (overBudget(this, ws)) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }
    let g = await this.game();
    ws.__ip = this.state.getTags(ws)[1] || "ip:none";
    // the host's screen brings the game over from the other server (or back after this one lost it)
    if (msg.t === "resume") {
      if (g && msg.token !== g.host) return this.send(ws, { t: "denied" });
      if (!g && !(await proven(this.env, this.state.getTags(ws)[0], msg.token))) return this.send(ws, { t: "denied" });
      const snap = cleanSnap(msg.snap, String(msg.token || ""));
      if (!snap || !/^[a-z0-9]{24}$/.test(snap.host)) return this.send(ws, { t: "bad-quiz" });
      for (const s of this.state.getWebSockets()) if (s !== ws && (s.deserializeAttachment() || {}).role === "host") s.close(1000, "moved");
      g = this.g = snap;
      ws.serializeAttachment({ role: "host" });
      await this.save(true);
      await this.plan();
      this.qaSend();
      return this.everyone();
    }
    const me = ws.deserializeAttachment() || {};
    const lookup = msg.t === "join" || msg.t === "host" || msg.t === "moved";
    if (!g) {
      if (!lookup) return;
      if (!(await lookupOk(this.env, ws))) return this.send(ws, { t: "slow" });
      return this.send(ws, { t: "gone" });
    }
    // the game went on on the other server: whoever is still here follows it
    if (msg.t === "moved") {
      if (msg.token !== g.host) return this.nope(ws);
      for (const s of this.state.getWebSockets()) this.send(s, { t: "moved" });
      this.g = null;
      await this.state.storage.deleteAll();
      return;
    }

    if (msg.t === "host") {
      if (msg.token !== g.host) return this.nope(ws);
      ws.serializeAttachment({ role: "host" });
      return this.toHost(ws);
    }
    if (msg.t === "join") {
      const raw = String(msg.id || "");
      if (!/^[A-Za-z0-9_-]{8,40}$/.test(raw)) return;
      // players are kept under a one-way hash of their secret id and this room's code: hosts, reports and exports
      // see only that, which can't be turned back into the id that joins as them
      const id = await handleOf(this.state.getTags(ws)[0], raw);
      // one socket is one person for its whole life (APP-RULES safety 4)
      if (me.role && !(me.role === "player" && me.id === id)) return;
      let p = g.players[id];
      if (!p) {
        // an assignment is reached with its link's key, never with the code alone (that is for live games)
        if (g.self?.key && !same(String(msg.k || ""), g.self.key)) return this.nope(ws);
        if (!(await lookupOk(this.env, ws))) return this.send(ws, { t: "slow" });
        if (g.phase === "end" || (g.self && Date.now() >= g.self.until)) return this.send(ws, { t: "over" });
        if (g.locked) return this.send(ws, { t: "locked" });
        // removed people still hold their name, but not a place
        if (Object.values(g.players).filter((x) => !x.out).length >= MAX_PLAYERS) return this.send(ws, { t: "full", max: MAX_PLAYERS });
        const base = str(msg.name, 30) || "Player";
        const taken = new Set(Object.values(g.players).map((x) => x.name.toLowerCase()));
        let name = base;
        for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${base} ${k}`;
        p = g.players[id] = { name, score: 0 };
        if (g.teams) p.team = smallestTeam(g.players, g.teams.names.length);
        if (g.self) Object.assign(p, { ph: "intro", qi: -1, ans: [], at: 0 });
        await this.save();
      }
      if (p.out) return this.send(ws, { t: "removed" });
      ws.serializeAttachment({ role: "player", id });
      if (g.self) {
        await this.selfCatchUp(id);
        this.send(ws, this.playerView(id));
        return this.hostsUpdate();
      }
      this.send(ws, this.playerView(id));
      this.send(ws, this.playerQa(id));
      return this.hostsUpdate();
    }

    if (me.role === "player") {
      if (g.players[me.id]?.out) return;
      if (g.self) {
        if (msg.t === "answer") return this.selfAnswer(me.id, msg);
        if (msg.t === "go") return this.selfGo(me.id, msg);
        return;
      }
      if (msg.t === "answer") return this.answer(me.id, msg);
      if (msg.t === "ask") return this.ask(ws, me.id, msg);
      if (msg.t === "vote") return this.vote(me.id, msg);
      // in the lobby people may pick their own team (Kahoot: "Players can choose their team when they join")
      if (msg.t === "team" && g.phase === "lobby" && g.teams) {
        const k = Number(msg.team);
        if (!Number.isInteger(k) || k < 0 || k >= g.teams.names.length) return;
        g.players[me.id].team = k;
        await this.save();
        return this.everyone();
      }
      return;
    }
    if (me.role !== "host") return;
    if (msg.t === "assign" && g.phase === "lobby" && !g.quiz && !Object.keys(g.players).length) return this.assign(ws, msg);
    if (g.self) {
      if (msg.t === "until" || msg.t === "end") return this.selfUntil(msg);
      if (msg.t === "top") {
        g.self.top = !!msg.on;
        await this.save();
        return this.everyone();
      }
      if (msg.t !== "remove" && msg.t !== "close") return;
    }

    if (msg.t === "load" && g.phase === "lobby") {
      const quiz = cleanQuiz(msg.quiz);
      if (!quiz) return this.send(ws, { t: "bad-quiz" });
      g.quiz = quiz;
      await this.save(true);
      return this.hostsUpdate();
    }
    if (msg.t === "teams" && g.phase === "lobby") return this.setTeams(msg);
    // Kahoot's "Lock": nobody new can join (people already in can come back)
    if (msg.t === "lock") {
      g.locked = !!msg.on;
      await this.save();
      return this.hostsUpdate();
    }
    if (msg.t === "rename" && g.teams) {
      const k = Number(msg.k), name = str(msg.name, 20);
      if (!Number.isInteger(k) || k < 0 || k >= g.teams.names.length || !name) return;
      g.teams.names[k] = name;
      await this.save();
      return this.everyone();
    }
    if (msg.t === "move" && g.teams && g.phase === "lobby") {
      const p = g.players[String(msg.id)], k = Number(msg.team);
      if (!p || p.out || !Number.isInteger(k) || k < 0 || k >= g.teams.names.length) return;
      p.team = k;
      await this.save();
      return this.everyone();
    }
    if (msg.t === "next") return this.next();
    if (msg.t === "reveal" && g.phase === "question") return this.reveal();
    if (msg.t === "remove") {
      const p = g.players[String(msg.id)];
      if (!p) return;
      p.out = true;
      await this.save();
      for (const s of this.sockets("player")) if (s.deserializeAttachment().id === msg.id) {
        this.send(s, { t: "removed" });
        s.close(1000, "removed");
      }
      return this.hostsUpdate();
    }
    if (msg.t === "export") return this.send(ws, { t: "export", log: g.log, players: g.players, quiz: g.quiz, teams: g.teams || null });
    if (msg.t === "qa") return this.qaAct(msg);
    if (msg.t === "close") {
      g.touched = 0;
      for (const s of this.state.getWebSockets()) if (s !== ws) this.send(s, { t: "closed" });
      this.g = null;
      await this.state.storage.deleteAll();
      return this.send(ws, { t: "closed" });
    }
  }

  // teams on or off, how many, team talk; only before the first question
  async setTeams(msg) {
    const g = this.g;
    if (!msg.on) {
      delete g.teams;
      for (const p of Object.values(g.players)) delete p.team;
    } else {
      const n = Math.max(2, Math.min(MAX_TEAMS, Math.trunc(Number(msg.n)) || 3));
      const given = Array.isArray(msg.names) ? msg.names : [];
      const old = g.teams?.names || [];
      const names = Array.from({ length: n }, (_, i) => old[i] || str(given[i], 20) || `Team ${i + 1}`);
      g.teams = { names, talk: msg.talk !== false, score: names.map(() => 0) };
      // everyone keeps their team if it is still there; the rest go where there are fewest, one by one
      const loose = [];
      for (const p of Object.values(g.players)) if (!(p.team >= 0 && p.team < n)) (delete p.team, loose.push(p));
      for (const p of loose) p.team = smallestTeam(g.players, n);
    }
    await this.save(true);
    this.everyone();
  }

  async next() {
    const g = this.g;
    if (!g.quiz) return;
    const last = g.quiz.questions.length - 1;
    if (g.phase === "question") return this.reveal();
    if (g.phase === "reveal" && scored(g.quiz.questions[g.qi].kind) && !g.boardShown) {
      g.boardShown = true;
      g.phase = "board";
    } else if (g.qi >= last && g.phase !== "lobby") {
      g.phase = "end";
    } else {
      g.qi++;
      g.phase = "question";
      g.boardShown = false;
      g.ans = {};
      const q = g.quiz.questions[g.qi];
      g.startedAt = Date.now();
      g.readMs = readMsOf(g, q);
      g.endsAt = q.time ? g.startedAt + q.time * 1000 + g.readMs : 0; // time to read (or team talk) before answers count down
      g.shuf = q.kind === "order" ? shuffle(q.answers.length) : undefined;
    }
    await this.save(true);
    await this.plan();
    this.everyone();
  }

  async reveal() {
    const g = this.g;
    if (g.phase !== "question") return;
    const q = g.quiz.questions[g.qi];
    g.phase = "reveal";
    g.gained = {};
    if (scored(q.kind)) {
      for (const [id, a] of Object.entries(g.ans)) {
        if (isRight(q, a.v)) {
          const pts = points(q, Math.max(0, a.at - g.startedAt - (g.readMs ?? READ_MS)), a.v);
          g.gained[id] = pts;
          if (g.players[id]) g.players[id].score += pts;
        }
      }
      // answer streak (shown, like Kahoot's, no extra points): right answers in a row; a question worth
      // no points neither adds to it nor breaks it
      if (q.pts !== 0) {
        for (const [id, p] of Object.entries(g.players)) {
          if (g.ans[id] && isRight(q, g.ans[id].v)) p.streak = (p.streak || 0) + 1;
          else delete p.streak;
        }
      }
      // a team gets the average of what its members got (a member who didn't answer got 0)
      if (g.teams) {
        const sum = g.teams.names.map(() => 0), size = g.teams.names.map(() => 0);
        for (const [id, p] of Object.entries(g.players)) {
          if (p.out || !(p.team < size.length)) continue;
          size[p.team]++;
          sum[p.team] += g.gained[id] || 0;
        }
        g.teamGained = sum.map((v, k) => (size[k] ? Math.round(v / size[k]) : 0));
        g.teamGained.forEach((v, k) => (g.teams.score[k] += v));
      }
    }
    g.log[g.qi] = Object.fromEntries(Object.entries(g.ans).map(([id, a]) => [id, a.v]));
    await this.save(true);
    await this.plan();
    this.everyone();
  }

  async answer(id, msg) {
    const g = this.g;
    if (g.phase !== "question" || msg.qi !== g.qi) return;
    const p = g.players[id];
    if (!p || p.out) return;
    const q = g.quiz.questions[g.qi];
    if (g.endsAt && Date.now() > g.endsAt + 500) return;
    // team talk: the answers open when it is over (a little slack for clocks)
    if (g.endsAt && (g.readMs ?? READ_MS) > READ_MS && Date.now() < g.startedAt + g.readMs - 300) return;
    const v = parseAnswer(q, msg.v, q.kind === "scale" ? null : g.ans[id]);
    if (v === undefined) return;
    g.ans[id] = { v, at: Date.now() };
    await this.save();
    for (const s of this.sockets("player")) if (s.deserializeAttachment().id === id) this.send(s, this.playerView(id));
    const active = Object.values(g.players).filter((x) => !x.out).length;
    if (q.kind !== "words" && Object.keys(g.ans).length >= active && q.time) return this.reveal();
    this.hostsUpdate();
  }

  results() {
    const g = this.g;
    if (g.qi < 0 || !g.quiz) return null;
    const q = g.quiz.questions[g.qi];
    const vals = Object.values(g.ans).map((a) => a.v);
    if (q.kind === "quiz" || q.kind === "poll") {
      const counts = q.answers.map(() => 0);
      for (const v of vals) counts[v]++;
      return { counts };
    }
    if (q.kind === "type") {
      // the answers people typed, alike ones together (shown as first typed), most common first
      const by = new Map();
      for (const v of vals) {
        const k = norm(v);
        const e = by.get(k) || { text: v, n: 0, ok: isRight(q, v) };
        e.n++;
        by.set(k, e);
      }
      return { right: vals.filter((v) => isRight(q, v)).length, total: vals.length,
        top: [...by.values()].sort((a, b) => b.n - a.n).slice(0, 12).map((e) => [e.text, e.n, e.ok]) };
    }
    if (q.kind === "order") return { right: vals.filter((v) => isRight(q, v)).length, total: vals.length };
    if (q.kind === "slider") {
      return { right: vals.filter((v) => isRight(q, v)).length, total: vals.length, vals: vals.slice(0, MAX_PLAYERS),
        avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null };
    }
    if (q.kind === "scale") {
      const counts = [0, 0, 0, 0, 0];
      for (const v of vals) counts[v - 1]++;
      return { counts, avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null };
    }
    const words = {};
    for (const list of vals) for (const w of list) words[w] = (words[w] || 0) + 1;
    return { words: Object.entries(words).sort((a, b) => b[1] - a[1]).slice(0, 80) };
  }

  // ---- audience questions ----
  async ask(ws, id, msg) {
    const qa = this.g.qa;
    const text = str(msg.text, QA_LEN);
    if (!text) return;
    if (!qa.open) return this.send(ws, { t: "qa-closed" });
    if (qa.list.length >= MAX_QA || qa.list.filter((x) => x.by === id).length >= QA_PER_PLAYER) return this.send(ws, { t: "qa-full" });
    qa.list.push({ id: randomToken(8), by: id, name: msg.anon ? "" : this.g.players[id].name, text, at: Date.now(), up: [],
      st: qa.mod ? "wait" : "" });
    await this.save();
    this.qaUpdate();
  }

  async vote(id, msg) {
    const it = this.g.qa.list.find((x) => x.id === msg.id);
    if (!it || it.st === "wait" || it.st === "done") return;
    const k = it.up.indexOf(id);
    if (msg.up && k < 0) it.up.push(id);
    else if (!msg.up && k >= 0) it.up.splice(k, 1);
    else return;
    await this.save();
    this.qaUpdate();
  }

  async qaAct(msg) {
    const qa = this.g.qa;
    const d = msg.do;
    if (d === "open" || d === "close") qa.open = d === "open";
    else if (d === "mod" || d === "nomod") qa.mod = d === "mod";
    else {
      const it = qa.list.find((x) => x.id === msg.id);
      if (!it) return;
      if (d === "del") qa.list.splice(qa.list.indexOf(it), 1);
      else if (d === "show") {
        for (const x of qa.list) if (x.st === "hi") x.st = "";
        it.st = "hi";
      } else if (d === "ok" || d === "hide" || d === "undone") it.st = "";
      else if (d === "done") it.st = "done";
      else return;
    }
    await this.save();
    this.qaUpdate(true);
  }

  hostQa() {
    const { open, mod, list } = this.g.qa;
    // an anonymous question doesn't tell the host who asked
    return { t: "qa", open, mod, list: list.map((x) => ({ ...x, by: x.name ? x.by : "" })) };
  }

  playerQa(id) {
    const { open, mod, list } = this.g.qa;
    return { t: "qa", open, mod, list: list.filter((x) => x.st !== "wait" || x.by === id).map((x) => (
      { id: x.id, name: x.name, text: x.text, at: x.at, st: x.st, n: x.up.length, me: x.up.includes(id), mine: x.by === id })) };
  }

  // votes come in bursts: one update for everyone every quarter second at most (the host's own actions go at once)
  qaUpdate(now = false) {
    if (now) {
      clearTimeout(this.qaTimer);
      this.qaTimer = null;
      return this.qaSend();
    }
    if (!this.qaTimer) this.qaTimer = setTimeout(() => { this.qaTimer = null; this.qaSend(); }, 250);
  }

  qaSend() {
    if (!this.g) return;
    const h = this.hostQa();
    for (const ws of this.sockets("host")) this.send(ws, h);
    for (const ws of this.sockets("player")) {
      const id = ws.deserializeAttachment().id;
      if (this.g.players[id] && !this.g.players[id].out) this.send(ws, this.playerQa(id));
    }
  }

  // ---- assignments: each person goes through the questions on their own (p.ph intro / question / reveal / end) ----
  async assign(ws, msg) {
    const g = this.g;
    const quiz = cleanQuiz(msg.quiz);
    if (!quiz) return this.send(ws, { t: "bad-quiz" });
    const now = Date.now();
    const until = Math.trunc(Number(msg.until));
    if (!(until > now + 60000) || until > now + MAX_DAYS * 86400000 + 3600000) return this.send(ws, { t: "bad-until" });
    g.quiz = quiz;
    g.phase = "self";
    // pinned: answers mixed on each phone unless turned off; pinned: the top 5 is off unless the host turns it on
    g.self = { until, made: now, mix: msg.mix !== false, top: msg.top === true, key: randomToken(12) };
    g.qa.open = false;
    await this.save(true);
    await this.plan();
    this.hostsUpdate();
  }

  // the host moves the deadline (up to 28 days from now) or ends it now; a finished one can't be opened again
  async selfUntil(msg) {
    const g = this.g, now = Date.now();
    if (now >= g.self.until) return;
    if (msg.t === "end") g.self.until = now;
    else {
      const u = Math.trunc(Number(msg.until));
      if (!(u > now + 60000) || u > now + MAX_DAYS * 86400000 + 3600000) return;
      g.self.until = u;
    }
    await this.save(true);
    await this.plan();
    if (now >= g.self.until) for (const id of Object.keys(g.players)) await this.selfCatchUp(id, false);
    this.everyone();
  }

  selfOpen() {
    return Date.now() < this.g.self.until;
  }

  // time is up for the question someone is on (they left mid-question, or their phone said so)
  selfLate(p, q, slack = 1500) {
    return !!q.time && Date.now() > p.at + READ_MS + q.time * 1000 + slack;
  }

  // a phone coming back: a question whose time ran out shows its answer; after the deadline, it is over
  async selfCatchUp(id, save = true) {
    const g = this.g, p = g.players[id];
    if (!p || p.ph === "end") return;
    if (!this.selfOpen()) {
      if (p.ph === "question") this.selfScore(p);
      p.ph = "end";
    } else if (p.ph === "question" && this.selfLate(p, g.quiz.questions[p.qi])) this.selfScore(p);
    if (save) await this.save();
  }

  // the question someone is on is over for them: their points, their streak (as in a live game)
  selfScore(p) {
    const q = this.g.quiz.questions[p.qi];
    const a = p.ans[p.qi];
    p.ph = "reveal";
    p.gained = 0;
    if (!scored(q.kind)) return;
    const ok = !!a && isRight(q, a.v);
    if (ok) {
      p.gained = points(q, Math.max(0, a.at - p.at - READ_MS), a.v);
      p.score += p.gained;
    }
    if (q.pts !== 0) ok ? (p.streak = (p.streak || 0) + 1) : delete p.streak;
  }

  // Start / Next / Done (words) / time is up
  async selfGo(id, msg) {
    const g = this.g, p = g.players[id];
    if (!p || p.ph === "end") return;
    if (!this.selfOpen()) await this.selfCatchUp(id);
    else if (p.ph === "question") {
      if (msg.qi !== p.qi) return;
      const q = g.quiz.questions[p.qi];
      if (q.kind !== "words" && !this.selfLate(p, q, -500)) return;
      this.selfScore(p);
    } else {
      const n = g.quiz.questions.length;
      if (msg.qi !== p.qi) return; // a second tap on the same Next
      if (p.qi + 1 >= n) {
        p.ph = "end";
        p.done = Date.now();
      } else {
        p.qi++;
        p.ph = "question";
        p.at = Date.now();
        delete p.gained;
        const q = g.quiz.questions[p.qi];
        if (g.self.mix && (q.kind === "quiz" || q.kind === "poll")) (p.mix ||= [])[p.qi] = shuffle(q.answers.length);
        if (q.kind === "order") (p.shuf ||= [])[p.qi] = shuffle(q.answers.length);
      }
    }
    await this.save();
    this.selfSend(id);
    this.hostsUpdate();
  }

  async selfAnswer(id, msg) {
    const g = this.g, p = g.players[id];
    if (!p || p.ph !== "question" || msg.qi !== p.qi) return;
    if (!this.selfOpen()) {
      await this.selfCatchUp(id);
      return this.selfSend(id);
    }
    const q = g.quiz.questions[p.qi];
    if (this.selfLate(p, q)) {
      this.selfScore(p);
    } else {
      let raw = msg.v;
      const mix = p.mix?.[p.qi];
      if (mix) {
        const j = Number(raw);
        if (!Number.isInteger(j) || j < 0 || j >= mix.length) return;
        raw = mix[j]; // the phone's order -> the question's
      }
      const v = parseAnswer(q, raw, p.ans[p.qi]);
      if (v === undefined) return;
      p.ans[p.qi] = { v, at: Date.now() };
      if (!(q.kind === "words" && v.length < 3)) this.selfScore(p);
    }
    await this.save();
    this.selfSend(id);
    this.hostsUpdate();
  }

  selfSend(id) {
    for (const s of this.sockets("player")) if (s.deserializeAttachment().id === id) this.send(s, this.playerView(id));
  }

  selfView(id) {
    const g = this.g, p = g.players[id], now = Date.now();
    const n = g.quiz.questions.length;
    const base = { t: "view", self: true, phase: p.ph, name: p.name, score: p.score, title: g.quiz.title, n,
      until: g.self.until, open: this.selfOpen(), quizzy: g.quiz.questions.some((x) => scored(x.kind)) };
    if (p.ph === "intro") return base;
    const r = this.ranking();
    const rank = r.findIndex((x) => x.id === id) + 1;
    if (p.ph === "end") {
      const right = g.quiz.questions.filter((q, i) => scored(q.kind) && p.ans[i] && isRight(q, p.ans[i].v)).length;
      return { ...base, rank, of: r.length, right, of2: g.quiz.questions.filter((q) => scored(q.kind)).length,
        top: g.self.top ? r.slice(0, 5).map((x) => [x.name, x.score]) : null, done: !!p.done };
    }
    const q = g.quiz.questions[p.qi];
    const mix = p.mix?.[p.qi];
    const answers = q.answers ? (mix ? mix.map((i) => q.answers[i]) : q.answers) : null;
    const a = p.ans[p.qi];
    const mine = a == null ? null : mix ? mix.indexOf(a.v) : a.v;
    const common = { ...base, qi: p.qi, kind: q.kind, pts: q.pts ?? 1, text: q.text, answers, mine, range: rangeOf(q),
      last: p.qi === n - 1 };
    if (p.ph === "question") {
      return { ...common, shuf: q.kind === "order" ? p.shuf?.[p.qi] : null, talk: false,
        endsIn: q.time ? Math.max(1, p.at + READ_MS + q.time * 1000 - now) : 0, readIn: Math.max(0, p.at + READ_MS - now) };
    }
    return { ...common, streak: p.streak || 0, rank, gained: p.gained || 0,
      correct: q.kind === "quiz" ? q.correct.map((i) => (mix ? mix.indexOf(i) : i)) : q.kind === "type" ? q.accept : q.kind === "slider" ? q.ans : null,
      right: scored(q.kind) && a != null ? isRight(q, a.v) : null };
  }

  // what the host's report shows: everyone's progress and answers (in the question's own order)
  report() {
    const g = this.g;
    const people = Object.entries(g.players).filter(([, p]) => !p.out).map(([id, p]) => ({
      id, name: p.name, score: p.score, done: p.ph === "end" && !!p.done, started: p.ph !== "intro",
      at: p.ph === "end" ? g.quiz.questions.length : Math.max(0, p.qi + (p.ph === "reveal" ? 1 : 0)),
      ans: g.quiz.questions.map((_, i) => (p.ans[i] ? p.ans[i].v : null)),
    })).sort((a, b) => b.score - a.score);
    return { t: "report", quiz: g.quiz, until: g.self.until, made: g.self.made, mix: g.self.mix, open: this.selfOpen(),
      key: g.self.key || "", top: !!g.self.top,
      keep: g.self.until + KEEP_MS, people };
  }

  ranking() {
    return Object.entries(this.g.players)
      .filter(([, p]) => !p.out)
      .map(([id, p]) => ({ id, name: p.name, score: p.score, ...(p.streak ? { streak: p.streak } : {}), ...(p.team != null ? { team: p.team } : {}) }))
      .sort((a, b) => b.score - a.score);
  }

  // teams by points (ties: the first team first), with how many people are in each
  teamRanking() {
    const t = this.g.teams;
    if (!t) return null;
    const size = t.names.map(() => 0);
    for (const p of Object.values(this.g.players)) if (!p.out && p.team < size.length) size[p.team]++;
    return t.names.map((name, k) => ({ k, name, score: t.score[k], n: size[k], gained: this.g.teamGained?.[k] || 0 }))
      .sort((a, b) => b.score - a.score || a.k - b.k);
  }

  hostView() {
    const g = this.g;
    const q = g.qi >= 0 && g.quiz ? g.quiz.questions[g.qi] : null;
    const live = q && (g.phase !== "question" || !scored(q.kind));
    return {
      t: "host",
      phase: g.phase,
      quiz: g.quiz,
      locked: !!g.locked,
      qi: g.qi,
      players: this.ranking(),
      teams: g.teams ? { names: g.teams.names, talk: g.teams.talk, score: g.teams.score } : null,
      teamRank: this.teamRanking(),
      out: Object.keys(g.players).filter((id) => g.players[id].out), // the host's copy of the game keeps these
      logq: g.qi >= 0 && g.phase !== "question" ? g.log[g.qi] || {} : null,
      boardShown: !!g.boardShown,
      answered: Object.keys(g.ans).length,
      results: live ? this.results() : null,
      shuf: q?.kind === "order" ? g.shuf : null,
      endsIn: g.phase === "question" && g.endsAt ? g.endsAt - Date.now() : 0,
      readIn: g.phase === "question" ? Math.max(0, g.startedAt + (g.readMs ?? READ_MS) - Date.now()) : 0,
      talk: g.phase === "question" && (g.readMs ?? READ_MS) > READ_MS,
    };
  }

  toHost(ws) {
    if (this.g.self) return this.send(ws, this.report());
    const v = this.hostView();
    (this.quizSent ||= new Map()).set(ws, v.quiz);
    this.send(ws, v);
    this.send(ws, this.hostQa());
  }

  // the quiz goes to each host screen once (it can be 256 KB); later updates say "same quiz"
  hostsUpdate() {
    if (this.g.self) {
      const v = this.report();
      for (const ws of this.sockets("host")) this.send(ws, v);
      return;
    }
    const v = this.hostView();
    const lite = { ...v, quiz: undefined, sameQuiz: true };
    this.quizSent ||= new Map();
    for (const ws of this.sockets("host")) {
      const same = this.quizSent.get(ws) === v.quiz;
      if (!same) this.quizSent.set(ws, v.quiz);
      this.send(ws, same && v.quiz ? lite : v);
    }
  }

  playerView(id) {
    const g = this.g;
    if (g.self) return this.selfView(id);
    const p = g.players[id];
    const base = { t: "view", phase: g.phase, name: p.name, score: p.score, title: g.quiz?.title || "" };
    // with teams a phone shows its team's points and place (Kahoot: "Player scores are not visible during gameplay")
    const tr = this.teamRanking();
    const mineT = tr && tr.find((x) => x.k === p.team);
    if (mineT) Object.assign(base, { team: { k: mineT.k, name: mineT.name, n: mineT.n, gained: mineT.gained }, score: mineT.score });
    if (g.phase === "lobby") return tr ? { ...base, teams: g.teams.names } : base;
    const q = g.quiz.questions[g.qi];
    const n = g.quiz.questions.length;
    const mine = g.ans[id]?.v ?? null;
    if (g.phase === "question") {
      return { ...base, qi: g.qi, n, kind: q.kind, pts: q.pts ?? 1, text: q.text, answers: q.answers || null, mine,
        shuf: q.kind === "order" ? g.shuf : null, range: rangeOf(q),
        endsIn: g.endsAt ? g.endsAt - Date.now() : 0, readIn: Math.max(0, g.startedAt + (g.readMs ?? READ_MS) - Date.now()),
        talk: (g.readMs ?? READ_MS) > READ_MS };
    }
    const rank = mineT ? tr.indexOf(mineT) + 1 : this.ranking().findIndex((r) => r.id === id) + 1;
    if (g.phase === "end") return { ...base, rank, of: tr ? tr.length : this.ranking().length, quizzy: g.quiz.questions.some((x) => scored(x.kind)) };
    return { ...base, qi: g.qi, n, kind: q.kind, pts: q.pts ?? 1, streak: p.streak || 0, text: q.text, answers: q.answers || null, mine,
      correct: q.kind === "quiz" ? q.correct : q.kind === "type" ? q.accept : q.kind === "slider" ? q.ans : null, range: rangeOf(q),
      right: scored(q.kind) && mine != null ? isRight(q, mine) : null, gained: g.gained?.[id] || 0, rank };
  }

  everyone() {
    this.hostsUpdate();
    for (const ws of this.sockets("player")) {
      const id = ws.deserializeAttachment().id;
      if (this.g.players[id]) this.send(ws, this.playerView(id));
    }
  }

  async webSocketClose(ws) {
    this.budget?.delete(ws);
    this.quizSent?.delete(ws);
    if ((ws.deserializeAttachment() || {}).role === "player" && (await this.game())) this.hostsUpdate();
  }
}
