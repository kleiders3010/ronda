// Audit R9: "Put in order" never sends the right order to a phone before the reveal: the phone gets the items mixed
// and answers in that order; the server maps it back. Live game and assignment. Game host copy, port 8846:
//   node worker/order_test.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const KIN = join(here, "..", "kinetic");
execFileSync("node", ["pack.mjs"], { cwd: KIN });
const { WebSocket } = await import(pathToFileURL(join(KIN, "node_modules", "ws", "wrapper.mjs")).href);

const PORT = 8846;
let fail = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fail++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const data = mkdtempSync(join(tmpdir(), "ronda-order-"));
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
const lastView = (ws) => [...ws.msgs].reverse().find((m) => m.t === "view");
const ITEMS = ["one", "two", "three", "four", "five", "six"];
const quiz = { title: "T", questions: [{ kind: "order", text: "Count", answers: ITEMS, time: 60 }] };
const newRoom = async () => (await fetch(`http://127.0.0.1:${PORT}/api/new`, { method: "POST" })).json();

// a phone that answers by sending its screen positions in the order the items go
const rightPicks = (shown) => ITEMS.map((x) => shown.indexOf(x));
const naive = (n) => [...Array(n).keys()];

// live game: many phones, so a mix that happens to be the right order can't pass by luck
{
  const room = await newRoom();
  const host = await sock(room.code);
  send(host, { t: "host", token: room.token });
  await wait(200);
  send(host, { t: "load", quiz });
  const ph = [];
  for (let i = 0; i < 3; i++) {
    const p = await sock(room.code);
    send(p, { t: "join", id: "orderPhone" + i + "xxxx", name: "P" + i });
    ph.push(p);
  }
  await wait(300);
  send(host, { t: "next" });
  await wait(4500);
  const v = lastView(ph[0]);
  check(v && v.kind === "order" && v.shuf == null && v.answers.length === 6, "the phone gets the items and no way back to the order"); // pinned: audit R9
  const mixed = v.answers.join() !== ITEMS.join();
  send(ph[0], { t: "answer", qi: v.qi, v: rightPicks(v.answers) });
  send(ph[1], { t: "answer", qi: v.qi, v: naive(6) });
  await wait(400);
  send(host, { t: "reveal" });
  await wait(600);
  const r0 = lastView(ph[0]), r1 = lastView(ph[1]);
  check(r0.right === true, "picking the items in the right order scores");
  check(r1.right === mixed ? false : true, `sending 0,1,2,... scores only if the mix happened to be the right order (${mixed ? "mixed" : "not mixed"}: ${r1.right})`);
  for (const p of ph) p.close();
  host.close();
}

// assignment: each phone its own mix
{
  const room = await newRoom();
  const host = await sock(room.code);
  send(host, { t: "host", token: room.token });
  await wait(200);
  send(host, { t: "assign", quiz, until: Date.now() + 86400000 });
  await wait(300);
  const key = [...host.msgs].reverse().find((m) => m.t === "report").key;
  const p = await sock(room.code);
  send(p, { t: "join", id: "orderSelfPhonexxxx", name: "Ana", k: key });
  await wait(300);
  send(p, { t: "go", qi: -1 });
  await wait(300);
  const v = lastView(p);
  check(v && v.kind === "order" && v.shuf == null, "an assignment phone gets the items and no way back either"); // pinned: audit R9
  send(p, { t: "answer", qi: v.qi, v: rightPicks(v.answers) });
  await wait(300);
  check(lastView(p).right === true, "and the right order scores there too");
  p.close();
  host.close();
}

srv.kill();
await wait(300);
try { rmSync(data, { recursive: true, force: true }); } catch {}
console.log(fail ? `FAILED ${fail}` : "order OK");
process.exit(fail ? 1 : 0);
