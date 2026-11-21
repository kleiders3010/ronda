// APP-RULES safety 2 (audit R2): a server takes over a game it does not have only with a host token that one of our
// servers signed for that room code. Starts kinetic/server.mjs (the same room code as the Worker) on a free port.
//   node worker/resume_test.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const KIN = join(here, "..", "kinetic");
execFileSync("node", ["pack.mjs"], { cwd: KIN });
const { WebSocket } = await import(pathToFileURL(join(KIN, "node_modules", "ws", "wrapper.mjs")).href);
const { hostToken, proven } = await import(pathToFileURL(join(KIN, "room.mjs")).href);

const KEY = "test-only-resume-key";
const PORT = 8841;
let fail = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fail++; };

// the signature itself
const env = { RESUME_KEY: KEY };
const t = await hostToken(env, "123457");
check(/^[a-z0-9]{24}$/.test(t), "a token keeps the old shape (24 characters)");
check(await proven(env, "123457", t), "a signed token proves its own code");
check(!(await proven(env, "123458", t)), "it proves no other code");
check(!(await proven({ RESUME_KEY: "another" }, "123457", t)), "another key does not accept it");
check(!(await proven({}, "123457", t)), "no key: nothing is accepted");
check(!(await proven(env, "123457", t.slice(0, 12) + "a".repeat(12))), "a made-up signature is refused");

// through the server
const data = mkdtempSync(join(tmpdir(), "ronda-resume-"));
const srv = spawn("node", ["server.mjs"], { cwd: KIN, windowsHide: true, stdio: "ignore",
  env: { ...process.env, PORT: String(PORT), BIND: "127.0.0.1", DATA_DIR: data, SIDE: "odd", RESUME_KEY: KEY } });
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
const quiz = { title: "T", questions: [{ kind: "quiz", text: "2+2?", answers: ["4", "5"], correct: [0], time: 20 }] };
const tryResume = (code, token) => new Promise((res) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${code}`);
  const done = (v) => { try { ws.close(); } catch {} res(v); };
  ws.on("open", () => ws.send(JSON.stringify({ t: "resume", token, snap: { quiz, phase: "lobby", qi: -1, players: [], log: [] } })));
  ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.t !== "qa") done(m.t); });
  setTimeout(() => done("timeout"), 4000);
});
const code = "234569"; // nobody has it on this server
// pinned: audit R2, an empty room takes a game only with a token signed for its code
check((await tryResume(code, "abcdefghijkmnpqrstuvwxyz")) === "denied", "an empty room refuses an unsigned token");
// pinned: audit R2, an empty room takes a game only with a token signed for its code
check((await tryResume(code, await hostToken(env, "111111"))) === "denied", "and a token signed for another code");
const good = await hostToken(env, code);
const got = await tryResume(code, good);
// pinned: audit R2
check(got !== "denied" && got !== "timeout" && got !== "bad-quiz", `a token signed for this code takes it over (${got})`);
// pinned: audit R2, an empty room takes a game only with a token signed for its code
check((await tryResume(code, await hostToken(env, code))) === "denied", "once it is there, only that game's own token");
srv.kill();
await new Promise((r) => setTimeout(r, 300));
try { rmSync(data, { recursive: true, force: true }); } catch {}
console.log(fail ? `FAIL ${fail}` : "resume OK");
process.exit(fail ? 1 : 0);
