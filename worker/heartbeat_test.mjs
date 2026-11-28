// The phones' heartbeat on the game host (2026-11-28): "ping" is answered "pong" without running the room, like the
// Worker's auto-response, so a half-open link is found on both servers. A "ping" before any join is answered too
// (the room isn't asked). Starts kinetic/server.mjs on a free port.
//   node worker/heartbeat_test.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const KIN = join(here, "..", "kinetic");
execFileSync("node", ["pack.mjs"], { cwd: KIN });
const { WebSocket } = await import(pathToFileURL(join(KIN, "node_modules", "ws", "wrapper.mjs")).href);

const PORT = 8842;
let fail = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fail++; };

const data = mkdtempSync(join(tmpdir(), "ronda-beat-"));
const srv = spawn("node", ["server.mjs"], { cwd: KIN, windowsHide: true, stdio: "ignore",
  env: { ...process.env, PORT: String(PORT), BIND: "127.0.0.1", DATA_DIR: data, SIDE: "odd", RESUME_KEY: "test-only-beat-key" } });
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

const said = await new Promise((res) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/345671`);
  const got = [];
  const done = () => { try { ws.close(); } catch {} res(got); };
  ws.on("open", () => { ws.send("ping"); setTimeout(() => ws.send("ping"), 200); });
  ws.on("message", (d) => { got.push(String(d)); if (got.length >= 2) done(); });
  setTimeout(done, 3000);
});
// pinned: the heartbeat's two words, shared with web/app.js and the Worker's auto-response
check(said.length === 2 && said.every((x) => x === "pong"), `"ping" is answered "pong", each time (${JSON.stringify(said)})`);

srv.kill();
await new Promise((r) => setTimeout(r, 300));
try { rmSync(data, { recursive: true, force: true }); } catch {}
console.log(fail ? `FAIL ${fail}` : "heartbeat OK");
process.exit(fail ? 1 : 0);
