// APP-RULES safety 3 (audit R3): what a host sees of a player can't be used to join as that player, and the same
// phone looks different in every ronda. Starts kinetic/server.mjs (the same room code as the Worker).
//   node worker/pid_test.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const KIN = join(here, "..", "kinetic");
execFileSync("node", ["pack.mjs"], { cwd: KIN });
const { WebSocket } = await import(pathToFileURL(join(KIN, "node_modules", "ws", "wrapper.mjs")).href);
const { hostToken, handleOf } = await import(pathToFileURL(join(KIN, "room.mjs")).href);

const KEY = "test-only-resume-key";
const PORT = 8843;
let fail = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fail++; };
const RAW = "phoneSecretId1234";
// pinned: audit R3, one id per ronda, hosts see only a hash
check((await handleOf("234569", RAW)) !== RAW, "the handle is not the id");
check((await handleOf("234569", RAW)) !== (await handleOf("234571", RAW)), "the same id looks different in another ronda");

const data = mkdtempSync(join(tmpdir(), "ronda-pid-"));
const srv = spawn("node", ["server.mjs"], { cwd: KIN, windowsHide: true, stdio: "ignore",
  env: { ...process.env, PORT: String(PORT), BIND: "127.0.0.1", DATA_DIR: data, SIDE: "odd", RESUME_KEY: KEY } });
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
const code = "234569";
const quiz = { title: "T", questions: [{ kind: "quiz", text: "2+2?", answers: ["4", "5"], correct: [0], time: 20 }] };
const sock = () => new Promise((res) => { const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${code}`); ws.on("open", () => res(ws)); });
const host = await sock();
let last = null;
host.on("message", (d) => { const m = JSON.parse(String(d)); if (m.t === "host") last = m; });
host.send(JSON.stringify({ t: "resume", token: await hostToken({ RESUME_KEY: KEY }, code), snap: { quiz, phase: "lobby", qi: -1, players: [], log: [] } }));
await new Promise((r) => setTimeout(r, 400));
const ana = await sock();
ana.send(JSON.stringify({ t: "join", id: RAW, name: "Ana" }));
await new Promise((r) => setTimeout(r, 500));
const seen = JSON.stringify(last || {});
check(!!last && /Ana/.test(seen), "the host sees Ana");
// pinned: audit R3
check(!seen.includes(RAW), "but never her secret id");
const handle = (last?.players || []).find((p) => p.name === "Ana")?.id;
const eve = await sock();
let eveView = null;
eve.on("message", (d) => { const m = JSON.parse(String(d)); if (m.t === "player" || m.name) eveView = eveView || m; });
eve.send(JSON.stringify({ t: "join", id: handle || "x".repeat(16), name: "Eve" }));
await new Promise((r) => setTimeout(r, 500));
const names = (last?.players || []).map((p) => p.name).sort().join(",");
// pinned: audit R3
check(names === "Ana,Eve", `joining with what the host sees makes a new player, not Ana (${names})`);
for (const w of [host, ana, eve]) w.close();
srv.kill();
await new Promise((r) => setTimeout(r, 300));
try { rmSync(data, { recursive: true, force: true }); } catch {}
console.log(fail ? `FAIL ${fail}` : "pid OK");
process.exit(fail ? 1 : 0);
