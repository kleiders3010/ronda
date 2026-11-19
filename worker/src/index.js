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
const MAX_MSG = 256 * 1024; // a whole quiz arrives in one message
const ROOM_TTL = 6 * 3600 * 1000;
const KINDS = ["quiz", "poll", "words", "scale"];

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
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
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

// the site copy on GitHub Pages and the other server's site start rooms here too
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST", "Cache-Control": "no-store" };

export async function newRoom(env) {
  const token = randomToken();
  const side = env.SIDE === "odd" ? 1 : 0;
  for (let i = 0; i < 8; i++) {
    let code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    if (sideOf(code) !== side) code = code.slice(0, 5) + ((Number(code[5]) + 1) % 10);
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
    if (p.out) players[id].out = true;
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
      } else if (Number.isInteger(v)) row[id] = v;
    }
    log[i] = row;
  }
  const g = { host, phase, quiz, qi, players, ans: {}, log, touched: Date.now(), boardShown: phase === "board" || !!s.boardShown };
  if (phase === "question") {
    // the question starts again: the answers given to it were on the server that went away
    const q = quiz.questions[qi];
    g.startedAt = Date.now();
    g.endsAt = q.time ? g.startedAt + q.time * 1000 + 1500 : 0;
    g.boardShown = false;
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
    if (kind === "quiz" || kind === "poll") {
      const answers = (Array.isArray(x.answers) ? x.answers : []).map((a) => str(a?.text ?? a, 120)).slice(0, 4);
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
    out.time = [0, 10, 20, 30, 60, 90, 120].includes(t) ? t : out.kind === "quiz" ? 20 : 0;
    if (out.kind === "quiz" && !out.time) out.time = 20;
    questions.push(out);
  }
  if (!questions.length) return null;
  return { title: str(q.title, 120) || "Ronda", questions };
}

export function points(q, elapsedMs) {
  const limit = (q.time || 20) * 1000;
  const f = Math.min(1, Math.max(0, elapsedMs / limit));
  return Math.round(1000 * (1 - f / 2));
}

export class Room {
  constructor(state) {
    this.state = state;
    this.g = null; // the game, loaded from storage on first use (the object may have slept)
    this.flushTimer = null;
  }

  async game() {
    if (!this.g) this.g = (await this.state.storage.get("g")) || null;
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
    let at = g.touched + ROOM_TTL;
    if (g.phase === "question" && g.endsAt) at = Math.min(at, g.endsAt + 300);
    await this.state.storage.setAlarm(at);
  }

  async alarm() {
    const g = await this.game();
    if (!g) return;
    if (Date.now() >= g.touched + ROOM_TTL) {
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
      if (g && Date.now() < g.touched + ROOM_TTL) return new Response("taken", { status: 409 });
      await this.state.storage.deleteAll();
      this.g = { host: await req.text(), phase: "lobby", quiz: null, qi: -1, players: {}, ans: {}, log: [], touched: Date.now() };
      await this.save(true);
      await this.plan();
      return new Response("ok");
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (_) {}
  }

  sockets(role) {
    return this.state.getWebSockets().filter((ws) => (ws.deserializeAttachment() || {}).role === role);
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_MSG) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }
    let g = await this.game();
    // the host's screen brings the game over from the other server (or back after this one lost it)
    if (msg.t === "resume") {
      if (g && msg.token !== g.host) return this.send(ws, { t: "denied" });
      const snap = cleanSnap(msg.snap, String(msg.token || ""));
      if (!snap || !/^[a-z0-9]{24}$/.test(snap.host)) return this.send(ws, { t: "bad-quiz" });
      for (const s of this.state.getWebSockets()) if (s !== ws && (s.deserializeAttachment() || {}).role === "host") s.close(1000, "moved");
      g = this.g = snap;
      ws.serializeAttachment({ role: "host" });
      await this.save(true);
      await this.plan();
      return this.everyone();
    }
    if (!g) return this.send(ws, { t: "gone" });
    const me = ws.deserializeAttachment() || {};
    // the game went on on the other server: whoever is still here follows it
    if (msg.t === "moved") {
      if (msg.token !== g.host) return this.send(ws, { t: "denied" });
      for (const s of this.state.getWebSockets()) this.send(s, { t: "moved" });
      this.g = null;
      await this.state.storage.deleteAll();
      return;
    }

    if (msg.t === "host") {
      if (msg.token !== g.host) return this.send(ws, { t: "denied" });
      ws.serializeAttachment({ role: "host" });
      return this.toHost(ws);
    }
    if (msg.t === "join") {
      const id = String(msg.id || "");
      if (!/^[A-Za-z0-9_-]{8,40}$/.test(id)) return;
      let p = g.players[id];
      if (!p) {
        if (g.phase === "end") return this.send(ws, { t: "over" });
        if (Object.keys(g.players).length >= MAX_PLAYERS) return this.send(ws, { t: "full", max: MAX_PLAYERS });
        const base = str(msg.name, 30) || "Player";
        const taken = new Set(Object.values(g.players).map((x) => x.name.toLowerCase()));
        let name = base;
        for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${base} ${k}`;
        p = g.players[id] = { name, score: 0 };
        await this.save();
      }
      if (p.out) return this.send(ws, { t: "removed" });
      ws.serializeAttachment({ role: "player", id });
      this.send(ws, this.playerView(id));
      return this.hostsUpdate();
    }

    if (me.role === "player") {
      if (msg.t === "answer") return this.answer(me.id, msg);
      return;
    }
    if (me.role !== "host") return;

    if (msg.t === "load" && g.phase === "lobby") {
      const quiz = cleanQuiz(msg.quiz);
      if (!quiz) return this.send(ws, { t: "bad-quiz" });
      g.quiz = quiz;
      await this.save(true);
      return this.hostsUpdate();
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
    if (msg.t === "export") return this.send(ws, { t: "export", log: g.log, players: g.players, quiz: g.quiz });
    if (msg.t === "close") {
      g.touched = 0;
      for (const s of this.state.getWebSockets()) if (s !== ws) this.send(s, { t: "closed" });
      this.g = null;
      await this.state.storage.deleteAll();
      return this.send(ws, { t: "closed" });
    }
  }

  async next() {
    const g = this.g;
    if (!g.quiz) return;
    const last = g.quiz.questions.length - 1;
    if (g.phase === "question") return this.reveal();
    if (g.phase === "reveal" && g.quiz.questions[g.qi].kind === "quiz" && !g.boardShown) {
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
      g.endsAt = q.time ? g.startedAt + q.time * 1000 + 1500 : 0; // 1.5 s to read before answers count down
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
    if (q.kind === "quiz") {
      for (const [id, a] of Object.entries(g.ans)) {
        if (q.correct.includes(a.v)) {
          const pts = points(q, Math.max(0, a.at - g.startedAt - 1500));
          g.gained[id] = pts;
          if (g.players[id]) g.players[id].score += pts;
        }
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
    let v;
    if (q.kind === "quiz" || q.kind === "poll") {
      if (g.ans[id]) return; // one answer, no changes (speed counts)
      v = Number(msg.v);
      if (!Number.isInteger(v) || v < 0 || v >= q.answers.length) return;
    } else if (q.kind === "scale") {
      v = Number(msg.v);
      if (!Number.isInteger(v) || v < 1 || v > 5) return;
    } else {
      const w = str(msg.v, 40).toLowerCase();
      if (!w) return;
      const have = g.ans[id]?.v || [];
      if (have.length >= 3 || have.includes(w)) return;
      v = [...have, w];
    }
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
    if (q.kind === "scale") {
      const counts = [0, 0, 0, 0, 0];
      for (const v of vals) counts[v - 1]++;
      return { counts, avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null };
    }
    const words = {};
    for (const list of vals) for (const w of list) words[w] = (words[w] || 0) + 1;
    return { words: Object.entries(words).sort((a, b) => b[1] - a[1]).slice(0, 80) };
  }

  ranking() {
    return Object.entries(this.g.players)
      .filter(([, p]) => !p.out)
      .map(([id, p]) => ({ id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);
  }

  hostView() {
    const g = this.g;
    const q = g.qi >= 0 && g.quiz ? g.quiz.questions[g.qi] : null;
    const live = q && (g.phase !== "question" || q.kind !== "quiz");
    return {
      t: "host",
      phase: g.phase,
      quiz: g.quiz,
      qi: g.qi,
      players: this.ranking(),
      out: Object.keys(g.players).filter((id) => g.players[id].out), // the host's copy of the game keeps these
      logq: g.qi >= 0 && g.phase !== "question" ? g.log[g.qi] || {} : null,
      boardShown: !!g.boardShown,
      answered: Object.keys(g.ans).length,
      results: live ? this.results() : null,
      endsIn: g.phase === "question" && g.endsAt ? g.endsAt - Date.now() : 0,
      readIn: g.phase === "question" ? Math.max(0, g.startedAt + 1500 - Date.now()) : 0,
    };
  }

  toHost(ws) {
    this.send(ws, this.hostView());
  }

  hostsUpdate() {
    const v = this.hostView();
    for (const ws of this.sockets("host")) this.send(ws, v);
  }

  playerView(id) {
    const g = this.g;
    const p = g.players[id];
    const base = { t: "view", phase: g.phase, name: p.name, score: p.score, title: g.quiz?.title || "" };
    if (g.phase === "lobby") return base;
    const q = g.quiz.questions[g.qi];
    const n = g.quiz.questions.length;
    const mine = g.ans[id]?.v ?? null;
    if (g.phase === "question") {
      return { ...base, qi: g.qi, n, kind: q.kind, text: q.text, answers: q.answers || null, mine,
        endsIn: g.endsAt ? g.endsAt - Date.now() : 0, readIn: Math.max(0, g.startedAt + 1500 - Date.now()) };
    }
    const rank = this.ranking().findIndex((r) => r.id === id) + 1;
    if (g.phase === "end") return { ...base, rank, of: this.ranking().length, quizzy: g.quiz.questions.some((x) => x.kind === "quiz") };
    return { ...base, qi: g.qi, n, kind: q.kind, text: q.text, answers: q.answers || null, mine,
      correct: q.kind === "quiz" ? q.correct : null, gained: g.gained?.[id] || 0, rank };
  }

  everyone() {
    this.hostsUpdate();
    for (const ws of this.sockets("player")) {
      const id = ws.deserializeAttachment().id;
      if (this.g.players[id]) this.send(ws, this.playerView(id));
    }
  }

  async webSocketClose(ws) {
    if ((ws.deserializeAttachment() || {}).role === "player" && (await this.game())) this.hostsUpdate();
  }
}
