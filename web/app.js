// Ronda: make a quiz or poll, show it on a big screen, everyone answers on their phone.
// Quizzes live on this device (localStorage) and travel as links or files. The server only runs live rooms.
import { t, translatePage, LANG } from "./i18n.js";
import { openFeedback } from "./feedback.js";
import { putPic, getPic, keepOnly, shrink, isPic } from "./pics.js";
// the folder the app lives in: "/" on quiz.jurisgames.com, "/ronda/" on the copy at GitHub Pages
const BASE = new URL(".", import.meta.url).pathname;
const here = () => "/" + location.pathname.slice(BASE.length); // the app's own path ("/host/123456")
// nobody puts the app inside their own page: the GitHub Pages copy can't send frame-ancestors (safety round 3 sweep of
// Juntos' J18 b; APP-RULES safety 44)
if (window.top !== window.self) {
  document.documentElement.textContent = "";
  throw new Error("ronda: not in a frame");
}

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const LETTERS = ["A", "B", "C", "D", "E", "F"];
const MAX_ANSWERS = 6; // the server keeps up to this many (worker/src/index.js)
// teams (like Kahoot's team mode): names and colours they start with; the host can rename them
const TEAM_NAMES = ["Foxes", "Owls", "Bears", "Wolves", "Otters", "Hawks", "Deer", "Lynxes", "Seals", "Bees"];
const TEAM_COLORS = ["#e11d48", "#2563eb", "#d97706", "#059669", "#7c3aed", "#0891b2", "#c026d3", "#65a30d", "#ea580c", "#475569"];
const MAX_TEAMS = 10; // the server's (worker/src/index.js)
const teamDot = (k) => { const d = el("span", "tdot"); d.style.background = TEAM_COLORS[k % TEAM_COLORS.length]; return d; };
const KIND_NAME = { quiz: "Quiz", poll: "Poll", words: "Words", scale: "Scale", type: "Type answer", order: "Put in order", slider: "Slider" };
// kinds with a right answer (points, ranking); the same rules as the server's (worker/src/index.js)
const scored = (k) => k === "quiz" || k === "type" || k === "order" || k === "slider";
// Kahoot's Slider: the margin is a part of the range (none, low, medium, high, maximum); the same as the server's
const MARGINS = [0, 0.05, 0.1, 0.2, 1];
const MARGIN_NAME = ["None (only the exact number)", "Low", "Medium", "High", "Maximum (every answer)"];
const sliderTol = (q) => MARGINS[q.margin ?? 2] * (q.max - q.min);
// a number as people read it: up to the slider's decimals (all of them with fixed), thousands grouped only from 10 000
// (a year stays 1969)
// a day and time as people read them, in their language ("Fri 27 Nov, 18:00")
const fmtWhen = (ms) => new Date(ms).toLocaleString(LANG, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
function fmtNum(v, dec = 0, unit = "", fixed = false) {
  const s = Number(v).toLocaleString(LANG === "es" ? "es-AR" : "en-US", { minimumFractionDigits: fixed ? dec : 0, maximumFractionDigits: dec,
    useGrouping: Math.abs(v) >= 10000 });
  return unit ? s + " " + unit : s;
}
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function isRight(q, v) {
  if (q.kind === "quiz") return q.correct.includes(v);
  if (q.kind === "type") return typeof v === "string" && !!norm(v) && q.accept.some((a) => norm(a) === norm(v));
  if (q.kind === "order") return Array.isArray(v) && v.length === q.answers.length && v.every((x, i) => x === i);
  if (q.kind === "slider") return typeof v === "number" && Math.abs(v - q.ans) <= sliderTol(q) + 1e-9 * (1 + Math.abs(q.ans));
  return false;
}
const fmtCode = (c) => c.slice(0, 3) + " " + c.slice(3);
const randId = (n = 16) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");

function toast(text, ms = 3200) {
  const d = el("div", "toast", text);
  $("#toasts").append(d);
  setTimeout(() => d.remove(), ms);
}

// every key starts with "ronda." (audit R11: the GitHub Pages copy shares its storage with our other apps)
function safeGet(k) { try { return localStorage.getItem("ronda." + k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem("ronda." + k, v); return true; } catch { return false; } }
// what an older version kept under the bare names moves over once ("name" is only copied: other apps may use it)
try {
  for (const k of ["rondas", "assigned", "pids", "name"]) {
    const old = localStorage.getItem(k);
    if (old == null || localStorage.getItem("ronda." + k) != null) continue;
    localStorage.setItem("ronda." + k, old);
    if (k !== "name") localStorage.removeItem(k);
  }
} catch {}
const hostKey = (code) => "ronda.host:" + code;

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
  history[replace ? "replaceState" : "pushState"](null, "", BASE + path.slice(1) + location.search);
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
  const p = here();
  closeLive();
  let m;
  if ((m = p.match(/^\/(\d{6})$/))) return nameScreen(m[1]);
  if ((m = p.match(/^\/edit\/([a-z0-9]+)$/))) return editScreen(m[1]);
  if ((m = p.match(/^\/host\/(\d{6})$/))) return hostScreen(m[1]);
  if ((m = p.match(/^\/report\/(\d{6})$/))) return reportScreen(m[1]);
  if (location.hash.startsWith("#r=")) return importLink(location.hash.slice(3));
  homeScreen();
}

// ---------------- local quizzes ----------------
function allQuizzes() {
  try { return JSON.parse(safeGet("rondas") || "[]"); } catch { return []; }
}
// a full storage must never look like "Saved" (audit R13): every save says when it didn't work
let fullToast = 0;
function saveQuizzes(list) {
  if (safeSet("rondas", JSON.stringify(list))) return true;
  if (Date.now() - fullToast > 6000) (fullToast = Date.now()), toast(t("Not saved: this browser's storage is full. Delete a ronda you don't need."), 8000);
  return false;
}
function getQuiz(id) { return allQuizzes().find((q) => q.id === id); }
function putQuiz(q) {
  const list = allQuizzes().filter((x) => x.id !== q.id);
  q.updated = Date.now();
  list.unshift(q);
  return saveQuizzes(list);
}
function newQuestion(kind) {
  const q = { kind, text: "", time: scored(kind) ? 20 : 0 };
  if (kind === "quiz" || kind === "poll" || kind === "order") q.answers = ["", "", "", ""];
  if (kind === "type") q.accept = ["", "", "", ""];
  if (kind === "quiz") q.correct = [0];
  if (kind === "slider") Object.assign(q, { min: 0, max: 100, ans: "", margin: 2 });
  return q;
}
function blankQuiz() {
  return { id: randId(10), title: "", questions: [newQuestion("quiz")] };
}

// share links carry the whole quiz, compressed, after the # (never sent to the server)
async function packQuiz(q) {
  const json = JSON.stringify({ title: q.title, questions: bare(q.questions) });
  let bytes = new TextEncoder().encode(json), tag = "j";
  if (window.CompressionStream) {
    bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
    tag = "z";
  }
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return tag + btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const UNPACK_MAX = 2 * 1024 * 1024;
async function unpackQuiz(s) {
  const tag = s[0];
  const bin = atob(s.slice(1).replace(/-/g, "+").replace(/_/g, "/"));
  let bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  if (tag === "z") {
    // read in pieces and stop at UNPACK_MAX (second-pass audit R2-10: a small crafted link could unpack to hundreds of
    // MB and hang the tab before anything was asked; 100 questions fit many times over)
    const r = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const parts = [];
    let n = 0;
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      n += value.length;
      if (n > UNPACK_MAX) {
        r.cancel().catch(() => {});
        throw new Error("too big");
      }
      parts.push(value);
    }
    bytes = new Uint8Array(n);
    let o = 0;
    for (const p of parts) bytes.set(p, (o += p.length) - p.length);
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
// questions without their pictures: what links and the server get (pictures stay on this device, pics.js)
const bare = (qs) => qs.map(({ img, aimg, ...x }) => x);
const PIC_ONLY = "\u{1F5BC}"; // what phones and the server get for an answer that is only a picture
// the picture keys a question uses
const picsOf = (x) => [x.img, ...(x.aimg || [])].filter(isPic);
// phones show a picture-only answer by its letter and colour alone (like Kahoot, whose phones show only the tiles)
const aText = (a) => (a === PIC_ONLY ? "" : a);
const withLetter = (answers, j) => (answers[j] === PIC_ONLY ? LETTERS[j] : LETTERS[j] + ": " + answers[j]);
const KINDS = ["quiz", "poll", "words", "scale", "type", "order", "slider"]; // worker/src/index.js KINDS
const TIMES = [0, 10, 20, 30, 60, 90, 120];
const txt = (v, n) => (typeof v === "string" || typeof v === "number" ? String(v).slice(0, n) : "");
function cleanImport(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.questions)) return null;
  const questions = [];
  for (const x of data.questions.slice(0, 100)) {
    if (!x || typeof x !== "object") continue;
    const kind = KINDS.includes(x.kind) ? x.kind : "quiz";
    const q = { kind, text: txt(x.text, 300), time: TIMES.includes(Number(x.time)) ? Number(x.time) : scored(kind) ? 20 : 0 };
    if (kind === "quiz" || kind === "poll" || kind === "order") {
      q.answers = (Array.isArray(x.answers) ? x.answers : []).slice(0, MAX_ANSWERS).map((a) => txt(a, 120));
      while (q.answers.length < 2) q.answers.push("");
    }
    if (kind === "quiz") {
      q.correct = [...new Set((Array.isArray(x.correct) ? x.correct : []).map(Number))].filter((i) => Number.isInteger(i) && i >= 0 && i < q.answers.length);
      if (!q.correct.length) q.correct = [0];
    }
    if (kind === "type") q.accept = (Array.isArray(x.accept) ? x.accept : []).slice(0, 4).map((a) => txt(a, 60));
    if (kind === "slider") {
      const num = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) || Math.abs(Number(v)) > 1e9 ? "" : Number(v));
      Object.assign(q, { min: num(x.min), max: num(x.max), ans: num(x.ans) });
      const m = Number(x.margin);
      q.margin = Number.isInteger(m) && m >= 0 && m <= 4 ? m : 2;
      if (txt(x.unit, 20)) q.unit = txt(x.unit, 20);
    }
    if (scored(kind) && (x.pts === 2 || x.pts === 0)) q.pts = x.pts;
    q.img = x.img;
    if (Array.isArray(x.aimg)) q.aimg = x.aimg;
    questions.push(q);
  }
  if (!questions.length) return null;
  return { title: txt(data.title, 120), questions };
}

async function adopt(raw) {
  const data = cleanImport(raw);
  if (!data) throw new Error("not a ronda");
  const q = { id: randId(10), title: data.title, questions: data.questions };
  const take = async (v) => {
    if (typeof v !== "string" || !/^data:image\/(webp|jpeg|png|gif);base64,/.test(v) || v.length > 4e6) return null;
    try { return await putPic(v); } catch { return null; }
  };
  let lost = 0;
  for (const x of q.questions) {
    const img = x.img, aimg = x.aimg;
    delete x.img;
    delete x.aimg;
    if ((x.img = await take(img)) == null) delete x.img;
    if (img && !x.img) lost++;
    if (Array.isArray(aimg) && Array.isArray(x.answers) && (x.kind === "quiz" || x.kind === "poll")) {
      const keys = [];
      for (const v of aimg.slice(0, x.answers.length)) keys.push(await take(v));
      lost += aimg.slice(0, x.answers.length).filter((v, i) => v && !keys[i]).length;
      if (keys.some(Boolean)) x.aimg = keys;
    }
  }
  if (!putQuiz(q)) throw new Error("full");
  if (lost) toast(t("{n} pictures couldn't be kept", { n: lost }), 6000);
  return q;
}
// a file carries the pictures themselves
async function quizFile(q) {
  const questions = [];
  for (const x of q.questions) {
    const { img, aimg, ...rest } = x;
    const pic = await getPic(img);
    if (pic) rest.img = pic;
    if (aimg?.some(Boolean)) rest.aimg = await Promise.all(aimg.map((k) => getPic(k)));
    questions.push(rest);
  }
  return JSON.stringify({ title: q.title, questions }, null, 1);
}
async function importLink(s) {
  let data = null;
  try { data = cleanImport(await unpackQuiz(s)); } catch {}
  if (!data) {
    toast(t("That link is broken"));
    return go("/", true);
  }
  homeScreen();
  const sheet = el("div", "asgSheet");
  sheet.id = "addSheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  const box = el("div", "asgBox card");
  const no = el("button", "btn ghost", t("Cancel"));
  const yes = el("button", "btn primary", t("Add to my rondas"));
  yes.name = "add";
  const row = el("div", "asgBtns");
  row.append(no, yes);
  box.append(el("h2", "asgHead", t("Add this ronda?")), el("p", "", data.title || t("Untitled")),
    el("p", "small", t("{n} questions", { n: data.questions.length })), row);
  sheet.append(box);
  document.body.append(sheet);
  const close = () => { sheet.remove(); history.replaceState(null, "", location.pathname + location.search); };
  no.onclick = close;
  sheet.onclick = (e) => { if (e.target === sheet) close(); };
  yes.onclick = async () => {
    yes.disabled = true;
    try {
      const q = await adopt(data);
      sheet.remove();
      toast(t("Saved to your rondas"));
      go("/edit/" + q.id, true);
    } catch (e) {
      yes.disabled = false;
      if (e.message !== "full") toast(t("That link is broken"));
    }
  };
  setTimeout(() => yes.focus(), 50);
}
$("#importFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const q = await adopt(JSON.parse(await f.text()));
    go("/edit/" + q.id);
  } catch (e) {
    if (e.message !== "full") toast(t("That file isn't a ronda"));
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
  drawAssigned();
  keepOnly(new Set(list.flatMap((q) => q.questions.flatMap(picsOf))));
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
  saveTimer = setTimeout(() => { $("#saved").textContent = putQuiz(editing) ? t("Saved") : t("Not saved"); }, 400);
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
  return scored(kind) ? [10, 20, 30, 60, 90, 120] : [0, 20, 30, 60, 90, 120];
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
      if (q.img) n.img = q.img;
      if (q.answers && n.answers) n.answers = q.answers;
      if (q.aimg && (n.kind === "quiz" || n.kind === "poll")) n.aimg = q.aimg;
      if (q.pts != null && scored(n.kind)) n.pts = q.pts;
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
      words: t("Ask for a word or two"), scale: t("Ask for a rating from 1 to 5"),
      type: t("Ask a question people answer by typing"), order: t("Ask people to put things in order"),
      slider: t("Ask for a number (a year, a price, an amount)") }[q.kind];
    text.value = q.text;
    text.oninput = () => { q.text = text.value; touch(); };
    li.append(head, text, picEdit(q, li));
    if (q.kind === "slider") {
      li.append(...sliderEdit(q));
    } else if (q.kind === "type") {
      const grid = el("div", "answersEdit");
      q.accept.forEach((a, j) => {
        const row = el("div", "aedit c" + j);
        const inp = el("input");
        inp.maxLength = 60;
        inp.name = "accept";
        inp.placeholder = j ? t("Also accepted (optional)") : t("The right answer");
        inp.value = a;
        inp.oninput = () => { q.accept[j] = inp.value; touch(); };
        row.append(inp);
        grid.append(row);
      });
      li.append(grid, el("p", "small hint", t("Capitals, accents and spaces don't matter. Add other spellings that also count.")));
    } else if (q.answers) {
      const grid = el("div", "answersEdit");
      q.answers.forEach((a, j) => {
        const row = el("div", "aedit c" + j);
        row.append(el("span", "letter", q.kind === "order" ? String(j + 1) : LETTERS[j]));
        const inp = el("input");
        inp.maxLength = 120;
        inp.placeholder = q.kind === "order" ? (j < 2 ? t("Number {n} in the order", { n: j + 1 }) : t("Number {n} (optional)", { n: j + 1 }))
          : j < 2 ? t("Answer {l}", { l: LETTERS[j] }) : t("Answer {l} (optional)", { l: LETTERS[j] });
        inp.value = a;
        inp.oninput = () => { q.answers[j] = inp.value; touch(); };
        row.append(inp);
        if (q.kind === "quiz" || q.kind === "poll") row.append(answerPic(q, j, inp));
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
      if (q.answers.length < MAX_ANSWERS) {
        const more = el("button", "btn chip addAnswer", t("+ Answer"));
        more.name = "addAnswer";
        more.onclick = () => {
          q.answers.push("");
          touch();
          renderQuestions();
          document.querySelectorAll(".qcard")[i]?.querySelectorAll(".aedit input")[q.answers.length - 1]?.focus();
        };
        li.append(more);
      }
      if (q.kind === "quiz") li.append(el("p", "small hint", t("Tap ✓ on the right answer. Faster right answers get more points.")));
      if (q.kind === "order") li.append(el("p", "small hint", t("Write them in the right order. Everyone sees them mixed up and puts them back.")));
    } else {
      li.append(el("p", "small hint", q.kind === "words" ? t("Everyone can send up to 3 words. They show as a word cloud.")
        : t("Everyone picks 1 to 5. Shows the average.")));
    }
    if (scored(q.kind)) li.append(pointsPicker(q));
    ol.append(li);
  });
}

// Kahoot's Slider (help 'Kahoot! question types'): from, to, the right number, a unit, the answer margin
function sliderEdit(q) {
  const box = el("div", "slideEdit");
  const hint = el("p", "small hint slideHint");
  const ok = () => [q.min, q.max, q.ans].every((v) => typeof v === "number") && q.min < q.max && q.ans >= q.min && q.ans <= q.max;
  const say = () => {
    if (!ok()) return (hint.textContent = t("People move a slider to their guess. The closer, the more points."));
    const dec = Math.max(...[q.min, q.max, q.ans].map((v) => (String(v).split(".")[1] || "").length));
    const tol = sliderTol(q);
    // the guesses that count, in the slider's own steps
    const st = 10 ** dec, lo = Math.ceil((q.ans - tol) * st - 1e-6) / st, hi = Math.floor((q.ans + tol) * st + 1e-6) / st;
    hint.textContent = !tol ? t("Only {a} gets points.", { a: fmtNum(q.ans, dec, q.unit) })
      : t("From {a} to {b} gets points, the closer the more.", { a: fmtNum(Math.max(q.min, lo), dec, q.unit), b: fmtNum(Math.min(q.max, hi), dec, q.unit) });
  };
  const num = (key, label) => {
    const lab = el("label", "nfield");
    const inp = el("input");
    inp.type = "number";
    inp.step = "any";
    inp.inputMode = "decimal";
    inp.name = key;
    inp.value = q[key] ?? "";
    inp.oninput = () => {
      const v = inp.value.trim() === "" ? "" : Math.round(Number(inp.value) * 100) / 100;
      q[key] = Number.isFinite(v) ? v : "";
      touch();
      say();
    };
    lab.append(el("span", "small", t(label)), inp);
    return lab;
  };
  const right = num("ans", "Right answer");
  right.classList.add("rightN");
  box.append(num("min", "From"), num("max", "To"), right);
  const unit = el("label", "nfield unit");
  const u = el("input");
  u.maxLength = 20;
  u.name = "unit";
  u.placeholder = t("Unit (optional)");
  u.value = q.unit || "";
  u.oninput = () => { if (u.value.trim()) q.unit = u.value; else delete q.unit; touch(); say(); };
  unit.append(el("span", "small", t("Unit")), u);
  const mrow = el("label", "nfield margin");
  const sel = el("select");
  sel.name = "margin";
  MARGIN_NAME.forEach((n, i) => {
    const o = el("option", "", t(n));
    o.value = i;
    sel.append(o);
  });
  sel.value = q.margin ?? 2;
  sel.onchange = () => { q.margin = Number(sel.value); touch(); say(); };
  mrow.append(el("span", "small", t("Answer margin")), sel);
  box.append(unit, mrow);
  say();
  return [box, hint];
}

// Kahoot's "Points" (help 'How points work'): standard (up to 1000), double (up to 2000) or none
const PTS_NAME = { 1: "Standard points", 2: "Double points", 0: "No points" };
function pointsPicker(q) {
  const row = el("label", "qpts");
  const sel = el("select", "pts");
  for (const v of [1, 2, 0]) {
    const o = el("option", "", t(PTS_NAME[v]));
    o.value = v;
    sel.append(o);
  }
  sel.value = q.pts ?? 1;
  sel.onchange = () => {
    const v = Number(sel.value);
    if (v === 1) delete q.pts;
    else q.pts = v;
    touch();
  };
  row.append(el("span", "small", t("Points")), sel);
  return row;
}
// "Double points" / "No points" on the screens while the question is up; nothing for standard
function ptsTag(pts) {
  return pts === 2 || pts === 0 ? el("span", "ptsTag" + (pts === 2 ? " x2" : ""), t(PTS_NAME[pts])) : null;
}

function problems(q) {
  if (!q.questions.length) return t("Add a question first");
  for (const [i, x] of q.questions.entries()) {
    if (!x.text.trim()) return t("Question {n} has no text", { n: i + 1 });
    if (x.answers && x.answers.filter((a, j) => a.trim() || x.aimg?.[j]).length < 2) return t("Question {n} needs at least 2 answers", { n: i + 1 });
    if (x.kind === "slider") {
      if (![x.min, x.max].every((v) => typeof v === "number") || x.min >= x.max) return t("Question {n}: 'From' must be less than 'To'", { n: i + 1 });
      if (typeof x.ans !== "number") return t("Question {n} needs the right answer", { n: i + 1 });
      if (x.ans < x.min || x.ans > x.max) return t("Question {n}: the right answer must be between 'From' and 'To'", { n: i + 1 });
    }
    if (x.kind === "type" && !x.accept.some((a) => norm(a))) return t("Question {n} needs the right answer", { n: i + 1 });
    if (x.kind === "quiz" && !x.correct.some((j) => x.answers[j]?.trim() || x.aimg?.[j])) return t("Question {n}: tap ✓ on the right answer", { n: i + 1 });
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
  const url = location.origin + BASE + "#r=" + (await packQuiz(editing));
  const pics = editing.questions.some((x) => x.img);
  const title = editing.title || "Ronda";
  if (navigator.share) {
    try { await navigator.share({ title, text: t("A ronda to use or copy: {title}", { title }), url }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast(pics ? t("Link copied, without the pictures. To pass them on too, use Save as file.") : t("Link copied. Anyone who opens it gets their own copy."), pics ? 6000 : 3200);
  } catch {
    downloadFile((title || "ronda") + ".json", await quizFile(editing), "application/json");
  }
};
$("#fileBtn").onclick = async () => {
  putQuiz(editing);
  downloadFile((editing.title || "ronda") + ".json", await quizFile(editing), "application/json");
};

// a picture file -> stored, its key handed to done(); then the editor redraws
async function takePic(file, done) {
  const url = await shrink(file);
  if (!url) return toast(t("That isn't a picture"));
  try { done(await putPic(url)); } catch { return toast(t("This device has no room for more pictures")); }
  touch();
  renderQuestions();
}
function picInput(name, onFile) {
  const input = el("input");
  input.type = "file";
  input.accept = "image/*";
  input.hidden = true;
  input.name = name;
  input.onchange = () => { const f = input.files[0]; input.value = ""; if (f) onFile(f); };
  return input;
}
// an answer that is a picture (like Kahoot's image answers): the words become optional
function answerPic(q, j, inp) {
  const box = el("span", "apic");
  const input = picInput("answerPicFile", (f) => takePic(f, (k) => { q.aimg ||= []; q.aimg[j] = k; }));
  const key = q.aimg?.[j];
  if (key) {
    inp.placeholder = t("Words (optional)");
    const img = el("img", "apicThumb");
    img.alt = t("Picture");
    getPic(key).then((u) => { if (u) img.src = u; });
    const drop = el("button", "apicDrop", "✕");
    drop.title = t("Remove picture");
    drop.name = "dropAnswerPic";
    drop.onclick = () => { q.aimg[j] = null; if (!q.aimg.some(Boolean)) delete q.aimg; touch(); renderQuestions(); };
    box.append(img, drop);
  } else {
    const add = el("button", "apicAdd");
    add.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="10" r="2" fill="currentColor"/><path d="M4 18l5-5 3 3 3-4 5 6z" fill="currentColor"/></svg>';
    add.title = t("Make this answer a picture");
    add.name = "addAnswerPic";
    add.onclick = () => input.click();
    box.append(add);
  }
  box.append(input);
  return box;
}

// the question's picture (like Kahoot's): add (button, drop or paste), see, change, remove
function picEdit(q, card) {
  const box = el("div", "picEdit");
  const set = (file) => takePic(file, (k) => { q.img = k; });
  const input = picInput("picFile", set);
  card.ondragover = (e) => { if ([...e.dataTransfer.items].some((i) => i.kind === "file")) { e.preventDefault(); card.classList.add("drop"); } };
  card.ondragleave = () => card.classList.remove("drop");
  card.ondrop = (e) => { const f = e.dataTransfer.files[0]; card.classList.remove("drop"); if (f) { e.preventDefault(); set(f); } };
  card.onpaste = (e) => { const f = [...e.clipboardData.files].find((x) => /^image\//.test(x.type)); if (f) { e.preventDefault(); set(f); } };
  if (q.img) {
    const img = el("img", "picThumb");
    img.alt = t("Picture");
    getPic(q.img).then((u) => { if (u) img.src = u; else img.replaceWith(el("span", "small hint", t("The picture isn't on this device"))); });
    const change = el("button", "btn chip", t("Change"));
    change.onclick = () => input.click();
    const drop = el("button", "btn chip", t("Remove picture"));
    drop.name = "dropPic";
    drop.onclick = () => { delete q.img; touch(); renderQuestions(); };
    box.append(img, change, drop, input);
  } else {
    const add = el("button", "btn chip addPic", t("+ Picture"));
    add.name = "addPic";
    add.title = t("Shown on the big screen. You can also drop or paste one here.");
    add.onclick = () => input.click();
    box.append(add, input);
  }
  return box;
}

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
    if (here() !== "/edit/" + q.id) go("/edit/" + q.id);
    $("#editMsg").textContent = msg;
    $("#editMsg").hidden = false;
    return;
  }
  const room = await makeRoom();
  if (!room) return toast(t("Couldn't start. Check the internet and try again."));
  const { code, token, at } = room;
  const questions = bare(q.questions).map((x, i) => {
    const aimg = q.questions[i].aimg;
    return aimg && x.answers ? { ...x, answers: x.answers.map((a, j) => (a.trim() ? a : aimg[j] ? PIC_ONLY : a)) } : x;
  });
  const pics = questions.map((x, i) => {
    const src = q.questions[i];
    const a = src.aimg && x.answers ? x.answers.map((v, j) => [v, src.aimg[j] || null]).filter(([v]) => v.trim()).map(([, k]) => k) : null;
    return src.img || a ? { q: src.img || null, a } : null;
  });
  try {
    sessionStorage.setItem(hostKey(code), JSON.stringify({ token, at, quiz: { title: q.title, questions }, pics }));
  } catch {
    // (audit R2-11: this failed without a word) the game still runs in this tab; a reload can't bring it back
    toast(t("This device couldn't keep this ronda. Keep this tab open until the end."));
  }
  go("/host/" + code);
}

// a new room code on the first server that answers: { code, token, at } or null
async function makeRoom() {
  for (const at of SERVERS[1] ? [0, 1] : [0]) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch(SERVERS[at].replace(/^ws/, "http") + "/api/new", { method: "POST", signal: ctl.signal });
      if (!r.ok) throw new Error(r.status);
      const { code, token } = await r.json();
      return { code, token, at };
    } catch {
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// ---------------- live connection (auto-reconnects, two servers) ----------------
// Rooms run on two servers that run the same code (Kleider: "all parts of the app should work even if one the pieces
// break down"): this site's own (Cloudflare) and the game host's (games.jurisgames.com/ronda). A code's digits say
// which one made it (an even sum: the first). When one stops answering, the host's screen moves the game to the
// other and everyone follows.
// Test switches (?server= etc.) take only our own hosts, or addresses that can never connect (.invalid, for failover
// tests): a crafted link can never point the app at somebody else's server (APP-RULES safety 1). This computer
// (localhost) only when the page itself is served from this computer, so a link to the real site can never make it
// talk to something running on the visitor's own machine (safety round 2, J15). The shipped page's CSP has no
// localhost either; the test server adds it (worker/wrangler.test.toml).
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/;
const testHost = (u) => {
  try {
    const x = new URL(u);
    if (!/^(wss?|https?):$/.test(x.protocol)) return null;
    const h = x.hostname;
    // only on a page served from this computer (APP-RULES safety 1; Juntos' audit, N12: on the live page a link could
    // point someone at another of our servers or at nothing)
    if (!LOCAL.test(location.hostname)) return null;
    return LOCAL.test(h) || /(^|\.)jurisgames\.com$/.test(h) || /\.invalid$/.test(h) ? u : null;
  } catch { return null; }
};
const RP = new URLSearchParams(location.search);
const RPG = (k) => (RP.get(k) ? testHost(RP.get(k)) : null);
const OURS = /(^|\.)jurisgames\.com$|\.github\.io$/.test(location.hostname);
const SERVERS = [
  RPG("server") || (location.hostname.endsWith(".github.io") ? "wss://quiz.jurisgames.com" : location.origin.replace(/^http/, "ws")),
  RPG("server2") || (OURS && !RPG("server") ? "wss://games.jurisgames.com/ronda" : null),
];
const sideOf = (code) => [...code].reduce((a, d) => a + Number(d), 0) % 2;
const homeOf = (code) => (SERVERS[1] && sideOf(code) ? 1 : 0);
const otherOf = (at) => (SERVERS[1 - at] ? 1 - at : at);
const LIVE = { opens: 0, drops: 0, moves: 0 }; // for "Send feedback": how often the live link dropped
function connect(code, onOpen, onMsg, { at = homeOf(code), patience = 2 } = {}) {
  let ws, stopped = false, wait = 500, fails = 0;
  const open = () => {
    let opened = false;
    const sock = (ws = new WebSocket(SERVERS[at] + "/ws/" + code));
    const timer = setTimeout(() => { if (!opened) sock.close(); }, 5000);
    sock.onopen = () => { opened = true; clearTimeout(timer); wait = 500; fails = 0; LIVE.opens++; onOpen(at); };
    sock.onmessage = (e) => { if (sock === ws) try { onMsg(JSON.parse(e.data), at); } catch {} };
    sock.onclose = () => {
      clearTimeout(timer);
      if (stopped || sock !== ws) return;
      LIVE.drops++;
      // a server that doesn't answer a few times in a row: the other one
      if (!opened && ++fails >= patience && otherOf(at) !== at) { at = otherOf(at); fails = 0; LIVE.moves++; }
      setTimeout(open, wait);
      wait = Math.min(wait * 2, 4000);
    };
  };
  open();
  return {
    send: (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); },
    stop: () => { stopped = true; try { ws.close(); } catch {} },
    get at() { return at; },
    move: (to) => {
      const old = ws;
      at = to;
      fails = 0;
      wait = 500;
      ws = null;
      try { old.close(); } catch {}
      if (!stopped) open();
    },
  };
}

// the old server is told the game went on elsewhere, as soon as it answers again, so anyone still there follows
function tellMoved(code, from, token, alive) {
  let tries = 0;
  const once = () => {
    if (!alive() || tries++ > 120) return;
    let done = false;
    const w = new WebSocket(SERVERS[from] + "/ws/" + code);
    w.onopen = () => w.send(JSON.stringify({ t: "moved", token }));
    w.onmessage = (e) => {
      try { if (["moved", "gone", "denied"].includes(JSON.parse(e.data).t)) (done = true), w.close(); } catch {}
    };
    w.onclose = () => { if (!done) setTimeout(once, 15000); };
  };
  setTimeout(once, 1000);
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
    playScreen(code, name, (location.hash.match(/^#k=([a-z0-9]{8,40})$/) || [])[1] || "");
  };
  setTimeout(() => $("#nameInput").focus(), 50);
}

// A new secret id for every ronda (APP-RULES safety 3): it is what proves this phone is this player, so it is never
// reused in another ronda. The server keeps only a one-way hash of it (all a host ever sees). Kept 60 days, 100 rondas.
function pidFor(code) {
  let m = {};
  try { m = JSON.parse(safeGet("pids") || "{}") || {}; } catch {}
  if (typeof m !== "object" || Array.isArray(m)) m = {};
  const now = Date.now();
  if (!m[code] || typeof m[code].id !== "string") m[code] = { id: randId(16) };
  m[code].at = now;
  const keep = Object.entries(m).filter(([, v]) => v && now - (v.at || 0) < 60 * 86400000).sort((a, b) => b[1].at - a[1].at).slice(0, 100);
  // (audit R2-11: a phone that can't keep its id starts again as a new person after a reload; it is told once)
  if (!safeSet("pids", JSON.stringify(Object.fromEntries(keep))) && !pidFor.told) {
    pidFor.told = true;
    toast(t("This phone can't save anything right now: if you reload, you join as someone new."));
  }
  return m[code].id;
}
try { localStorage.removeItem("pid"); } catch {} // the old one id for every ronda

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
      if (s) s.textContent = Math.max(0, Math.ceil(Math.min(left, total) / 1000)); // never more than the question's time
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

function playScreen(code, name, key = "") {
  show("play");
  $("#pName").textContent = name;
  $("#pScore").textContent = "";
  const main = $("#pMain");
  main.replaceChildren(el("p", "wait", t("Joining…")));
  let lastKey = "";
  const gone = new Set(); // servers that said they don't have this ronda
  let seen = false; // a view came: "gone" now means it ended, not "no such code"
  live = connect(code, () => live.send({ t: "join", id: pidFor(code), name, k: key }), (m, at) => {
    if (m.t === "moved" && otherOf(at) !== at) return live.move(otherOf(at));
    if (m.t === "gone" && otherOf(at) !== at && !gone.has(otherOf(at))) {
      gone.add(at);
      return live.move(otherOf(at));
    }
    if (m.t === "view") gone.clear(), (seen = true);
    if (m.t === "slow") return endMsg(t("Too many tries from this network. Wait a minute and try again."));
    if (m.t === "gone" && !seen) return endMsg(t("No ronda is running with this code. For an assignment, open the link you were sent."));
    if (m.t === "gone" || m.t === "closed") return endMsg(t("This ronda has ended. Thanks for playing!"));
    if (m.t === "over") return endMsg(t("This ronda has already finished."));
    if (m.t === "full") return endMsg(t("This ronda is full ({max} people)", { max: m.max }));
    if (m.t === "locked") return endMsg(t("The host has locked this ronda"));
    if (m.t === "removed") return endMsg(t("The host removed you from this ronda."));
    if (m.t === "qa") return playerQa(m);
    if (m.t === "qa-full") return toast(t("No more questions can be asked here"));
    if (m.t === "qa-closed") return toast(t("The host closed questions for now"));
    if (m.t !== "view") return;
    $("#pName").textContent = m.name;
    $("#pScore").textContent = m.score || (m.phase !== "lobby" && m.phase !== "question" && scored(m.kind)) ? t("{n} points", { n: m.score || 0 }) : "";
    $("#pTeam").replaceChildren(...(m.team ? [teamDot(m.team.k), m.team.name] : []));
    $("#pTeam").hidden = !m.team;
    // keep a half-typed word when only the count changed
    const key = [m.phase, m.qi, JSON.stringify(m.mine), m.phase === "lobby" ? JSON.stringify([m.teams, m.team?.k]) : "", m.self && m.phase === "end" ? JSON.stringify([m.top, m.rank, m.of]) : ""].join("|");
    if (key === lastKey) return;
    lastKey = key;
    main.replaceChildren(...playerView(m));
    // team talk: the question and its answers show, answering opens when it is over
    if (m.phase === "question" && m.talk && m.readIn > 300) {
      const shut = [...main.querySelectorAll("button, input, select, textarea")].filter((x) => !x.disabled);
      for (const x of shut) x.disabled = true;
      main.classList.add("talking");
      setTimeout(() => {
        if (lastKey !== key) return;
        main.classList.remove("talking");
        for (const x of shut) x.disabled = false;
      }, m.readIn - 300);
    } else main.classList.remove("talking");
  });
  function endMsg(text) {
    closeLive();
    $("#pQa").hidden = $("#pQaBox").hidden = true;
    main.replaceChildren(el("p", "wait", text), homeLink());
  }
  $("#pQa").hidden = $("#pQaBox").hidden = true;
  $("#pQa").onclick = () => { $("#pQaBox").hidden = false; drawPlayerQa(); $("#askForm").ask.focus(); };
  $("#pQaClose").onclick = () => { $("#pQaBox").hidden = true; };
  $("#askForm").onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    const text = f.ask.value.trim();
    if (!text) return f.ask.focus();
    live.send({ t: "ask", text, anon: f.anon.checked });
    f.ask.value = "";
    toast(qa?.mod ? t("Sent. The host will see it first.") : t("Sent"));
  };
  for (const b of document.querySelectorAll("#pQaBox [data-sort]")) b.onclick = () => { qaSort = b.dataset.sort; drawPlayerQa(); };
}

// ---------------- audience questions (like Slido's Q&A) ----------------
let qa = null; // the last list from the server
let qaSort = "top";
const qaVotes = (x) => x.n ?? 0;
// on the screen now first, then waiting for the host, then the rest by votes (or newest), answered last
function qaSorted(list) {
  const rank = { hi: 0, wait: 1, "": 2, done: 3 };
  return [...list].sort((a, b) => rank[a.st] - rank[b.st] || (qaSort === "new" ? 0 : qaVotes(b) - qaVotes(a)) || b.at - a.at);
}
const QA_TAG = { hi: "On the screen now", wait: "Waiting for the host", done: "Answered" };

function playerQa(m) {
  qa = m;
  const open = m.list.filter((x) => x.st !== "done").length;
  $("#pQa").hidden = !m.open && !m.list.length;
  $("#pQa").textContent = open ? t("Questions ({n})", { n: open }) : t("Questions");
  if (!$("#pQaBox").hidden) drawPlayerQa();
}

function drawPlayerQa() {
  if (!qa) return;
  $("#askForm").hidden = !qa.open;
  $("#askClosed").hidden = qa.open;
  for (const b of document.querySelectorAll("#pQaBox [data-sort]")) b.classList.toggle("on", b.dataset.sort === qaSort);
  const ul = $("#pQaList");
  ul.replaceChildren(...qaSorted(qa.list).map((x) => {
    const li = el("li", "qaItem " + (x.st || "live"));
    const body = el("div", "qaBody");
    body.append(el("p", "qaText", x.text));
    const meta = el("p", "qaMeta", x.name || t("Anonymous"));
    if (x.mine) meta.append(el("span", "qaTag", t("Yours")));
    if (QA_TAG[x.st]) meta.append(el("span", "qaTag " + x.st, t(QA_TAG[x.st])));
    body.append(meta);
    const up = el("button", "vote" + (x.me ? " on" : ""), "▲ " + x.n);
    up.name = "vote";
    up.setAttribute("aria-pressed", x.me ? "true" : "false");
    up.setAttribute("aria-label", t("Vote for this question ({n} votes)", { n: x.n }));
    up.disabled = x.st === "wait" || x.st === "done";
    up.onclick = () => live.send({ t: "vote", id: x.id, up: !x.me });
    li.append(body, up);
    return li;
  }));
  if (!qa.list.length) ul.append(el("li", "small qaNone", t("No questions yet. Ask the first one.")));
}

function homeLink() {
  const b = el("button", "btn ghost", t("Back to start"));
  b.dataset.home = "";
  return b;
}

// an assignment's Start / Next question / See your result: the phone moves on by itself (no big screen)
function goBtn(m, label) {
  const b = el("button", "btn primary big goBtn", label);
  b.onclick = () => { b.disabled = true; live.send({ t: "go", qi: m.qi ?? -1 }); };
  return b;
}

function playerView(m) {
  const out = [];
  if (m.self && m.phase === "intro") {
    out.push(el("h2", "ptext", m.title || "Ronda"), el("p", "wait", t("{n} questions", { n: m.n })),
      el("p", "wait", t("Answer by {when}", { when: fmtWhen(m.until) })), goBtn(m, t("Start")));
    return out;
  }
  if (m.self && m.phase === "end") {
    out.push(el("p", "big-ok", m.done ? t("Finished!") : t("The time to answer is over")));
    if (m.quizzy) {
      out.push(el("p", "place", t("{rank} of {of}", { rank: ordinal(m.rank), of: m.of })),
        el("p", "wait", t("{r} of {n} right · {p} points", { r: m.right, n: m.of2, p: m.score })));
      if (m.top) {
        const ol = el("ol", "top5");
        for (const [name, score] of m.top) {
          const li = el("li", name === m.name ? "me" : "");
          li.append(el("span", "", name), el("b", "", String(score)));
          ol.append(li);
        }
        out.push(ol);
      }
    } else out.push(el("p", "wait", t("Thanks for taking part")));
    out.push(homeLink());
    return out;
  }
  if (m.phase === "lobby") {
    out.push(el("p", "big-ok", t("You're in!")), el("p", "wait", t("Look at the screen. It starts soon.")));
    if (m.teams) {
      out.push(el("p", "place", t("Your team")));
      const row = el("div", "teamPick");
      m.teams.forEach((name, k) => {
        const b = el("button", "btn tpick");
        b.append(teamDot(k), name);
        b.setAttribute("aria-pressed", String(m.team?.k === k));
        b.onclick = () => live.send({ t: "team", team: k });
        row.append(b);
      });
      out.push(row);
    }
    return out;
  }
  if (m.phase === "end") {
    out.push(el("p", "big-ok", t("Finished!")));
    if (m.quizzy && m.team) out.push(el("p", "place", t("{team}: {rank} of {of}", { team: m.team.name, rank: ordinal(m.rank), of: m.of })));
    else if (m.quizzy) out.push(el("p", "place", t("{rank} of {of}", { rank: ordinal(m.rank), of: m.of })));
    else out.push(el("p", "wait", t("Thanks for taking part")));
    out.push(homeLink());
    return out;
  }
  const prog = el("p", "progress", t("Question {i} of {n}", { i: m.qi + 1, n: m.n }));
  const tag = scored(m.kind) ? ptsTag(m.pts) : null;
  if (tag) prog.append(" ", tag);
  out.push(prog);
  out.push(el("h2", "ptext", m.text));
  if (m.phase === "question" && m.talk && m.readIn > 300) out.push(el("p", "talkNote", t("Team talk: decide together")));
  if (m.phase === "question") {
    if (m.endsIn) {
      const tb = timerBar();
      out.push(tb);
      // an assignment: when the time is up the phone says so and the answer shows
      requestAnimationFrame(() => countdown(tb, m.endsIn, m.readIn, m.self ? () => live.send({ t: "go", qi: m.qi }) : null));
    }
    if (m.kind === "quiz" || m.kind === "poll") {
      if (m.mine != null) {
        out.push(chosen(m.answers, m.mine), el("p", "wait", t("Sent. Wait for the others.")));
      } else {
        const grid = el("div", "pAnswers n" + m.answers.length);
        m.answers.forEach((a, j) => {
          const b = el("button", "pa c" + j);
          b.append(el("span", "letter", LETTERS[j]), el("span", "atext", aText(a)));
          b.onclick = () => { for (const x of grid.children) x.disabled = true; b.classList.add("picked"); live.send({ t: "answer", qi: m.qi, v: j }); };
          grid.append(b);
        });
        out.push(grid);
      }
    } else if (m.kind === "type") {
      if (m.mine != null) out.push(el("p", "typed", m.mine), el("p", "wait", t("Sent. Wait for the others.")));
      else {
        const f = el("form", "wordForm");
        const inp = el("input");
        inp.maxLength = 60;
        inp.name = "typed";
        inp.placeholder = t("Type your answer");
        inp.autocomplete = "off";
        inp.setAttribute("autocapitalize", "off");
        f.append(inp, el("button", "btn primary", t("Send")));
        f.onsubmit = (e) => {
          e.preventDefault();
          if (!inp.value.trim()) return;
          for (const x of f.elements) x.disabled = true;
          live.send({ t: "answer", qi: m.qi, v: inp.value });
        };
        out.push(f);
        setTimeout(() => inp.focus(), 50);
      }
    } else if (m.kind === "order") {
      if (m.mine != null) out.push(orderList(m.answers, m.mine), el("p", "wait", t("Sent. Wait for the others.")));
      else out.push(...orderPicker(m));
    } else if (m.kind === "slider") {
      const r = m.range;
      if (m.mine != null) out.push(el("p", "typed", fmtNum(m.mine, r.dec, r.unit)), el("p", "wait", t("Sent. Wait for the others.")));
      else out.push(sliderPick(m));
    } else if (m.kind === "scale") {
      if (m.mine != null) out.push(el("p", "wait", t("Sent. You can change it until the results.")));
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
      } else out.push(el("p", "wait", t("Sent.")));
      if (m.self) out.push(goBtn(m, mine.length ? t("Next") : t("Skip")));
    }
    return out;
  }
  // reveal / board
  if (scored(m.kind)) {
    if (m.mine == null) out.push(el("p", "big-no", t("No answer this time")));
    else if (m.right) {
      out.push(el("p", "big-ok", t("Right!")));
      if (m.pts !== 0) out.push(el("p", "gain", "+" + m.gained));
      if (m.streak >= 2) out.push(el("p", "streak", "🔥 " + t("Answer streak {n}", { n: m.streak })));
    } else out.push(el("p", "big-no", t("Not this time")));
    if (m.kind === "quiz" && m.answers && !m.right) {
      if (m.mine != null) out.push(el("p", "said", t("You said {a}", { a: withLetter(m.answers, m.mine) })));
      const right = m.correct.map((j) => withLetter(m.answers, j)).join(" · ");
      out.push(el("p", "wait", t("Right answer: {a}", { a: right })));
    }
    if (m.kind === "slider" && m.range) {
      const r = m.range;
      out.push(el("p", "wait", t("Right answer: {a}", { a: fmtNum(m.correct, r.dec, r.unit) })));
      if (m.mine != null && m.mine !== m.correct) {
        out.push(el("p", "said", t("You said {a} ({d} off)", { a: fmtNum(m.mine, r.dec, r.unit), d: fmtNum(Math.abs(m.mine - m.correct), r.dec) })));
      }
    }
    if (m.kind === "type" && m.correct && !m.right) out.push(el("p", "wait", t("Right answer: {a}", { a: m.correct[0] })));
    if (m.kind === "order" && m.answers) out.push(el("p", "wait", t("The right order:")), orderList(m.answers, m.answers.map((_, i) => i)));
    if (m.team) {
      if (m.pts !== 0) out.push(el("p", "wait", t("Your team +{n}", { n: m.team.gained })));
      out.push(el("p", "place", t("{team} is {rank}", { team: m.team.name, rank: ordinal(m.rank) })));
    } else out.push(el("p", "place", t("You're {rank}", { rank: ordinal(m.rank) })));
  } else {
    out.push(el("p", "big-ok", t("Thanks!")));
    if (!m.self) out.push(el("p", "wait", t("Look at the screen for the results.")));
  }
  if (m.self) out.push(goBtn(m, m.last ? t("See your result") : t("Next question")));
  return out;
}

// "Put in order": tap the items in the order they go; tap a numbered one to take it (and the ones after it) back
function orderPicker(m) {
  const n = m.answers.length;
  const shown = m.shuf && m.shuf.length === n ? m.shuf : m.answers.map((_, i) => i);
  const picked = [];
  const grid = el("div", "pAnswers order n" + n);
  const send = el("button", "btn primary wide", t("Send"));
  send.name = "sendOrder";
  const hint = el("p", "wait", t("Tap them in the right order"));
  const paint = () => {
    for (const b of grid.children) {
      const k = picked.indexOf(Number(b.dataset.i));
      b.classList.toggle("picked", k >= 0);
      b.querySelector(".letter").textContent = k >= 0 ? String(k + 1) : "";
    }
    send.hidden = picked.length !== n;
  };
  shown.forEach((i, j) => {
    const b = el("button", "pa c" + j);
    b.dataset.i = i;
    b.append(el("span", "letter", ""), el("span", "atext", m.answers[i]));
    b.onclick = () => {
      const k = picked.indexOf(i);
      if (k >= 0) picked.splice(k);
      else picked.push(i);
      paint();
    };
    grid.append(b);
  });
  send.onclick = () => {
    if (picked.length !== n) return;
    send.disabled = true;
    for (const x of grid.children) x.disabled = true;
    live.send({ t: "answer", qi: m.qi, v: [...picked] });
  };
  paint();
  return [hint, grid, send];
}

function orderList(answers, seq) {
  const ol = el("ol", "orderList");
  for (const i of seq) ol.append(el("li", "", answers[i]));
  return ol;
}

// the phone's slider: starts in the middle; drag it, or − / + (and the keyboard's arrows and page keys) for one step
function sliderPick(m) {
  const r = m.range;
  const step = 10 ** -r.dec;
  const snap = (v) => Math.min(r.max, Math.max(r.min, Math.round(v / step) * step));
  const box = el("div", "slide");
  const val = el("output", "sval");
  const range = el("input");
  range.type = "range";
  range.name = "slider";
  range.min = r.min;
  range.max = r.max;
  range.step = step;
  range.value = snap((r.min + r.max) / 2);
  range.setAttribute("aria-label", t("Your answer"));
  const show = () => {
    val.textContent = fmtNum(Number(range.value), r.dec, r.unit, true); // fixed decimals: the number does not jump while sliding
    range.style.setProperty("--p", (Number(range.value) - r.min) / (r.max - r.min));
  };
  range.oninput = show;
  const nudge = (d) => { range.value = snap(Number(range.value) + d * step); show(); };
  const less = el("button", "nudge", "−");
  less.type = "button";
  less.setAttribute("aria-label", t("Less"));
  less.onclick = () => nudge(-1);
  const more = el("button", "nudge", "+");
  more.type = "button";
  more.setAttribute("aria-label", t("More"));
  more.onclick = () => nudge(1);
  const row = el("div", "srow");
  row.append(less, range, more);
  const ends = el("div", "scaleEnds small");
  ends.append(el("span", "", fmtNum(r.min, r.dec, r.unit)), el("span", "", fmtNum(r.max, r.dec, r.unit)));
  const send = el("button", "btn primary", t("Send"));
  send.onclick = () => {
    for (const x of box.querySelectorAll("button, input")) x.disabled = true;
    live.send({ t: "answer", qi: m.qi, v: snap(Number(range.value)) });
  };
  box.append(val, row, ends, send);
  show();
  return box;
}

function chosen(answers, j) {
  const b = el("div", "pa c" + j + " picked solo");
  b.append(el("span", "letter", LETTERS[j]), el("span", "atext", aText(answers[j])));
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
  try { saved = JSON.parse((sessionStorage.getItem(hostKey(code)) ?? sessionStorage.getItem("host:" + code))); } catch {}
  if (!saved) { toast(t("This screen isn't hosting that ronda")); return go("/", true); }
  show("host");
  keepAwake();
  hostPics = saved.pics || [];
  // pictures are drawn without waiting (results redraw often): load them all first, then redraw once
  Promise.all(hostPics.flatMap((x) => [x?.q, ...(x?.a || [])]).filter(isPic).map(async (k) => hostUrls.set(k, await getPic(k))))
    .then(() => { if (st && live) renderHost(code, st, true); });
  const main = $("#hMain");
  main.replaceChildren(el("p", "wait", t("Opening the room…")));
  let st = null;
  let lastKey = "";
  // the copy of the game this screen keeps: enough to carry on on the other server
  const snap = saved.snap || { quiz: saved.quiz, phase: "lobby", qi: -1, players: [], log: [] };
  let keepTimer = 0;
  const keep = () => {
    if (keepTimer) return;
    keepTimer = setTimeout(() => {
      keepTimer = 0;
      try { sessionStorage.setItem(hostKey(code), JSON.stringify({ ...saved, snap })); } catch {}
    }, 1500);
  };
  const resume = (at) => {
    const from = saved.at ?? homeOf(code);
    saved.at = at;
    keep();
    live.send({ t: "resume", token: saved.token, snap });
    if (from !== at) {
      const mine = live;
      tellMoved(code, from, saved.token, () => live === mine);
    }
  };
  const first = saved.at ?? homeOf(code);
  live = connect(code, (at) => {
    if (at === (saved.at ?? first)) live.send({ t: "host", token: saved.token });
    else resume(at);
  }, (m, at) => {
    // this server lost the ronda (or never had it): it carries on from the copy
    if (m.t === "gone" && snap.quiz) return resume(at);
    if (m.t === "moved") return;
    // this server can't keep the game any more (its day's writes are used up): it goes on on the other one
    if (m.t === "savefail" && otherOf(at) !== at && !live.saveMoved) { live.saveMoved = true; saved.at = otherOf(at); keep(); return live.move(otherOf(at)); }
    // the other server would not take the game (no proof it is ours): never lose it, wait for its own server
    if (m.t === "denied" && at !== homeOf(code)) { saved.at = homeOf(code); keep(); return live.move(homeOf(code)); }
    if (m.t === "denied" || m.t === "gone") { toast(t("This ronda has ended")); sessionStorage.removeItem(hostKey(code)); return go("/", true); }
    if (m.t === "bad-quiz") { toast(t("Something in this ronda can't be used")); return go("/", true); }
    if (m.t === "export") return Date.now() - askedExport < 30000 && ((askedExport = 0), saveResults(m));
    if (m.t === "closed") { sessionStorage.removeItem(hostKey(code)); return go("/", true); }
    if (m.t === "qa") {
      snap.qa = { open: m.open, mod: m.mod, list: m.list };
      keep();
      return hostQa(m);
    }
    if (m.t !== "host") return;
    if (m.sameQuiz) m.quiz = snap.quiz; // the server sends the quiz once
    if (!m.quiz) return live.send({ t: "load", quiz: saved.quiz });
    Object.assign(snap, { quiz: m.quiz, phase: m.phase, qi: m.qi, boardShown: m.boardShown, shuf: m.shuf || undefined, locked: !!m.locked });
    snap.players = [...m.players, ...(m.out || []).map((id) => ({ id, out: true }))];
    snap.teams = m.teams || null;
    if (m.logq && m.qi >= 0) snap.log[m.qi] = m.logq;
    keep();
    st = m;
    const key = [m.phase, m.qi].join("|");
    renderHost(code, m, key !== lastKey);
    lastKey = key;
  }, { at: first, patience: 3 });
  live.host = true;
  let askedExport = 0;
  $("#hNext").onclick = () => {
    if (!st) return;
    if (st.phase === "end") return (askedExport = Date.now()), live.send({ t: "export" });
    if (st.phase === "lobby" && !st.players.length) return toast(t("Wait for people to join first"));
    live.send({ t: "next" });
  };
  $("#hFull").onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  };
  $("#hFull").hidden = !document.documentElement.requestFullscreen;
  qa = snap.qa || null;
  $("#hQaPanel").hidden = $("#hQaShow").hidden = true;
  $("#hQa").textContent = t("Questions");
  $("#hQa").onclick = () => { $("#hQaPanel").hidden = !$("#hQaPanel").hidden; drawHostQa(); };
  $("#hQaClose").onclick = () => { $("#hQaPanel").hidden = true; };
  $("#qaOpen").onchange = (e) => live.send({ t: "qa", do: e.target.checked ? "open" : "close" });
  $("#qaMod").onchange = (e) => live.send({ t: "qa", do: e.target.checked ? "mod" : "nomod" });
  for (const b of document.querySelectorAll("#hQaPanel [data-sort]")) b.onclick = () => { qaSort = b.dataset.sort; drawHostQa(); };
  for (const b of document.querySelectorAll("#hQaShow [data-do]")) b.onclick = () => {
    const hi = qa?.list.find((x) => x.st === "hi");
    if (hi) live.send({ t: "qa", do: b.dataset.do, id: hi.id });
  };
  $("#qaSave").onclick = () => saveQuestions(snap.quiz?.title);
}

function hostQa(m) {
  qa = m;
  const waiting = m.list.filter((x) => x.st === "wait").length;
  const open = m.list.filter((x) => x.st !== "done").length;
  $("#hQa").textContent = waiting ? t("Questions ({n} to approve)", { n: waiting }) : open ? t("Questions ({n})", { n: open }) : t("Questions");
  $("#hQa").classList.toggle("ping", waiting > 0);
  const hi = m.list.find((x) => x.st === "hi");
  const show = $("#hQaShow");
  show.hidden = !hi;
  if (hi) {
    show.querySelector(".qaWho").textContent = hi.name ? t("{name} asks", { name: hi.name }) : t("Someone asks");
    show.querySelector(".qaBig").textContent = hi.text;
    show.querySelector(".qaVotes").textContent = (qaVotes(hi) === 1 ? t("1 vote") : t("{n} votes", { n: qaVotes(hi) }));
  }
  drawHostQa();
}

function drawHostQa() {
  if (!qa || $("#hQaPanel").hidden) return;
  $("#qaOpen").checked = qa.open;
  $("#qaMod").checked = qa.mod;
  for (const b of document.querySelectorAll("#hQaPanel [data-sort]")) b.classList.toggle("on", b.dataset.sort === qaSort);
  const act = (label, d, x, cls = "btn chip dim") => {
    const b = el("button", cls, t(label));
    b.name = d;
    b.onclick = () => {
      live.send({ t: "qa", do: d, id: x.id });
      if (d === "show") $("#hQaPanel").hidden = true; // the room sees the question, not the list
    };
    return b;
  };
  const ul = $("#hQaList");
  ul.replaceChildren(...qaSorted(qa.list).map((x) => {
    const li = el("li", "qaItem " + (x.st || "live"));
    const body = el("div", "qaBody");
    body.append(el("p", "qaText", x.text));
    const meta = el("p", "qaMeta", (x.name || t("Anonymous")) + " · ▲ " + qaVotes(x));
    if (QA_TAG[x.st]) meta.append(el("span", "qaTag " + x.st, t(QA_TAG[x.st])));
    const btns = el("div", "qaBtns");
    if (x.st === "wait") btns.append(act("Approve", "ok", x, "btn chip"));
    if (x.st === "" || x.st === "wait") btns.append(act("Show on screen", "show", x, "btn primary"));
    if (x.st === "hi") btns.append(act("Hide", "hide", x));
    if (x.st === "hi" || x.st === "") btns.append(act("Answered", "done", x));
    if (x.st === "done") btns.append(act("Not answered", "undone", x));
    btns.append(act("Delete", "del", x, "btn chip dim danger-text"));
    body.append(meta, btns);
    li.append(body);
    return li;
  }));
  if (!qa.list.length) ul.append(el("li", "small qaNone", qa.open ? t("No questions yet. People ask from their phones, with the Questions button.") : t("Questions are closed.")));
}

function saveQuestions(title) {
  if (!qa?.list.length) return toast(t("No questions yet"));
  const status = { "": "", wait: t("Waiting for the host"), hi: t("On the screen now"), done: t("Answered") };
  const rows = [[t("Question"), t("Asked by"), t("Votes"), t("Status")],
    ...qaSorted(qa.list).map((x) => [x.text, x.name || t("Anonymous"), qaVotes(x), status[x.st]])];
  const csv = "\ufeff" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  downloadFile((title || "Ronda") + " - " + t("questions") + ".csv", csv, "text/csv");
  toast(t("Questions saved to your downloads"));
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

let hostPics = [];
const hostUrls = new Map();
function renderHost(code, m, fresh) {
  const main = $("#hMain");
  const qs = m.quiz.questions;
  const q = m.qi >= 0 ? qs[m.qi] : null;
  const next = $("#hNext");
  const active = m.players.length;
  $("#hInfo").textContent = m.phase === "lobby" ? "" : t("Code {code}", { code: fmtCode(code) }) + " · " + t("{n} people", { n: active });
  // the lock is there all game long, not only in the lobby (audit R2-6)
  if (m.phase !== "lobby" && m.phase !== "end") {
    const lk = el("button", "btn ghost small lockBtn", m.locked ? t("Unlock: let new people join") : t("Lock: nobody new can join"));
    lk.onclick = () => live.send({ t: "lock", on: !m.locked });
    $("#hInfo").append(" · ", lk);
  }

  if (m.phase === "lobby") {
    next.textContent = t("Start");
    if (fresh || !main.querySelector(".lobbyHost")) {
      const wrap = el("div", "lobbyHost");
      const left = el("div", "joinInfo");
      left.append(el("h1", "htitle", m.quiz.title));
      left.append(el("p", "joinAt", t("Join at {site} with the code", { site: location.host + BASE.replace(/\/$/, "") })));
      left.append(el("p", "bigCode", fmtCode(code)));

      const qrBox = el("div", "qrBox");
      if (window.qrcode) qrBox.append(qr(location.origin + BASE + code), el("p", "small", t("or scan this with the phone camera")));
      wrap.append(left, qrBox);
      const people = el("div", "people");
      const lock = el("button", "btn ghost lockBtn");
      lock.onclick = () => live.send({ t: "lock", on: lock.dataset.on !== "1" });
      // a flood of made-up names goes in one tap pair (audit R2-7); shown only when someone joined in the last minute
      const recent = el("button", "btn ghost recentBtn", t("Remove everyone who joined in the last minute"));
      recent.onclick = () => {
        if (recent.dataset.armed) return live.send({ t: "remove-recent" });
        recent.dataset.armed = "1";
        recent.textContent = t("Remove the {n} who joined in the last minute?", { n: recent.dataset.n || "" });
        setTimeout(() => { if (recent.isConnected) { delete recent.dataset.armed; recent.textContent = t("Remove everyone who joined in the last minute"); } }, 3000);
      };
      main.replaceChildren(wrap, el("p", "count"), lock, recent, people);
    }
    const lockB = main.querySelector(".lockBtn");
    lockB.dataset.on = m.locked ? "1" : "";
    lockB.textContent = m.locked ? t("Unlock: let new people join") : t("Lock: nobody new can join");
    const recentB = main.querySelector(".recentBtn");
    const nRecent = m.players.filter((p) => p.recent).length;
    recentB.hidden = nRecent < 2;
    recentB.dataset.n = String(nRecent);
    main.querySelector(".count").textContent = !active ? t("Waiting for people…")
      : m.teams ? t("{n} people are in. Tap a name to move it to another team or remove it.", { n: active })
      : t("{n} people are in. Tap a name to remove it.", { n: active });
    teamBar(main, m);
    const people = main.querySelector(".people");
    if (m.teams) return teamColumns(people, m);
    people.classList.remove("teams");
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
    if (qs.some((x) => scored(x.kind)) && m.players.length) {
      const pod = el("div", "podium");
      const top = m.teamRank ? m.teamRank.filter((x) => x.n) : m.players;
      [1, 0, 2].forEach((k) => {
        const p = top[k];
        if (!p) return;
        const col = el("div", "step s" + (k + 1));
        const nm = el("span", "pname");
        if (m.teamRank) nm.append(teamDot(p.k), " ");
        nm.append(p.name);
        col.append(nm, el("span", "ppts", t("{n} points", { n: p.score })), el("span", "pplace", String(k + 1)));
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
    wrap.append(el("h2", "htext", m.teamRank ? t("Teams") : t("Top 5")));
    const ol = el("ol", "top" + (m.teamRank ? " teamsTop" : ""));
    if (m.teamRank) {
      for (const x of m.teamRank.filter((x) => x.n)) {
        const li = el("li");
        const nm = el("span", "nm");
        nm.append(teamDot(x.k), " ", x.name);
        li.append(nm, el("span", "tgain", x.gained ? "+" + x.gained : ""), el("b", "", String(x.score)));
        ol.append(li);
      }
    } else for (const p of m.players.slice(0, 5)) {
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
  next.textContent = asking ? t("Show results") : scored(q.kind) ? t("Ranking") : m.qi >= qs.length - 1 ? t("Finish") : t("Next question");
  if (fresh) {
    const wrap = el("div", "qHost");
    const top = el("div", "qtop");
    const prog = el("span", "progress", t("Question {i} of {n}", { i: m.qi + 1, n: qs.length }));
    const tag = scored(q.kind) ? ptsTag(q.pts ?? 1) : null;
    if (tag) prog.append(" ", tag);
    top.append(prog, el("span", "answered"));
    wrap.append(top, el("h1", "htext", q.text));
    const qpic = hostUrls.get(hostPics[m.qi]?.q);
    if (qpic) {
      const img = el("img", "qimg");
      img.alt = "";
      img.src = qpic;
      wrap.append(img);
    }
    if (asking && m.talk && m.readIn > 300) {
      const note = el("p", "talkNote", t("Team talk: decide together"));
      wrap.append(note);
      setTimeout(() => note.remove(), m.readIn);
    }
    if (asking && m.endsIn) {
      const tb = timerBar();
      wrap.append(tb);
      requestAnimationFrame(() => countdown(tb, m.endsIn, m.readIn, () => live?.send({ t: "reveal" })));
    }
    wrap.append(el("div", "res"));
    main.replaceChildren(wrap);
  }
  main.querySelector(".answered").textContent = asking ? t("{a} of {n} answered", { a: m.answered, n: active }) : "";
  const res = main.querySelector(".res");
  res.replaceChildren(...hostResults(q, m, asking));
}

// the lobby's team switch: teams on or off, how many, team talk (Kahoot turns it on by itself)
function teamBar(main, m) {
  let bar = main.querySelector(".teamBar");
  if (!bar) {
    bar = el("div", "teamBar");
    const on = el("label", "tsw");
    const box = el("input");
    box.type = "checkbox";
    box.id = "teamsOn";
    on.append(box, " " + t("Play in teams"));
    const minus = el("button", "btn chip dim tminus", "−");
    const n = el("b", "tn");
    const plus = el("button", "btn chip dim tplus", "+");
    const talk = el("label", "tsw talkSw");
    const tb = el("input");
    tb.type = "checkbox";
    tb.id = "talkOn";
    talk.append(tb, " " + t("Team talk (5 s to decide together)"));
    const count = el("span", "tcount");
    count.append(minus, n, plus, " " + t("teams"));
    bar.append(on, count, talk);
    main.querySelector(".count").before(bar);
    const names = () => TEAM_NAMES.map((x) => t(x));
    const cur = () => bar.m;
    const send = (over) => {
      const x = cur().teams;
      live.send({ t: "teams", on: true, n: x ? x.names.length : 3, talk: x ? x.talk : true, names: names(), ...over });
    };
    box.onchange = () => (box.checked ? send({}) : live.send({ t: "teams", on: false }));
    minus.onclick = () => send({ n: Math.max(2, cur().teams.names.length - 1) });
    plus.onclick = () => send({ n: Math.min(MAX_TEAMS, cur().teams.names.length + 1) });
    tb.onchange = () => send({ talk: tb.checked });
  }
  bar.m = m;
  const x = m.teams;
  bar.querySelector("#teamsOn").checked = !!x;
  bar.querySelector(".tcount").hidden = bar.querySelector(".talkSw").hidden = !x;
  if (x) {
    bar.querySelector(".tn").textContent = String(x.names.length);
    bar.querySelector(".tminus").disabled = x.names.length <= 2;
    bar.querySelector(".tplus").disabled = x.names.length >= MAX_TEAMS;
    bar.querySelector("#talkOn").checked = x.talk;
  }
}

let teamSel = ""; // the person picked to move (host lobby)
function teamColumns(people, m) {
  const x = m.teams;
  people.classList.add("teams");
  const grid = el("div", "teamGrid");
  if (!m.players.some((p) => p.id === teamSel)) teamSel = "";
  x.names.forEach((name, k) => {
    const col = el("div", "teamCol");
    col.style.setProperty("--tc", TEAM_COLORS[k]);
    const head = el("div", "teamHead");
    const inp = el("input", "tname");
    inp.value = name;
    inp.maxLength = 20;
    inp.setAttribute("aria-label", t("Team name"));
    inp.onchange = () => { if (inp.value.trim()) live.send({ t: "rename", k, name: inp.value.trim() }); else inp.value = name; };
    inp.onkeydown = (e) => { if (e.key === "Enter") inp.blur(); };
    const members = m.players.filter((p) => p.team === k);
    head.append(inp, el("span", "tsize", String(members.length)));
    col.append(head);
    const sel = m.players.find((p) => p.id === teamSel);
    if (sel && sel.team !== k) {
      const mv = el("button", "btn chip moveHere", t("Move {name} here", { name: sel.name }));
      mv.onclick = () => { teamSel = ""; live.send({ t: "move", id: sel.id, team: k }); };
      col.append(mv);
    }
    for (const p of members) {
      const b = el("button", "who" + (p.id === teamSel ? " sel" : ""), p.name);
      b.onclick = () => { teamSel = teamSel === p.id ? "" : p.id; teamColumns(people, m); };
      col.append(b);
      if (p.id === teamSel) {
        const rm = el("button", "btn chip dim rmWho", t("Remove {name}", { name: p.name }));
        rm.onclick = () => { teamSel = ""; live.send({ t: "remove", id: p.id }); };
        col.append(rm);
      }
    }
    grid.append(col);
  });
  // a name being typed is kept while others join
  const typing = people.querySelector(".tname:focus");
  if (typing) {
    const k = [...people.querySelectorAll(".tname")].indexOf(typing);
    const fresh = grid.querySelectorAll(".tname")[k];
    if (fresh) { fresh.value = typing.value; grid.querySelectorAll(".tname")[k].replaceWith(typing); }
  }
  people.replaceChildren(grid);
}

function hostResults(q, m, asking) {
  const r = m.results;
  if (q.kind === "quiz" || q.kind === "poll") {
    const total = r ? Math.max(1, ...r.counts) : 1;
    const apics = (hostPics[m.qi]?.a || []).map((k) => hostUrls.get(k) || null);
    const grid = el("div", "hAnswers n" + q.answers.length + (apics.some(Boolean) ? " pics" : ""));
    q.answers.forEach((a, j) => {
      const right = !asking && q.kind === "quiz" && q.correct.includes(j);
      const wrong = !asking && q.kind === "quiz" && !right;
      const b = el("div", "ha c" + j + (right ? " right" : "") + (wrong ? " faded" : ""));
      b.append(el("span", "letter", LETTERS[j]));
      if (apics[j]) {
        const img = el("img", "aimg");
        img.alt = a === PIC_ONLY ? t("Picture {l}", { l: LETTERS[j] }) : a;
        img.src = apics[j];
        b.append(img);
      }
      b.append(el("span", "atext", a === PIC_ONLY && apics[j] ? "" : a));
      if (r) {
        b.style.setProperty("--w", r.counts[j] / total);
        b.append(el("span", "cnt", String(r.counts[j])));
      }
      if (right) b.append(el("span", "tick", "✓"));
      grid.append(b);
    });
    return [grid];
  }
  if (q.kind === "type") {
    if (asking) return [el("p", "typeAsk", t("Type your answer on your phone"))];
    const box = el("div", "typeRes");
    box.append(el("p", "typeRight", q.accept[0]));
    if (q.accept.length > 1) box.append(el("p", "small", t("Also counted: {a}", { a: q.accept.slice(1).join(", ") })));
    box.append(el("p", "avg", t("{r} of {n} got it right", { r: r?.right || 0, n: r?.total || 0 })));
    const list = el("div", "typed");
    for (const [w, c, ok] of r?.top || []) {
      const s = el("span", "chip" + (ok ? " ok" : ""), w + " · " + c);
      list.append(s);
    }
    box.append(list);
    return [box];
  }
  if (q.kind === "order") {
    const seq = asking ? m.shuf || q.answers.map((_, i) => i) : q.answers.map((_, i) => i);
    const grid = el("div", "hAnswers order n" + q.answers.length);
    seq.forEach((i, j) => {
      const b = el("div", "ha c" + j + (asking ? "" : " right"));
      b.append(el("span", "letter", asking ? "" : String(i + 1)), el("span", "atext", q.answers[i]));
      grid.append(b);
    });
    const out = [grid];
    if (!asking) out.unshift(el("p", "avg", t("{r} of {n} got the order right", { r: r?.right || 0, n: r?.total || 0 })));
    return out;
  }
  if (q.kind === "slider") return [sliderRes(q, r, asking)];
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
    const ends = el("div", "scaleEnds");
    ends.append(el("span", "", t("Not at all")), el("span", "", t("A lot")));
    box.append(el("p", "avg", r?.avg != null ? t("Average {v}", { v: r.avg.toFixed(1).replace(".", LANG === "es" ? "," : ".") }) : t("Waiting for answers…")), el("div", "barsWrap"));
    box.lastChild.append(bars, ends);
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
// the big screen's slider: while asking, the empty scale; then every guess as a dot, the right number sliding into
// place (like Kahoot's reveal) and the part that got points shaded
function sliderRes(q, r, asking) {
  const dec = q.dec ?? Math.max(...[q.min, q.max, q.ans].map((v) => (String(v).split(".")[1] || "").length));
  const at = (v) => ((v - q.min) / (q.max - q.min)) * 100 + "%";
  const box = el("div", "slideRes");
  if (asking) box.append(el("p", "typeAsk", t("Move the slider on your phone")));
  else {
    box.append(el("p", "typeRight", fmtNum(q.ans, dec, q.unit)));
    const n = r?.total || 0;
    box.append(el("p", "avg", (q.margin ?? 2) === 0 ? t("{r} of {n} got it exactly", { r: r?.right || 0, n }) : t("{r} of {n} got close enough", { r: r?.right || 0, n })));
    if (r?.avg != null) box.append(el("p", "small", t("Average guess: {v}", { v: fmtNum(r.avg, Math.min(2, dec + 1), q.unit) })));
  }
  const track = el("div", "track");
  if (!asking) {
    const tol = sliderTol(q);
    if (tol) {
      const band = el("div", "band");
      band.style.left = at(Math.max(q.min, q.ans - tol));
      band.style.right = (100 - parseFloat(at(Math.min(q.max, q.ans + tol)))) + "%";
      track.append(band);
    }
    // a dot per guess; the same spot stacks upwards
    const seen = new Map();
    for (const v of r?.vals || []) {
      const k = Math.round(((v - q.min) / (q.max - q.min)) * 100);
      const h = seen.get(k) || 0;
      seen.set(k, h + 1);
      const d = el("span", "dot" + (isRight(q, v) ? " ok" : ""));
      d.style.left = at(v);
      d.style.setProperty("--h", Math.min(h, 8));
      track.append(d);
    }
    const mark = el("span", "mark");
    mark.style.setProperty("--to", at(q.ans));
    track.append(mark);
  }
  const ends = el("div", "scaleEnds");
  ends.append(el("span", "", fmtNum(q.min, dec, q.unit)), el("span", "", fmtNum(q.max, dec, q.unit)));
  const wrap = el("div", "trackWrap");
  wrap.append(track, ends);
  box.append(wrap);
  return box;
}

function hash(s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return h; }

function csvCell(v) {
  let s = String(v).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  // anything but a number that starts like a formula stays text ("=HYPERLINK(...)" as a name, or a one-item list),
  // also after leading spaces or control characters (APP-RULES 70)
  if (typeof v !== "number" && /^[=+\-@]/.test(s.replace(/^[\s\x00-\x1f]+/, ""))) s = "'" + s;
  return /[",\r\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function saveResults(m) {
  const qs = m.quiz.questions;
  const esc = csvCell;
  const tm = m.teams;
  const rows = [[t("Name"), ...(tm ? [t("Team")] : []), t("Points"), ...qs.map((q, i) => (i + 1) + ". " + q.text)]];
  const ranked = Object.entries(m.players).filter(([, p]) => !p.out).sort((a, b) => b[1].score - a[1].score);
  for (const [id, p] of ranked) {
    rows.push([p.name, ...(tm ? [tm.names[p.team] ?? ""] : []), p.score, ...qs.map((q, i) => {
      const v = m.log[i]?.[id];
      if (v == null) return "";
      if (q.kind === "type") return v + (isRight(q, v) ? " ✓" : " ✗");
      if (q.kind === "order") return v.map((i) => q.answers[i]).join(" → ") + (isRight(q, v) ? " ✓" : " ✗");
      if (q.kind === "slider") return fmtNum(v, q.dec ?? 2, q.unit).replace(/\u00a0/g, " ") + (isRight(q, v) ? " ✓" : " ✗");
      if (q.answers) return (q.answers[v] === PIC_ONLY ? LETTERS[v] : q.answers[v]) + (q.kind === "quiz" ? (q.correct.includes(v) ? " ✓" : " ✗") : "");
      return Array.isArray(v) ? v.join(" / ") : v;
    })]);
  }
  if (tm) {
    rows.push([], [t("Team"), t("Team points")]);
    tm.names.map((name, k) => [name, tm.score[k]]).sort((a, b) => b[1] - a[1]).forEach((r) => rows.push(r));
  }
  const csv = "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n");
  downloadFile((m.quiz.title || "Ronda") + " - " + t("results") + ".csv", csv, "text/csv");
  toast(t("Results saved to your downloads"));
}

// ---------------- assignments (like Kahoot's "Assign") ----------------
// No big screen: everyone plays the whole ronda on their own phone, at their own pace, until a deadline (up to 28
// days ahead, like Kahoot's). The host's device keeps each assignment's code and key; its report shows who started,
// who finished, everyone's points and answers, and each question; the deadline can be moved or ended early.
const MAX_DAYS = 28; // the same as the server's
const DAY = 86400000;
function assignedList() {
  try {
    const list = JSON.parse(safeGet("assigned") || "[]");
    return Array.isArray(list) ? list.filter((r) => r && /^\d{6}$/.test(r.code) && Date.now() < r.until + 30 * DAY) : [];
  } catch { return []; }
}
function saveAssigned(list) { return safeSet("assigned", JSON.stringify(list)); }
// (false: this device could not keep it, and so not the key to the report either: the screen says so, audit R2-11)
function putAssigned(rec) { return saveAssigned([rec, ...assignedList().filter((r) => r.code !== rec.code)]); }
function dropAssigned(code) { saveAssigned(assignedList().filter((r) => r.code !== code)); }

// "2026-11-27T18:00" for a datetime input, in this device's time
const toLocalInput = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);

function openAssign(q) {
  const picOnly = q.questions.findIndex((x) => x.answers && x.aimg?.some((k, j) => k && !x.answers[j]?.trim()));
  const msg = problems(q) || (picOnly >= 0 ? t("Question {n}: an answer that is only a picture needs words to be assigned", { n: picOnly + 1 }) : null);
  if (msg) {
    if (here() !== "/edit/" + q.id) go("/edit/" + q.id);
    $("#editMsg").textContent = msg;
    $("#editMsg").hidden = false;
    return;
  }
  const sheet = el("div", "asgSheet");
  sheet.id = "asgSheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  const box = el("form", "asgBox card");
  box.noValidate = true;
  const when = el("input");
  when.type = "datetime-local";
  when.name = "until";
  const hour = 3600000;
  when.value = toLocalInput(Math.ceil((Date.now() + 7 * DAY) / hour) * hour); // a week from now, on the hour
  when.min = toLocalInput(Date.now() + 5 * 60000);
  when.max = toLocalInput(Date.now() + MAX_DAYS * DAY);
  const mix = el("input");
  mix.type = "checkbox";
  mix.name = "mix";
  mix.checked = true;
  const mixRow = el("label", "anon");
  mixRow.append(mix, " " + t("Mix the order of the answers on each phone"));
  const top = el("input");
  top.type = "checkbox";
  top.name = "top";
  const topRow = el("label", "anon");
  topRow.append(top, " " + t("Show the top 5 names and points to people when they finish"));
  const out = el("p", "msg");
  out.hidden = true;
  const cancel = el("button", "btn ghost", t("Cancel"));
  cancel.type = "button";
  cancel.onclick = () => sheet.remove();
  const make = el("button", "btn primary", t("Create assignment"));
  make.name = "make";
  const row = el("div", "asgBtns");
  row.append(cancel, make);
  box.append(el("h2", "asgHead", t("Assign")),
    el("p", "small", t("Everyone plays on their own phone, at their own pace, until the time you pick. No big screen.")),
    el("label", "asgLabel", t("Answer by")), when, mixRow, topRow);
  if (q.questions.some((x) => x.img || x.aimg?.some(Boolean))) box.append(el("p", "small", t("Pictures stay on this device: phones get the words only.")));
  box.append(out, row);
  sheet.append(box);
  sheet.onclick = (e) => { if (e.target === sheet) sheet.remove(); };
  document.body.append(sheet);
  setTimeout(() => make.focus(), 50);
  box.onsubmit = async (e) => {
    e.preventDefault();
    const until = new Date(when.value).getTime();
    if (!(until > Date.now() + 60000) || until > Date.now() + MAX_DAYS * DAY) {
      out.textContent = t("Pick a time within the next {n} days", { n: MAX_DAYS });
      out.hidden = false;
      return;
    }
    make.disabled = true;
    const room = await makeRoom();
    if (!room) {
      make.disabled = false;
      out.textContent = t("Couldn't start. Check the internet and try again.");
      out.hidden = false;
      return;
    }
    const quiz = { title: q.title, questions: bare(q.questions) };
    const rec = { code: room.code, token: room.token, at: room.at, title: q.title || "Ronda", until, made: Date.now() };
    closeLive();
    live = connect(room.code, () => {
      live.send({ t: "host", token: room.token });
      live.send({ t: "assign", quiz, until, mix: mix.checked, top: top.checked });
    }, (m) => {
      if (m.t === "report") {
        if (!putAssigned(rec)) toast(t("This device couldn't keep the key to this assignment. Copy its link now: without it nobody can open the report."));
        sheet.remove();
        go("/report/" + room.code);
      } else if (m.t === "bad-quiz" || m.t === "bad-until") {
        closeLive();
        make.disabled = false;
        out.textContent = m.t === "bad-until" ? t("Pick a time within the next {n} days", { n: MAX_DAYS }) : t("Couldn't start. Check the internet and try again.");
        out.hidden = false;
      }
    }, { at: room.at, patience: Infinity });
  };
}
$("#assignBtn").onclick = () => {
  putQuiz(editing);
  openAssign(editing);
};

// two taps for what can't be undone (no dialogs)
function armed(b, again, act) {
  const label = b.textContent;
  b.onclick = () => {
    if (!b.dataset.armed) {
      b.dataset.armed = "1";
      b.textContent = again;
      setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = label; } }, 3000);
      return;
    }
    act();
  };
  return b;
}

function reportScreen(code) {
  const rec = assignedList().find((r) => r.code === code);
  if (!rec) return go("/", true);
  show("report");
  $("#rTitle").textContent = rec.title;
  $("#rMain").replaceChildren(el("p", "small", t("Loading…")));
  $("#rCtl").replaceChildren();
  if (rec.key) drawShare(code, rec.key);
  let editingUntil = false;
  live = connect(code, () => live.send({ t: "host", token: rec.token }), (m) => {
    if (m.t === "gone" || m.t === "closed" || m.t === "denied") {
      dropAssigned(code);
      closeLive();
      if (m.t === "closed") { toast(t("Deleted")); return go("/", true); }
      $("#rShare").hidden = true;
      $("#rCtl").replaceChildren();
      return $("#rMain").replaceChildren(el("p", "", t("This assignment isn't there any more.")));
    }
    if (m.t !== "report") return;
    rec.until = m.until;
    rec.open = m.open; // the server's word, not this device's clock
    if (m.key !== rec.key || !$("#rShare").childElementCount) drawShare(code, (rec.key = m.key));
    putAssigned(rec);
    if (!editingUntil) drawCtl(m);
    drawReport(m);
  }, { at: rec.at, patience: Infinity });

  function drawCtl(m) {
    const state = el("p", "rState " + (m.open ? "on" : "off"),
      m.open ? t("Open until {when}", { when: fmtWhen(m.until) }) : t("Closed {when}. The results stay here until {keep}.", { when: fmtWhen(m.until), keep: fmtWhen(m.keep) }));
    $("#rShare").hidden = !m.open;
    const btns = el("div", "rBtns");
    if (m.open) {
      const move = el("button", "btn chip", t("Change the deadline"));
      move.onclick = () => {
        editingUntil = true;
        const f = el("form", "rUntil");
        const inp = el("input");
        inp.type = "datetime-local";
        inp.name = "until";
        inp.value = toLocalInput(m.until);
        inp.min = toLocalInput(Date.now() + 5 * 60000);
        inp.max = toLocalInput(Date.now() + MAX_DAYS * DAY);
        const set = el("button", "btn primary", t("Set"));
        const no = el("button", "btn ghost", t("Cancel"));
        no.type = "button";
        no.onclick = () => { editingUntil = false; drawCtl(m); };
        f.append(inp, set, no);
        f.onsubmit = (e) => {
          e.preventDefault();
          const u = new Date(inp.value).getTime();
          if (!(u > Date.now() + 60000) || u > Date.now() + MAX_DAYS * DAY) return toast(t("Pick a time within the next {n} days", { n: MAX_DAYS }));
          editingUntil = false;
          live.send({ t: "until", until: u });
        };
        btns.replaceWith(f);
        inp.focus();
      };
      btns.append(move, armed(el("button", "btn chip", t("End now")), t("Tap again to end it"), () => live.send({ t: "end" })));
    }
    if (m.people && m.quiz.questions.some((q) => scored(q.kind))) {
      const top = el("button", "btn chip", m.top ? t("Top 5 shown at the end: hide it") : t("Top 5 hidden at the end: show it"));
      top.onclick = () => live.send({ t: "top", on: !m.top });
      btns.append(top);
    }
    const save = el("button", "btn chip", t("Download results"));
    save.onclick = () => saveResults(asResults(m));
    btns.append(save, armed(el("button", "btn chip danger-text", t("Delete")), t("Tap again to delete"), () => live.send({ t: "close" })));
    $("#rCtl").replaceChildren(state, btns);
  }
}

function drawShare(code, key) {
  const link = location.origin + BASE + code + location.search + (key ? "#k=" + key : "");
  const box = $("#rShare");
  box.hidden = false;
  const copy = el("button", "btn primary", t("Copy link"));
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast(t("Link copied")); } catch { toast(link, 8000); }
  };
  const left = el("div", "rShareText");
  left.append(el("p", "small", key ? t("Send this link: the code alone doesn't open an assignment.") : t("Send the link, or people enter the code at {site}", { site: location.host + BASE.replace(/\/$/, "") })),
    el("p", "rCode", fmtCode(code)), el("p", "rLink", link), copy);
  box.replaceChildren(left);
  try { box.append(qr(link)); } catch {}
}

// the report as saveResults() takes a live game's
function asResults(m) {
  return {
    quiz: m.quiz,
    teams: null,
    players: Object.fromEntries(m.people.map((p) => [p.id, { name: p.name, score: p.score }])),
    log: m.quiz.questions.map((_, i) => Object.fromEntries(m.people.filter((p) => p.ans[i] != null).map((p) => [p.id, p.ans[i]]))),
  };
}

function drawReport(m) {
  const qs = m.quiz.questions;
  const n = qs.length;
  const scoredQs = qs.map((q, i) => i).filter((i) => scored(qs[i].kind));
  const done = m.people.filter((p) => p.done).length;
  const out = [el("h2", "sub", t("People: {n} · {d} finished", { n: m.people.length, d: done }))];
  if (!m.people.length) out.push(el("p", "small", t("Nobody yet. Send the link or the code.")));
  else {
    const tbl = el("table", "rPeople");
    const head = el("tr");
    for (const h of [t("Name"), t("Progress"), ...(scoredQs.length ? [t("Right"), t("Points")] : []), ""]) head.append(el("th", "", h));
    tbl.append(head);
    for (const p of m.people) {
      const tr = el("tr");
      tr.dataset.id = p.id;
      const prog = p.done ? t("Finished") : !p.started ? t("Not started") : !m.open ? t("Didn't finish ({a} of {n})", { a: p.at, n }) : t("{a} of {n}", { a: p.at, n });
      const right = scoredQs.filter((i) => p.ans[i] != null && isRight(qs[i], p.ans[i])).length;
      tr.append(el("td", "", p.name), el("td", p.done ? "ok" : "", prog));
      if (scoredQs.length) tr.append(el("td", "", `${right} / ${scoredQs.length}`), el("td", "", String(p.score)));
      const td = el("td");
      td.append(armed(el("button", "btn chip rm", t("Remove")), t("Tap again"), () => live.send({ t: "remove", id: p.id })));
      tr.append(td);
      tbl.append(tr);
    }
    const wrap = el("div", "rTable");
    wrap.append(tbl);
    out.push(wrap);
  }
  out.push(el("h2", "sub", t("Questions")));
  const ol = el("ol", "rQs");
  qs.forEach((q, i) => {
    const vals = m.people.map((p) => p.ans[i]).filter((v) => v != null);
    const li = el("li", "rQ");
    li.append(el("b", "", q.text));
    if (scored(q.kind)) {
      const ok = vals.filter((v) => isRight(q, v)).length;
      const pct = vals.length ? Math.round((100 * ok) / vals.length) : 0;
      const bar = el("div", "rBar");
      bar.style.setProperty("--p", pct + "%");
      li.append(el("p", "small", t("{p}% right · {n} answered", { p: pct, n: vals.length })), bar);
    } else li.append(el("p", "small", t("{n} answered", { n: vals.length })));
    if (q.answers && (q.kind === "quiz" || q.kind === "poll")) {
      const ul = el("ul", "rAns");
      q.answers.forEach((a, j) => {
        const c = vals.filter((v) => v === j).length;
        ul.append(el("li", q.kind === "quiz" && q.correct.includes(j) ? "ok" : "", `${LETTERS[j]}: ${a} · ${c}`));
      });
      li.append(ul);
    } else if (q.kind === "scale" && vals.length) {
      li.append(el("p", "small", t("Average {a}", { a: (vals.reduce((x, y) => x + y, 0) / vals.length).toFixed(1) })));
    } else if (q.kind === "words" && vals.length) {
      const c = new Map();
      for (const list of vals) for (const w of list) c.set(w, (c.get(w) || 0) + 1);
      li.append(el("p", "small", [...c].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w, k]) => `${w} (${k})`).join(" · ")));
    }
    ol.append(li);
  });
  out.push(ol);
  $("#rMain").replaceChildren(...out);
}

// the assignments this device made, on the start page
function drawAssigned() {
  const list = assignedList();
  $("#asgWrap").hidden = !list.length;
  $("#asg").replaceChildren(...list.map((r) => {
    const li = el("li", "mineRow");
    const open = el("button", "mineOpen");
    open.append(el("b", "", r.title), el("span", "small", r.open !== false && Date.now() < r.until ? t("Open until {when}", { when: fmtWhen(r.until) }) : t("Closed")));
    open.onclick = () => go("/report/" + r.code);
    li.append(open);
    return li;
  }));
}

// ---------------- start ----------------
translatePage();
route();
