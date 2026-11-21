// APP-RULES safety 5 (audit R8): nobody learns whether a code is in use without its token or key, and new joins and
// failed lookups per address are limited. Runs on the game host's server (JOIN_LIMIT 20), or against a running
// Worker with its real limit of 100 per minute:
//   node worker/lookup_test.mjs                 (game host copy, port 8845)
//   node worker/lookup_test.mjs ws://127.0.0.1:8788   (wrangler dev; run it last: it uses up this address's minute)
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const KIN = join(here, "..", "kinetic");
execFileSync("node", ["pack.mjs"], { cwd: KIN });
const { WebSocket } = await import(pathToFileURL(join(KIN, "node_modules", "ws", "wrapper.mjs")).href);

const PORT = 8845;
const BASE = process.argv[2] || `ws://127.0.0.1:${PORT}`;
const LIMIT = process.argv[2] ? 100 : 20; // pinned: wrangler.toml JOINS limit 100 per minute
let fail = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fail++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let srv = null, data = null;
if (!process.argv[2]) {
  data = mkdtempSync(join(tmpdir(), "ronda-lookup-"));
  srv = spawn("node", ["server.mjs"], { cwd: KIN, windowsHide: true, stdio: "ignore",
    env: { ...process.env, PORT: String(PORT), BIND: "127.0.0.1", DATA_DIR: data, SIDE: "odd", RESUME_KEY: "test-only-resume-key", JOIN_LIMIT: String(LIMIT) } });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
    await wait(100);
  }
}
const http = BASE.replace(/^ws/, "http");
const sock = (code) => new Promise((res) => {
  const ws = new WebSocket(`${BASE}/ws/${code}`);
  ws.msgs = [];
  ws.on("message", (d) => ws.msgs.push(JSON.parse(String(d))));
  ws.on("error", () => res(ws));
  ws.on("open", () => res(ws));
});
const ask = async (code, msg, ms = 700) => {
  const ws = await sock(code);
  try { ws.send(JSON.stringify(msg)); } catch {}
  await wait(ms);
  ws.close();
  return ws.msgs.map((m) => m.t).join(",");
};

// a real room, made the way the app makes one
const room = await (await fetch(`${http}/api/new`, { method: "POST" })).json();
const quiz = { title: "T", questions: [{ kind: "quiz", text: "2+2?", answers: ["4", "5"], correct: [0], time: 20 }] };
const host = await sock(room.code);
host.send(JSON.stringify({ t: "host", token: room.token }));
await wait(300);
host.send(JSON.stringify({ t: "assign", quiz, until: Date.now() + 86400000 }));
await wait(500);
const rep = host.msgs.filter((m) => m.t === "report").pop();
check(rep && /^[a-z0-9]{12}$/.test(rep.key) && rep.top === false, "an assignment gets a 12-character key; its top 5 starts off");

const unused = room.code.slice(0, 5) + ((Number(room.code[5]) + 2) % 10);
const a = await ask(room.code, { t: "host", token: "x".repeat(24) });
const b = await ask(unused, { t: "host", token: "x".repeat(24) });
check(a === "gone" && b === "gone", `a wrong host token hears what a code nobody uses hears (${a} / ${b})`); // pinned: audit R8, protocol replies
const c = await ask(room.code, { t: "join", id: "abcdefgh12", name: "P" });
const d = await ask(unused, { t: "join", id: "abcdefgh12", name: "P" });
check(c === "gone" && d === "gone", `joining an assignment without its key = a code nobody uses (${c} / ${d})`); // pinned: audit R8, protocol replies
const e = await ask(room.code, { t: "lock", on: true });
const f = await ask(unused, { t: "lock", on: true });
check(e === "" && f === "", `other messages get no answer either way (${e || "nothing"} / ${f || "nothing"})`); // pinned: audit R8, protocol replies
const k = await ask(room.code, { t: "join", id: "abcdefgh13", name: "Ana", k: rep.key });
check(k.split(",")[0] === "view", `with the key from the link, joining works (${k})`); // pinned: audit R8, protocol replies

// the limit: new joins and failed lookups from one address
let slow = 0;
for (let i = 0; i < LIMIT + 10 && !slow; i++) if ((await ask(unused, { t: "join", id: "abcdefgh12", name: "P" }, 150)) === "slow") slow = i + 1;
check(slow > 0 && slow <= LIMIT + 6, `too many lookups from one address: it is told to wait (after ${slow})`);
const g = await ask(room.code, { t: "join", id: "abcdefgh14", name: "Beto", k: rep.key });
check(g === "slow", `and then a real code doesn't answer differently (${g})`); // pinned: audit R8, protocol replies
const r = await ask(room.code, { t: "join", id: "abcdefgh13", name: "Ana", k: rep.key });
check(r.split(",")[0] === "view", `someone already in still gets back in (${r})`); // pinned: audit R8, protocol replies

host.close();
if (srv) { srv.kill(); await wait(300); try { rmSync(data, { recursive: true, force: true }); } catch {} }
console.log(fail ? `FAILED ${fail}` : "lookup OK");
process.exit(fail ? 1 : 0);
