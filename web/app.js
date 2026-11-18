// Ronda: make a quiz or poll, show it on a big screen, everyone answers on their phone.
// Quizzes live on this device (localStorage) and travel as links or files. The server only runs live rooms.
import { t, translatePage, LANG } from "/i18n.js";
import { openFeedback } from "/feedback.js";

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const LETTERS = ["A", "B", "C", "D"];
const KIND_NAME = { quiz: "Quiz", poll: "Poll", words: "Words", scale: "Scale" };
const fmtCode = (c) => c.slice(0, 3) + " " + c.slice(3);
const randId = (n = 16) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");

function toast(text, ms = 3200) {
  const d = el("div", "toast", text);
  $("#toasts").append(d);
  setTimeout(() => d.remove(), ms);
}

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

// "Send feedback" (home page and the big screen): what the person writes, plus, if they keep the tick, the page
// they are on and how often the live link dropped. Never quiz content or names.
document.addEventListener("click", (e) => {
  if (!e.target.closest(".fbOpen")) return;
  e.preventDefault();
  openFeedback({
    app: "ronda",
    t,
    toast,
    details: () => ({ page: document.querySelector(".page:not([hidden])")?.id || "", path: location.pathname.replace(/\/[a-z0-9]{4,}$/i, "/…"), live: { ...LIVE } }),
  });
});

// ---------------- pages ----------------
function show(id) {
  for (const s of document.querySelectorAll(".page")) s.hidden = s.id !== id;
  window.scrollTo(0, 0);
}
function go(path, replace = false) {
  history[replace ? "replaceState" : "pushState"](null, "", path);
  route();
}
window.addEventListener("popstate", route);
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-home]")) { e.preventDefault(); go("/"); }
});

let live = null; // the open socket (player or host)
function closeLive() {
  if (live) { live.stop(); live = null; }
}

function route() {
  const p = location.pathname;
  closeLive();
  let m;
  if ((m = p.match(/^\/(\d{6})$/))) return nameScreen(m[1]);
  if ((m = p.match(/^\/edit\/([a-z0-9]+)$/))) return editScreen(m[1]);
  if ((m = p.match(/^\/host\/(\d{6})$/))) return hostScreen(m[1]);
  if (location.hash.startsWith("#r=")) return importLink(location.hash.slice(3));
  homeScreen();
}

// ---------------- local quizzes ----------------
function allQuizzes() {
  try { return JSON.parse(safeGet("rondas") || "[]"); } catch { return []; }
}
function saveQuizzes(list) { safeSet("rondas", JSON.stringify(list)); }
function getQuiz(id) { return allQuizzes().find((q) => q.id === id); }
function putQuiz(q) {
  const list = allQuizzes().filter((x) => x.id !== q.id);
  q.updated = Date.now();
  list.unshift(q);
  saveQuizzes(list);
}
function newQuestion(kind) {
  const q = { kind, text: "", time: kind === "quiz" ? 20 : 0 };
  if (kind === "quiz" || kind === "poll") q.answers = ["", "", "", ""];
  if (kind === "quiz") q.correct = [0];
  return q;
}
function blankQuiz() {
  return { id: randId(10), title: "", questions: [newQuestion("quiz")] };
}

// share links carry the whole quiz, compressed, after the # (never sent to the server)
async function packQuiz(q) {
  const json = JSON.stringify({ title: q.title, questions: q.questions });
  let bytes = new TextEncoder().encode(json), tag = "j";
  if (window.CompressionStream) {
    bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
    tag = "z";
  }
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return tag + btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function unpackQuiz(s) {
  const tag = s[0];
  const bin = atob(s.slice(1).replace(/-/g, "+").replace(/_/g, "/"));
  let bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  if (tag === "z") bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
  return JSON.parse(new TextDecoder().decode(bytes));
}
function adopt(data) {
  if (!data || !Array.isArray(data.questions)) throw new Error("not a ronda");
  const q = { id: randId(10), title: String(data.title || "").slice(0, 120), questions: data.questions.slice(0, 100) };
  putQuiz(q);
  return q;
}
async function importLink(s) {
  try {
    const q = adopt(await unpackQuiz(s));
    toast(t("Saved to your rondas"));
    go("/edit/" + q.id, true);
  } catch {
    toast(t("That link is broken"));
    go("/", true);
  }
}
$("#importFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const q = adopt(JSON.parse(await f.text()));
    go("/edit/" + q.id);
  } catch {
    toast(t("That file isn't a ronda"));
  }
});

// ---------------- home ----------------
function homeScreen() {
  show("home");
  $("#codeMsg").hidden = true;
  const list = allQuizzes();
  $("#mineWrap").hidden = false;
  const ul = $("#mine");
  ul.replaceChildren();
  for (const q of list) {
    const li = el("li", "mineRow");
    const open = el("button", "mineOpen");
    open.append(el("b", "", q.title || t("Untitled")), el("span", "small", t("{n} questions", { n: q.questions.length })));
    open.onclick = () => go("/edit/" + q.id);
    const play = el("button", "btn primary", t("Start"));
    play.onclick = () => startHosting(q);
    li.append(open, play);
    ul.append(li);
  }
  const fileRow = el("li", "mineFile");
  const fb = el("button", "btn link", t("Open a file…"));
  fb.onclick = () => $("#importFile").click();
  fileRow.append(fb);
  ul.append(fileRow);
  $("#code").value = "";
}
$("#code").addEventListener("input", (e) => {
  const d = e.target.value.replace(/\D/g, "").slice(0, 6);
  e.target.value = d.length > 3 ? d.slice(0, 3) + " " + d.slice(3) : d;
});
$("#codeForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const d = $("#code").value.replace(/\D/g, "");
  if (d.length !== 6) {
    $("#codeMsg").textContent = t("The code has 6 numbers");
    $("#codeMsg").hidden = false;
    return;
  }
  go("/" + d);
});
$("#makeBtn").onclick = () => {
  const q = blankQuiz();
  putQuiz(q);
  go("/edit/" + q.id);
};

// ---------------- editor ----------------
let editing = null;
let saveTimer = null;
function touch() {
  $("#saved").textContent = t("Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { putQuiz(editing); $("#saved").textContent = t("Saved"); }, 400);
}

function editScreen(id) {
  editing = getQuiz(id);
  if (!editing) return go("/", true);
  show("edit");
  $("#title").value = editing.title;
  $("#editMsg").hidden = true;
  $("#delBtn").textContent = t("Delete");
  renderQuestions();
}
$("#title").addEventListener("input", (e) => { editing.title = e.target.value; touch(); });
for (const b of document.querySelectorAll("[data-add]")) {
  b.onclick = () => {
    editing.questions.push(newQuestion(b.dataset.add));
    touch();
    renderQuestions();
    const cards = document.querySelectorAll(".qcard textarea");
    cards[cards.length - 1]?.focus();
  };
}

function timeOptions(kind) {
  return kind === "quiz" ? [10, 20, 30, 60, 90, 120] : [0, 20, 30, 60, 90, 120];
}

function renderQuestions() {
  const ol = $("#qs");
  ol.replaceChildren();
  editing.questions.forEach((q, i) => {
    const li = el("li", "qcard");
    const head = el("div", "qhead");
    head.append(el("span", "qnum", String(i + 1)));
    const kind = el("select", "kind");
    for (const k of Object.keys(KIND_NAME)) {
      const o = el("option", "", t(KIND_NAME[k]));
      o.value = k;
      kind.append(o);
    }
    kind.value = q.kind;
    kind.onchange = () => {
      const n = newQuestion(kind.value);
      n.text = q.text;
      if (q.answers && n.answers) n.answers = q.answers;
      editing.questions[i] = n;
      touch();
      renderQuestions();
    };
    const time = el("select", "time");
    for (const s of timeOptions(q.kind)) {
      const o = el("option", "", s ? t("{s} s", { s }) : t("No timer"));
      o.value = s;
      time.append(o);
    }
    time.value = q.time;
    time.onchange = () => { q.time = Number(time.value); touch(); };
    time.title = t("Time to answer");
    const tools = el("span", "qtools");
    const up = el("button", "icon", "↑"); up.title = t("Move up");
    const down = el("button", "icon", "↓"); down.title = t("Move down");
    const del = el("button", "icon", "✕"); del.title = t("Remove question");
    up.disabled = i === 0;
    down.disabled = i === editing.questions.length - 1;
    const move = (d) => {
      const arr = editing.questions;
      [arr[i], arr[i + d]] = [arr[i + d], arr[i]];
      touch();
      renderQuestions();
    };
    up.onclick = () => move(-1);
    down.onclick = () => move(1);
    del.onclick = () => {
      editing.questions.splice(i, 1);
      touch();
      renderQuestions();
    };
    tools.append(up, down, del);
    head.append(kind, time, tools);
    const text = el("textarea", "qtext");
    text.rows = 2;
    text.maxLength = 300;
    text.placeholder = { quiz: t("Ask a question with a right answer"), poll: t("Ask what people think"),
      words: t("Ask for a word or two"), scale: t("Ask for a rating from 1 to 5") }[q.kind];
    text.value = q.text;
    text.oninput = () => { q.text = text.value; touch(); };
    li.append(head, text);
    if (q.answers) {
      const grid = el("div", "answersEdit");
      q.answers.forEach((a, j) => {
        const row = el("div", "aedit c" + j);
        row.append(el("span", "letter", LETTERS[j]));
        const inp = el("input");
        inp.maxLength = 120;
        inp.placeholder = j < 2 ? t("Answer {l}", { l: LETTERS[j] }) : t("Answer {l} (optional)", { l: LETTERS[j] });
        inp.value = a;
        inp.oninput = () => { q.answers[j] = inp.value; touch(); };
        row.append(inp);
        if (q.kind === "quiz") {
          const ok = el("button", "okBtn" + (q.correct.includes(j) ? " on" : ""), q.correct.includes(j) ? "✓" : "");
          ok.title = t("Right answer");
          ok.setAttribute("aria-pressed", q.correct.includes(j));
          ok.onclick = () => {
            q.correct = q.correct.includes(j) ? q.correct.filter((x) => x !== j) : [...q.correct, j].sort();
            touch();
            renderQuestions();
          };
          row.append(ok);
        }
        grid.append(row);
      });
      li.append(grid);
      if (q.kind === "quiz") li.append(el("p", "small hint", t("Tap ✓ on the right answer. Faster right answers get more points.")));
    } else {
      li.append(el("p", "small hint", q.kind === "words" ? t("Everyone can send up to 3 words. They show as a word cloud.")
        : t("Everyone picks 1 to 5. Shows the average.")));
    }
    ol.append(li);
  });
}

function problems(q) {
  if (!q.questions.length) return t("Add a question first");
  for (const [i, x] of q.questions.entries()) {
    if (!x.text.trim()) return t("Question {n} has no text", { n: i + 1 });
    if (x.answers && x.answers.filter((a) => a.trim()).length < 2) return t("Question {n} needs at least 2 answers", { n: i + 1 });
    if (x.kind === "quiz" && !x.correct.some((j) => x.answers[j]?.trim())) return t("Question {n}: tap ✓ on the right answer", { n: i + 1 });
  }
  return null;
}

$("#startBtn").onclick = () => {
  putQuiz(editing);
  startHosting(editing);
};
$("#delBtn").onclick = () => {
  const b = $("#delBtn");
  if (!b.dataset.armed) {
    b.dataset.armed = "1";
    b.textContent = t("Tap again to delete");
    setTimeout(() => { delete b.dataset.armed; b.textContent = t("Delete"); }, 3000);
    return;
  }
  delete b.dataset.armed;
  saveQuizzes(allQuizzes().filter((x) => x.id !== editing.id));
  toast(t("Deleted"));
  go("/");
};
$("#shareBtn").onclick = async () => {
  putQuiz(editing);
  const url = location.origin + "/#r=" + (await packQuiz(editing));
  const title = editing.title || "Ronda";
  if (navigator.share) {
    try { await navigator.share({ title, text: t("A ronda to use or copy: {title}", { title }), url }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast(t("Link copied. Anyone who opens it gets their own copy."));
  } catch {
    downloadFile((title || "ronda") + ".json", JSON.stringify({ title: editing.title, questions: editing.questions }, null, 1), "application/json");
  }
};

function downloadFile(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name.replace(/[\\/:*?"<>|]/g, "_");
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

async function startHosting(q) {
  const msg = problems(q);
  if (msg) {
    if (location.pathname !== "/edit/" + q.id) go("/edit/" + q.id);
    $("#editMsg").textContent = msg;
    $("#editMsg").hidden = false;
    return;
  }
  try {
    const r = await fetch("/api/new", { method: "POST" });
    if (!r.ok) throw new Error(r.status);
    const { code, token } = await r.json();
    sessionStorage.setItem("host:" + code, JSON.stringify({ token, quiz: { title: q.title, questions: q.questions } }));
    go("/host/" + code);
  } catch {
    toast(t("Couldn't start. Check the internet and try again."));
  }
}

// ---------------- live connection (auto-reconnects) ----------------
const LIVE = { opens: 0, drops: 0 }; // for "Send feedback": how often the live link dropped
function connect(code, onOpen, onMsg) {
  let ws, stopped = false, wait = 500;
  const base = new URLSearchParams(location.search).get("server") || location.origin.replace(/^http/, "ws");
  const open = () => {
    ws = new WebSocket(base + "/ws/" + code);
    ws.onopen = () => { wait = 500; LIVE.opens++; onOpen(); };
    ws.onmessage = (e) => { try { onMsg(JSON.parse(e.data)); } catch {} };
    ws.onclose = () => { if (!stopped) { LIVE.drops++; setTimeout(open, wait); wait = Math.min(wait * 2, 8000); } };
  };
  open();
  return {
    send: (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); },
    stop: () => { stopped = true; try { ws.close(); } catch {} },
  };
}

// ---------------- player ----------------
function nameScreen(code) {
  show("name");
  $("#nameCode").textContent = fmtCode(code);
  $("#nameInput").value = safeGet("name") || "";
  $("#nameForm").onsubmit = (e) => {
    e.preventDefault();
    const name = $("#nameInput").value.trim();
    if (!name) return $("#nameInput").focus();
    safeSet("name", name);
    playScreen(code, name);
  };
  setTimeout(() => $("#nameInput").focus(), 50);
}

let pid = safeGet("pid");
if (!pid) { pid = randId(16); safeSet("pid", pid); }

let timerRaf = 0;
function countdown(node, endsIn, readIn, onEnd) {
  cancelAnimationFrame(timerRaf);
  if (!endsIn) return;
  const end = performance.now() + endsIn;
  const total = endsIn - readIn;
  const tick = () => {
    const left = end - performance.now();
    if (node.isConnected) {
      node.style.setProperty("--f", Math.max(0, Math.min(1, left / total)));
      const s = node.querySelector(".secs");
      if (s) s.textContent = Math.max(0, Math.ceil(left / 1000));
    }
    if (left > 0 && node.isConnected) timerRaf = requestAnimationFrame(tick);
    else if (left <= 0 && onEnd) onEnd();
  };
  tick();
}

function timerBar() {
  const d = el("div", "timer");
  d.append(el("div", "fill"), el("span", "secs"));
  return d;
}

function playScreen(code, name) {
  show("play");
  $("#pName").textContent = name;
  $("#pScore").textContent = "";
  const main = $("#pMain");
  main.replaceChildren(el("p", "wait", t("Joining…")));
  let lastKey = "";
  live = connect(code, () => live.send({ t: "join", id: pid, name }), (m) => {
    if (m.t === "gone" || m.t === "closed") return endMsg(t("This ronda has ended. Thanks for playing!"));
    if (m.t === "over") return endMsg(t("This ronda has already finished."));
    if (m.t === "full") return endMsg(t("This ronda is full ({max} people)", { max: m.max }));
    if (m.t === "removed") return endMsg(t("The host removed you from this ronda."));
    if (m.t !== "view") return;
    $("#pName").textContent = m.name;
    $("#pScore").textContent = m.score ? t("{n} points", { n: m.score }) : "";
    // keep a half-typed word when only the count changed
    const key = [m.phase, m.qi, JSON.stringify(m.mine)].join("|");
    if (key === lastKey) return;
    lastKey = key;
    main.replaceChildren(...playerView(m));
  });
  function endMsg(text) {
    closeLive();
    main.replaceChildren(el("p", "wait", text), homeLink());
  }
}

function homeLink() {
  const b = el("button", "btn ghost", t("Back to start"));
  b.dataset.home = "";
  return b;
}

function playerView(m) {
  const out = [];
  if (m.phase === "lobby") {
    out.push(el("p", "big-ok", t("You're in!")), el("p", "wait", t("Look at the screen. It starts soon.")));
    return out;
  }
  if (m.phase === "end") {
    out.push(el("p", "big-ok", t("Finished!")));
    if (m.quizzy) out.push(el("p", "wait", t("You came {rank} of {of} with {n} points", { rank: ordinal(m.rank), of: m.of, n: m.score })));
    else out.push(el("p", "wait", t("Thanks for taking part")));
    out.push(homeLink());
    return out;
  }
  out.push(el("p", "progress", t("Question {i} of {n}", { i: m.qi + 1, n: m.n })));
  out.push(el("h2", "ptext", m.text));
  if (m.phase === "question") {
    if (m.endsIn) {
      const tb = timerBar();
      out.push(tb);
      requestAnimationFrame(() => countdown(tb, m.endsIn, m.readIn));
    }
    if (m.kind === "quiz" || m.kind === "poll") {
      if (m.mine != null) {
        out.push(chosen(m.answers, m.mine), el("p", "wait", t("Sent. Wait for the others.")));
      } else {
        const grid = el("div", "pAnswers n" + m.answers.length);
        m.answers.forEach((a, j) => {
          const b = el("button", "pa c" + j);
          b.append(el("span", "letter", LETTERS[j]), el("span", "atext", a));
          b.onclick = () => { for (const x of grid.children) x.disabled = true; b.classList.add("picked"); live.send({ t: "answer", qi: m.qi, v: j }); };
          grid.append(b);
        });
        out.push(grid);
      }
    } else if (m.kind === "scale") {
      if (m.mine != null) out.push(el("p", "big-ok", String(m.mine)), el("p", "wait", t("Sent. You can change it until the results.")));
      const row = el("div", "scale");
      for (let v = 1; v <= 5; v++) {
        const b = el("button", "sv" + (m.mine === v ? " on" : ""), String(v));
        b.onclick = () => live.send({ t: "answer", qi: m.qi, v });
        row.append(b);
      }
      out.push(row, el("div", "scaleEnds small", ""));
      out[out.length - 1].append(el("span", "", t("Not at all")), el("span", "", t("A lot")));
    } else {
      const mine = m.mine || [];
      if (mine.length) {
        const ul = el("div", "sentWords");
        for (const w of mine) ul.append(el("span", "chip", w));
        out.push(ul);
      }
      if (mine.length < 3) {
        const f = el("form", "wordForm");
        const inp = el("input");
        inp.maxLength = 40;
        inp.placeholder = mine.length ? t("Another word (optional)") : t("Type a word");
        inp.autocomplete = "off";
        f.append(inp, el("button", "btn primary", t("Send")));
        f.onsubmit = (e) => { e.preventDefault(); if (inp.value.trim()) live.send({ t: "answer", qi: m.qi, v: inp.value }); };
        out.push(f);
        setTimeout(() => inp.focus(), 50);
      } else out.push(el("p", "wait", t("Sent. Look at the screen.")));
    }
    return out;
  }
  // reveal / board
  if (m.kind === "quiz") {
    if (m.mine == null) out.push(el("p", "big-no", t("No answer this time")));
    else if (m.correct.includes(m.mine)) out.push(el("p", "big-ok", t("Right!")), el("p", "gain", "+" + m.gained));
    else out.push(el("p", "big-no", t("Not this time")));
    if (m.answers) {
      const right = m.correct.map((j) => LETTERS[j] + ": " + m.answers[j]).join(" · ");
      out.push(el("p", "wait", t("Right answer: {a}", { a: right })));
    }
    out.push(el("p", "place", t("You're {rank}", { rank: ordinal(m.rank) })));
  } else {
    out.push(el("p", "big-ok", t("Thanks!")), el("p", "wait", t("Look at the screen for the results.")));
  }
  return out;
}

function chosen(answers, j) {
  const b = el("div", "pa c" + j + " picked solo");
  b.append(el("span", "letter", LETTERS[j]), el("span", "atext", answers[j]));
  return b;
}

function ordinal(n) {
  if (LANG === "es") return n + "°";
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
  return n + s;
}

// ---------------- host ----------------
let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && live?.host) keepAwake(); });

function hostScreen(code) {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem("host:" + code)); } catch {}
  if (!saved) { toast(t("This screen isn't hosting that ronda")); return go("/", true); }
  show("host");
  keepAwake();
  const main = $("#hMain");
  main.replaceChildren(el("p", "wait", t("Opening the room…")));
  let st = null;
  let lastKey = "";
  live = connect(code, () => live.send({ t: "host", token: saved.token }), (m) => {
    if (m.t === "denied" || m.t === "gone") { toast(t("This ronda has ended")); sessionStorage.removeItem("host:" + code); return go("/", true); }
    if (m.t === "bad-quiz") { toast(t("Something in this ronda can't be used")); return go("/", true); }
    if (m.t === "export") return saveResults(m);
    if (m.t === "closed") { sessionStorage.removeItem("host:" + code); return go("/", true); }
    if (m.t !== "host") return;
    if (!m.quiz) return live.send({ t: "load", quiz: saved.quiz });
    st = m;
    const key = [m.phase, m.qi].join("|");
    renderHost(code, m, key !== lastKey);
    lastKey = key;
  });
  live.host = true;
  $("#hNext").onclick = () => {
    if (!st) return;
    if (st.phase === "end") return live.send({ t: "export" });
    if (st.phase === "lobby" && !st.players.length) return toast(t("Wait for people to join first"));
    live.send({ t: "next" });
  };
  $("#hFull").onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  };
  $("#hFull").hidden = !document.documentElement.requestFullscreen;
}

function qr(text) {
  const q = window.qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const c = document.createElement("canvas");
  const s = 8;
  c.width = c.height = (n + 8) * s;
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#000";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) g.fillRect((x + 4) * s, (y + 4) * s, s, s);
  c.className = "qr";
  return c;
}

function renderHost(code, m, fresh) {
  const main = $("#hMain");
  const qs = m.quiz.questions;
  const q = m.qi >= 0 ? qs[m.qi] : null;
  const next = $("#hNext");
  const active = m.players.length;
  $("#hInfo").textContent = t("Code {code}", { code: fmtCode(code) }) + " · " + t("{n} people", { n: active });

  if (m.phase === "lobby") {
    next.textContent = t("Start");
    if (fresh || !main.querySelector(".lobbyHost")) {
      const wrap = el("div", "lobbyHost");
      const left = el("div", "joinInfo");
      left.append(el("h1", "htitle", m.quiz.title));
      left.append(el("p", "joinAt", t("Join at {site} with the code", { site: location.host })));
      left.append(el("p", "bigCode", fmtCode(code)));

      const qrBox = el("div", "qrBox");
      if (window.qrcode) qrBox.append(qr(location.origin + "/" + code), el("p", "small", t("or scan this with the phone camera")));
      wrap.append(left, qrBox);
      const people = el("div", "people");
      main.replaceChildren(wrap, el("p", "count"), people);
    }
    main.querySelector(".count").textContent = active ? t("{n} people are in. Tap a name to remove it.", { n: active }) : t("Waiting for people…");
    const people = main.querySelector(".people");
    people.replaceChildren();
    for (const p of m.players) {
      const b = el("button", "who", p.name);
      b.onclick = () => {
        if (b.dataset.armed) return live.send({ t: "remove", id: p.id });
        b.dataset.armed = "1";
        b.textContent = t("Remove {name}?", { name: p.name });
        setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = p.name; } }, 3000);
      };
      people.append(b);
    }
    return;
  }

  if (m.phase === "end") {
    next.textContent = t("Download results");
    const wrap = el("div", "endHost");
    wrap.append(el("h1", "htitle", m.quiz.title));
    if (qs.some((x) => x.kind === "quiz") && m.players.length) {
      const pod = el("div", "podium");
      [1, 0, 2].forEach((k) => {
        const p = m.players[k];
        if (!p) return;
        const col = el("div", "step s" + (k + 1));
        col.append(el("span", "pname", p.name), el("span", "ppts", t("{n} points", { n: p.score })), el("span", "pplace", String(k + 1)));
        pod.append(col);
      });
      wrap.append(pod);
    } else wrap.append(el("p", "thanks", t("Thanks, everyone!")));
    const close = el("button", "btn ghost", t("Close the room"));
    close.onclick = () => live.send({ t: "close" });
    wrap.append(close);
    main.replaceChildren(wrap);
    return;
  }

  if (m.phase === "board") {
    next.textContent = m.qi >= qs.length - 1 ? t("Finish") : t("Next question");
    const wrap = el("div", "board");
    wrap.append(el("h2", "htext", t("Top 5")));
    const ol = el("ol", "top");
    for (const p of m.players.slice(0, 5)) {
      const li = el("li");
      li.append(el("span", "nm", p.name), el("b", "", String(p.score)));
      ol.append(li);
    }
    wrap.append(ol);
    main.replaceChildren(wrap);
    return;
  }

  // question / reveal
  const asking = m.phase === "question";
  next.textContent = asking ? t("Show results") : q.kind === "quiz" ? t("Ranking") : m.qi >= qs.length - 1 ? t("Finish") : t("Next question");
  if (fresh) {
    const wrap = el("div", "qHost");
    const top = el("div", "qtop");
    top.append(el("span", "progress", t("Question {i} of {n}", { i: m.qi + 1, n: qs.length })), el("span", "answered"));
    wrap.append(top, el("h1", "htext", q.text));
    if (asking && m.endsIn) {
      const tb = timerBar();
      wrap.append(tb);
      requestAnimationFrame(() => countdown(tb, m.endsIn, m.readIn, () => live?.send({ t: "reveal" })));
    }
    wrap.append(el("div", "res"));
    main.replaceChildren(wrap);
  }
  main.querySelector(".answered").textContent = t("{a} of {n} answered", { a: m.answered, n: active });
  const res = main.querySelector(".res");
  res.replaceChildren(...hostResults(q, m, asking));
}

function hostResults(q, m, asking) {
  const r = m.results;
  if (q.kind === "quiz" || q.kind === "poll") {
    const total = r ? Math.max(1, ...r.counts) : 1;
    const grid = el("div", "hAnswers n" + q.answers.length);
    q.answers.forEach((a, j) => {
      const right = !asking && q.kind === "quiz" && q.correct.includes(j);
      const wrong = !asking && q.kind === "quiz" && !right;
      const b = el("div", "ha c" + j + (right ? " right" : "") + (wrong ? " faded" : ""));
      b.append(el("span", "letter", LETTERS[j]), el("span", "atext", a));
      if (r) {
        b.style.setProperty("--w", r.counts[j] / total);
        b.append(el("span", "cnt", String(r.counts[j])));
      }
      if (right) b.append(el("span", "tick", "✓"));
      grid.append(b);
    });
    return [grid];
  }
  if (q.kind === "scale") {
    const counts = r?.counts || [0, 0, 0, 0, 0];
    const max = Math.max(1, ...counts);
    const box = el("div", "scaleRes");
    const bars = el("div", "bars");
    counts.forEach((c, i) => {
      const col = el("div", "bcol");
      const bar = el("div", "bar");
      bar.style.setProperty("--h", c / max);
      col.append(el("span", "bc", String(c)), bar, el("span", "bl", String(i + 1)));
      bars.append(col);
    });
    box.append(el("p", "avg", r?.avg != null ? t("Average {v}", { v: r.avg.toFixed(1).replace(".", LANG === "es" ? "," : ".") }) : t("Waiting for answers…")), bars);
    return [box];
  }
  const cloud = el("div", "cloud");
  const words = r?.words || [];
  if (!words.length) return [el("p", "wait", t("Waiting for answers…"))];
  const max = words[0][1];
  for (const [w, c] of words) {
    const s = el("span", "w" + (Math.abs(hash(w)) % 4), w);
    s.style.fontSize = (1 + 2.6 * (c / max)).toFixed(2) + "em";
    s.title = String(c);
    cloud.append(s);
  }
  return [cloud];
}
function hash(s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return h; }

function saveResults(m) {
  const qs = m.quiz.questions;
  const esc = (v) => /[",\n;]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  const rows = [[t("Name"), t("Points"), ...qs.map((q, i) => (i + 1) + ". " + q.text)]];
  const ranked = Object.entries(m.players).filter(([, p]) => !p.out).sort((a, b) => b[1].score - a[1].score);
  for (const [id, p] of ranked) {
    rows.push([p.name, p.score, ...qs.map((q, i) => {
      const v = m.log[i]?.[id];
      if (v == null) return "";
      if (q.answers) return q.answers[v] + (q.kind === "quiz" ? (q.correct.includes(v) ? " ✓" : " ✗") : "");
      return Array.isArray(v) ? v.join(" / ") : v;
    })]);
  }
  const csv = "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n");
  downloadFile((m.quiz.title || "Ronda") + " - " + t("results") + ".csv", csv, "text/csv");
  toast(t("Results saved to your downloads"));
}

// ---------------- start ----------------
translatePage();
route();
