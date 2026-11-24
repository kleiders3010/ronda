// Item 46: how much crowd the game host's copy of Ronda carries (the rented host: one core, 2 GiB, every game in it).
// Runs kinetic/server.mjs locally (never the live host), fills ROOMS rooms with PLAYERS phones each (spread over fake
// addresses, as behind the host's door), plays QUESTIONS questions where every phone answers, and prints the server's
// memory and CPU and how long a phone waits for the answer to come back.
//   ROOMS=10 PLAYERS=30 QUESTIONS=3 node worker/load_test.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const KIN = join(here, "..", "kinetic");
execFileSync("node", ["pack.mjs"], { cwd: KIN });
const { WebSocket } = await import(pathToFileURL(join(KIN, "node_modules", "ws", "wrapper.mjs")).href);
const { hostToken } = await import(pathToFileURL(join(KIN, "room.mjs")).href);

const ROOMS = Number(process.env.ROOMS) || 10;
const PLAYERS = Number(process.env.PLAYERS) || 30;
const QUESTIONS = Number(process.env.QUESTIONS) || 3;
const KEY = "test-only-resume-key";
const PORT = Number(process.env.PORT) || 8851;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const data = mkdtempSync(join(tmpdir(), "ronda-load-"));
const probe = join(data, "probe.mjs");
// the server prints its own memory and CPU every half second (stderr), so the phones' work here is not counted
writeFileSync(probe, `let c0 = process.cpuUsage(); setInterval(() => { const c = process.cpuUsage(c0);
  process.stderr.write("probe " + process.memoryUsage().rss + " " + (c.user + c.system) + "\\n"); }, 500).unref();`);
const srv = spawn("node", [...(process.env.PROFILE ? ["--cpu-prof", "--cpu-prof-dir=" + process.env.PROFILE] : []), "--import", pathToFileURL(probe).href, "server.mjs"], { cwd: KIN, windowsHide: true,
  stdio: [process.env.PROFILE ? "pipe" : "ignore", "ignore", "pipe"],
  env: { ...process.env, PORT: String(PORT), BIND: "127.0.0.1", DATA_DIR: join(data, "d"), SIDE: "odd", RESUME_KEY: KEY } });
let rss = 0, peak = 0, cpu = 0;
srv.stderr.on("data", (d) => {
  for (const l of String(d).split("\n")) {
    const m = l.match(/^probe (\d+) (\d+)/);
    if (m) { rss = Number(m[1]); peak = Math.max(peak, rss); cpu = Number(m[2]); }
  }
});
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
  await wait(100);
}
await wait(600);
const idle = rss;
const MB = (b) => (b / 1048576).toFixed(0) + " MB";

let addr = 0;
const sock = (code) => new Promise((res, rej) => {
  // 25 phones an address: a class behind one school address is the common case
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${code}`, { headers: { "x-forwarded-for": `10.${(addr >> 16) & 255}.${(addr >> 8) & 255}.${Math.floor(addr++ / 25) & 255}` } });
  ws.msgs = [];
  ws.on("message", (d) => { const m = JSON.parse(String(d)); ws.msgs.push(m); ws.onmsg?.(m); });
  ws.on("open", () => res(ws));
  ws.on("error", rej);
});
const quiz = { title: "Load", questions: Array.from({ length: QUESTIONS }, (_, i) => ({ kind: "quiz", text: `Q${i}?`, answers: ["a", "b", "c", "d"], correct: [0], time: 20 })) };

const t0 = Date.now();
const rooms = [];
for (let r = 0; r < ROOMS; r++) {
  const code = String(100001 + r * 2); // odd: the game host's side
  const host = await sock(code);
  host.send(JSON.stringify({ t: "resume", token: await hostToken({ RESUME_KEY: KEY }, code), snap: { quiz, phase: "lobby", qi: -1, players: [], log: [] } }));
  rooms.push({ code, host, phones: [] });
}
await wait(300);
let joinFail = 0;
for (const room of rooms) {
  const batch = [];
  for (let p = 0; p < PLAYERS; p++) batch.push(sock(room.code).then((ws) => {
    ws.send(JSON.stringify({ t: "join", id: `load${room.code}p${String(p).padStart(6, "0")}`, name: `P${p}` }));
    room.phones.push(ws);
  }).catch(() => joinFail++));
  await Promise.all(batch);
}
const joined = Date.now() - t0;
console.error("joined", joined, joinFail);
await wait(1500);
const afterJoin = rss;
const players = rooms.map((r) => ([...r.host.msgs].reverse().find((m) => m.t === "host")?.players || []).length);

const waits = [];
const cpu0 = cpu;
const q0 = Date.now();
for (let qi = 0; qi < QUESTIONS; qi++) {
  // after the first question: reveal -> board -> next question
  for (const room of rooms) for (let k = 0; k < (qi ? 2 : 1); k++) room.host.send(JSON.stringify({ t: "next" }));
  await wait(700); // the question opens (read time is the default)
  const sent = [];
  for (const room of rooms) for (const ws of room.phones) {
    sent.push(new Promise((res) => {
      setTimeout(() => {
        const at = Date.now();
        ws.onmsg = (m) => { if (m.t === "view") { ws.onmsg = null; waits.push(Date.now() - at); res(); } };
        ws.send(JSON.stringify({ t: "answer", qi, v: Math.floor(Math.random() * 4) }));
        setTimeout(() => { if (ws.onmsg) { ws.onmsg = null; waits.push(Infinity); res(); } }, 15000);
      }, Math.random() * 3000);
    }));
  }
  console.error("q", qi, "sent", sent.length);
  await Promise.all(sent);
  await wait(500);
}
const playMs = Date.now() - q0;
const usedCpu = (cpu - cpu0) / 1000;
waits.sort((a, b) => a - b);
const pct = (p) => waits[Math.min(waits.length - 1, Math.floor(p * waits.length))];
const lost = waits.filter((w) => w === Infinity).length;
console.log(JSON.stringify({
  rooms: ROOMS, playersPerRoom: PLAYERS, questions: QUESTIONS,
  joinedIn: joined + " ms", joinFail, playersSeenByHosts: players.reduce((a, b) => a + b, 0),
  memIdle: MB(idle), memAfterJoin: MB(afterJoin), memPeak: MB(peak),
  memPerPhone: ((afterJoin - idle) / 1024 / Math.max(1, ROOMS * PLAYERS)).toFixed(1) + " KB",
  serverCpuWhilePlaying: usedCpu.toFixed(0) + " ms of " + playMs + " ms (" + (100 * usedCpu / playMs).toFixed(0) + "% of one core)",
  answerWaitMs: { p50: pct(0.5), p95: pct(0.95), max: waits[waits.length - 1] }, answersLost: lost,
}));
for (const room of rooms) { room.host.terminate(); for (const ws of room.phones) ws.terminate(); }
// PROFILE=<folder>: the server stops on its own so node writes the CPU profile there
if (process.env.PROFILE) { srv.stdin.write("stop\n"); await new Promise((r) => srv.once("exit", r)); } else srv.kill();
await wait(300);
rmSync(data, { recursive: true, force: true });
