// Second-pass audit (research/safety-audit-2026-11-22/ronda.md in SelfSustainment), against the game host copy.
//   R2-1: "remove" / "move" naming "__proto__" (or anything that isn't one of this room's players) changes nothing,
//         in this room or any other.
//   R2-9: a word like "constructor" is counted as a word; typed text loses marks that flip or hide it.
//   node worker/r2_test.mjs   (port 8848)
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const KIN = join(here, "..", "kinetic");
execFileSync("node", ["pack.mjs"], { cwd: KIN });
const { WebSocket } = await import(pathToFileURL(join(KIN, "node_modules", "ws", "wrapper.mjs")).href);

const PORT = 8848;
let fail = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fail++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const data = mkdtempSync(join(tmpdir(), "ronda-r2-"));
const srv = spawn("node", ["server.mjs"], { cwd: KIN, windowsHide: true, stdio: "ignore",
  env: { ...process.env, PORT: String(PORT), BIND: "127.0.0.1", DATA_DIR: data, SIDE: "odd", RESUME_KEY: "test-only-resume-key" } });
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
  await wait(100);
}
const sock = (code) => new Promise((res) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${code}`);
  ws.msgs = [];
  ws.on("message", (d) => ws.msgs.push(JSON.parse(String(d))));
  ws.on("open", () => res(ws));
});
const send = (ws, m) => ws.send(JSON.stringify(m));
const last = (ws, t) => [...ws.msgs].reverse().find((m) => m.t === t);
const QUIZ = { title: "T", questions: [{ kind: "words", text: "One word", time: 0 }] };

async function game(name) {
  const room = await (await fetch(`http://127.0.0.1:${PORT}/api/new`, { method: "POST" })).json();
  const host = await sock(room.code);
  send(host, { t: "host", token: room.token });
  await wait(200);
  send(host, { t: "load", quiz: QUIZ });
  const p = await sock(room.code);
  send(p, { t: "join", id: `r2${name}Phonexxxxxx`, name });
  await wait(300);
  return { room, host, p };
}

// two rooms; the host of the first sends remove / move for "__proto__" and other non-players
const a = await game("Ana");
const b = await game("Beto");
for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty", "x"]) {
  send(a.host, { t: "remove", id });
  send(a.host, { t: "move", id, team: 0 });
}
await wait(400);
const third = await sock(b.room.code);
send(third, { t: "join", id: "r2CarlaPhonexxxxx", name: "Carla" });
await wait(400);
check(!third.msgs.some((m) => m.t === "removed"), "R2-1: after remove \"__proto__\" in another room, a newcomer here still joins"); // pinned: "removed" is the protocol word for being sent out
check(!a.p.msgs.some((m) => m.t === "removed") && !b.p.msgs.some((m) => m.t === "removed"), "R2-1: nobody in either room is sent out"); // pinned: "removed" is the protocol word for being sent out

// words: "constructor" counted as a word, hidden and direction marks gone
send(b.host, { t: "next" });
await wait(300);
send(b.p, { t: "answer", v: ["constructor"] });
send(third, { t: "answer", v: ["con\u200bstructor\u202e"] });
await wait(300);
send(b.host, { t: "reveal" });
await wait(400);
const txt = JSON.stringify(b.host.msgs);
check(!txt.includes("native code"), "R2-9: the word \"constructor\" is counted as a word");
check(!/[​‮]/.test(txt), "R2-9: marks that hide or flip text are gone from what the screen shows");

for (const w of [a.host, a.p, b.host, b.p, third]) w.close();
srv.kill();
await wait(300);
try { rmSync(data, { recursive: true, force: true }); } catch {}
console.log(fail ? `FAILED ${fail}` : "r2 OK");
process.exit(fail ? 1 : 0);
