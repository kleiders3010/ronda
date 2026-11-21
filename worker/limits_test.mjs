// APP-RULES safety 4 + 5 (audit R5, R6): one socket is one person, each socket has a message budget, sockets that
// never join are closed, the host can lock the room, the quiz goes to a host screen once.
//   node worker/limits_test.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const KIN = join(here, "..", "kinetic");
execFileSync("node", ["pack.mjs"], { cwd: KIN });
const { WebSocket } = await import(pathToFileURL(join(KIN, "node_modules", "ws", "wrapper.mjs")).href);
const { hostToken } = await import(pathToFileURL(join(KIN, "room.mjs")).href);

const KEY = "test-only-resume-key";
const PORT = 8844;
let fail = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fail++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const data = mkdtempSync(join(tmpdir(), "ronda-limits-"));
const srv = spawn("node", ["server.mjs"], { cwd: KIN, windowsHide: true, stdio: "ignore",
  env: { ...process.env, PORT: String(PORT), BIND: "127.0.0.1", DATA_DIR: data, SIDE: "odd", RESUME_KEY: KEY } });
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
  await wait(100);
}
const code = "234569";
const quiz = { title: "T", questions: [{ kind: "quiz", text: "2+2?", answers: ["4", "5"], correct: [0], time: 20 }] };
const sock = () => new Promise((res) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${code}`);
  ws.msgs = [];
  ws.closed = false;
  ws.on("message", (d) => ws.msgs.push(JSON.parse(String(d))));
  ws.on("close", () => (ws.closed = true));
  ws.on("open", () => res(ws));
});
const host = await sock();
host.send(JSON.stringify({ t: "resume", token: await hostToken({ RESUME_KEY: KEY }, code), snap: { quiz, phase: "lobby", qi: -1, players: [], log: [] } }));
await wait(400);
const lastHost = () => [...host.msgs].reverse().find((m) => m.t === "host");

const a = await sock();
a.send(JSON.stringify({ t: "join", id: "phoneSecretIdAAAA", name: "Ana" }));
a.send(JSON.stringify({ t: "join", id: "phoneSecretIdBBBB", name: "Fake" }));
await wait(500);
// pinned: audit R5, one socket is one person
check((lastHost()?.players || []).map((p) => p.name).join(",") === "Ana", "a second join on the same socket is ignored");
const withQuiz = host.msgs.filter((m) => m.t === "host" && m.quiz).length;
const lite = host.msgs.filter((m) => m.t === "host" && m.sameQuiz && !m.quiz).length;
check(withQuiz >= 1 && lite >= 1, `the quiz went once, later updates without it (${withQuiz} with, ${lite} without)`);

host.send(JSON.stringify({ t: "lock", on: true }));
await wait(300);
check(lastHost()?.locked === true, "the host locks the room");
const b = await sock();
b.send(JSON.stringify({ t: "join", id: "phoneSecretIdCCCC", name: "Late" }));
await wait(300);
// pinned: Kahoot lock, nobody new joins a locked room
check(b.msgs.some((m) => m.t === "locked"), "someone new is told it is locked");
const a2 = await sock();
a2.send(JSON.stringify({ t: "join", id: "phoneSecretIdAAAA", name: "Ana" }));
await wait(300);
// pinned: Kahoot lock, people already in can come back
check(a2.msgs.some((m) => m.t === "view"), "someone already in comes back");

const spam = await sock();
spam.send(JSON.stringify({ t: "join", id: "phoneSecretIdDDDD", name: "Spam" }));
host.send(JSON.stringify({ t: "lock", on: false }));
await wait(300);
for (let i = 0; i < 100; i++) spam.send(JSON.stringify({ t: "vote", id: "x", up: true }));
await wait(500);
// pinned: audit R5, a socket over its message budget is closed
check(spam.closed, "a socket sending 100 messages at once is closed");
check(!host.closed && !a2.closed, "the others stay");

const idle = await sock();
await wait(11500);
// pinned: audit R6, sockets that never join are closed
check(idle.closed, "a socket that never joins is closed after 10 s");
for (const w of [host, a, b, a2]) try { w.close(); } catch {}
srv.kill();
await wait(300);
try { rmSync(data, { recursive: true, force: true }); } catch {}
console.log(fail ? `FAIL ${fail}` : "limits OK");
process.exit(fail ? 1 : 0);
