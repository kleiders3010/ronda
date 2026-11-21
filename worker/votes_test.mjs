// Audit R12: "Votes are counted, never shown by name": the host's screen (and its copy of the game) gets how many
// voted for each audience question, never who; a game moved to the other server goes on from that count.
//   node worker/votes_test.mjs   (game host copy, port 8847)
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const KIN = join(here, "..", "kinetic");
execFileSync("node", ["pack.mjs"], { cwd: KIN });
const { WebSocket } = await import(pathToFileURL(join(KIN, "node_modules", "ws", "wrapper.mjs")).href);
const { cleanQa } = await import(pathToFileURL(join(KIN, "room.mjs")).href);

const PORT = 8847;
let fail = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fail++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const data = mkdtempSync(join(tmpdir(), "ronda-votes-"));
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

const room = await (await fetch(`http://127.0.0.1:${PORT}/api/new`, { method: "POST" })).json();
const host = await sock(room.code);
send(host, { t: "host", token: room.token });
await wait(200);
send(host, { t: "load", quiz: { title: "T", questions: [{ kind: "poll", text: "Pick", answers: ["a", "b"], time: 0 }] } });
const ana = await sock(room.code), beto = await sock(room.code);
send(ana, { t: "join", id: "votesAnaPhonexxxx", name: "Ana" });
send(beto, { t: "join", id: "votesBetoPhonexxx", name: "Beto" });
await wait(300);
send(ana, { t: "ask", text: "Will there be slides?", anon: true });
await wait(300);
const qid = last(ana, "qa")?.list?.[0]?.id;
send(beto, { t: "vote", id: qid, up: true });
await wait(400);
const item = last(host, "qa")?.list?.find((x) => x.id === qid);
check(item && item.n === 1, `the host sees how many voted (${item?.n})`);
check(item && !("up" in item) && !JSON.stringify(last(host, "qa")).includes("votesBeto"), "and not who"); // pinned: privacy page, votes are never shown by name
check(last(beto, "qa")?.list?.[0]?.me === true, "the voter's own phone knows it voted");

// the host's copy of the game carries counts only; the other server goes on from them
const moved = cleanQa({ open: true, list: [{ id: "abcdef12", text: "Slides?", n: 3 }] }, {});
const ids = cleanQa({ open: true, list: [{ id: "abcdef12", text: "Slides?", n: 3, up: ["x"] }] }, { x: { name: "X" } });
check(moved.list[0].base === 3 && moved.list[0].up.length === 0, "a moved game keeps the count (3)");
check(ids.list[0].base + ids.list[0].up.length === 3, "an older copy with ids still counts right");

for (const w of [host, ana, beto]) w.close();
srv.kill();
await wait(300);
try { rmSync(data, { recursive: true, force: true }); } catch {}
console.log(fail ? `FAILED ${fail}` : "votes OK");
process.exit(fail ? 1 : 0);
