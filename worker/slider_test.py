# Slider questions, like Kahoot's (help 'Kahoot! question types'): a number between From and To, an optional unit, and
# an answer margin (none: only the exact number ... maximum: every answer gets points); the closer, the more points
# (80% precision, 20% speed), standard / double / no points like the rest. Phones get a slider (− / + for one step);
# the big screen shows every guess as a dot and the right number. A host and two players, three questions:
#   1 a year, medium margin: Ana exact, Beto 31 off (out of the margin)
#   2 pi to 2 decimals, no margin, double points: Ana exact, Beto 0.01 off
#   3 a price with a unit, maximum margin: both get points, the closer more
#   python worker/slider_test.py [site] [query, to pick the server]   (local: cd worker && npx wrangler dev --port 8788)
import csv
import io
import json
import os
import re
import subprocess
import sys
sys.stdout.reconfigure(encoding='utf-8')
from playwright.sync_api import sync_playwright

SITE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8788"
QS = sys.argv[2] if len(sys.argv) > 2 else ""
HERE = os.path.dirname(os.path.abspath(__file__))
Q = {"id": "slider01", "title": "Slider check", "questions": [
    {"kind": "slider", "text": "Year of the first moon landing?", "min": 1900, "max": 2025, "ans": 1969, "margin": 2, "time": 60},
    {"kind": "slider", "text": "Pi, to two decimals?", "min": 0, "max": 10, "ans": 3.14, "margin": 0, "time": 60, "pts": 2},
    {"kind": "slider", "text": "Price of a coffee?", "min": 0, "max": 10, "ans": 2.5, "unit": "€", "margin": 4, "time": 60}]}
errors = []
SHOTS = os.environ.get("RONDA_SHOTS")  # a folder: screenshots for a review


def shot(pg, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        pg.screenshot(path=os.path.join(SHOTS, name + ".png"))


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what, flush=True)
    if not ok:
        errors.append(what)


def score(pg):
    m = re.search(r"\d+", pg.inner_text("#pScore") or "")
    return int(m.group()) if m else 0


# the server's own rules (worker/src/index.js), straight from the code both servers run
UNIT = r"""
import { cleanQuiz, cleanSnap, isRight, points } from './src/index.js';
const q = cleanQuiz(%s);
const s = (i) => q.questions[i];
const bad = cleanQuiz({questions: [{kind: 'slider', text: 'x', min: 5, max: 1, ans: 3}, {kind: 'slider', text: 'y', min: 0, max: 10, ans: 11},
  {kind: 'slider', text: 'z', min: 0, max: 10, ans: ''}, {kind: 'quiz', text: 'keep', answers: ['a', 'b'], correct: [0]}]});
console.log(JSON.stringify({
  q0: s(0), q1: s(1), q2: s(2),
  right: [isRight(s(0), 1969), isRight(s(0), 1981), isRight(s(0), 1982), isRight(s(1), 3.14), isRight(s(1), 3.15), isRight(s(2), 10)],
  pts: [points(s(0), 0, 1969), points(s(0), 60000, 1969), points(s(0), 0, 1981), points(s(1), 0, 3.14), points(s(2), 0, 10)],
  bad: bad.questions.map((x) => x.kind),
  snap: cleanSnap({ quiz: %s, phase: 'reveal', qi: 0, players: [{ id: 'aaaaaaaa', name: 'A', score: 5 }, { id: 'bbbbbbbb', name: 'B', score: 0 }],
    log: [{ aaaaaaaa: 1969, bbbbbbbb: 3000 }] }, 'h').log[0],
}));
""" % (json.dumps(Q), json.dumps(Q))
r = subprocess.run(["node", "--input-type=module", "-e", UNIT], cwd=HERE, capture_output=True, text=True, encoding="utf-8")
u = json.loads(r.stdout or "{}") if r.returncode == 0 else {}
check(r.returncode == 0, "the server's rules load " + (r.stderr[-300:] if r.returncode else ""))
if u:
    check(u["q0"]["dec"] == 0 and u["q1"]["dec"] == 2 and u["q2"]["unit"] == "€", f"steps from the numbers' decimals, unit kept ({u['q0'].get('dec')}, {u['q1'].get('dec')})")
    check(u["right"] == [True, True, False, True, False, True], f"medium margin = a tenth of the range; none = exact; maximum = all ({u['right']})")  # pinned: margin sizes
    check(u["pts"][0] == 1000 and u["pts"][1] == 800, f"exact and fast 1000, exact at the buzzer 800 (80% precision, 20% speed) ({u['pts'][:2]})")  # pinned: Kahoot's 80/20
    check(200 <= u["pts"][2] < 400 and u["pts"][3] == 2000 and u["pts"][4] == 400, f"closer gets more; double; far on maximum still something ({u['pts'][2:]})")  # pinned: the closeness formula (linear inside the margin)
    check(u["bad"] == ["quiz"], f"a slider with From >= To, or the answer outside, or none, isn't kept ({u['bad']})")
    check(u["snap"] == {"aaaaaaaa": 1969}, f"answers move to the other server with the game, out-of-range ones don't ({u['snap']})")

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, channel="msedge")

    def page(phone=False):
        pg = b.new_context(locale="en-US", accept_downloads=True,
                           viewport={"width": 390, "height": 760} if phone else {"width": 1280, "height": 720}).new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        return pg

    # the editor
    e = page(phone=True)
    e.goto(SITE + "/" + QS)
    e.click("#makeBtn")
    e.click("[data-add='slider']")
    card = e.locator(".qcard").last
    check(card.locator("select.kind").input_value() == "slider", "Slider is a question kind")  # pinned: the saved kind id
    check(card.locator("select[name='margin']").input_value() == "2", "the margin starts at Medium")  # pinned: medium by default
    check(card.locator(".qpts select").count() == 1, "a slider has Points")
    card.locator("textarea").fill("Year of the first moon landing?")
    card.locator("input[name='min']").fill("1900")
    card.locator("input[name='max']").fill("2025")
    card.locator("input[name='ans']").fill("1969")
    hint = card.locator(".slideHint").inner_text()
    check("1957" in hint and "1981" in hint, f"the editor says which guesses get points ({hint!r})")
    card.locator("select[name='margin']").select_option("0")
    check("Only 1969" in card.locator(".slideHint").inner_text(), "no margin: only the exact number")
    card.locator(".slideEdit").evaluate("x => x.scrollIntoView({block: 'center'})")
    shot(e, "1-editor")
    card.locator("input[name='ans']").fill("2050")
    e.locator(".qcard").first.locator(".qtools button").nth(2).click()  # the empty first question goes
    card = e.locator(".qcard").last
    e.click("#startBtn")
    e.wait_for_selector("#editMsg:not([hidden])")
    check("between" in e.inner_text("#editMsg"), f"a right answer outside From-To can't start ({e.inner_text('#editMsg')!r})")
    e.wait_for_timeout(600)
    kept = json.loads(e.evaluate("localStorage.getItem('ronda.rondas') || '[]'"))[0]["questions"][-1]
    check(kept.get("min") == 1900 and kept.get("ans") == 2050 and kept.get("margin") == 0, "the slider's numbers are kept with the ronda")  # pinned: saved fields min/max/ans/margin
    e.context.close()

    h = page()
    h.goto(SITE + "/" + QS)
    h.evaluate("q => localStorage.setItem('ronda.rondas', JSON.stringify([q]))", Q)
    h.reload()
    h.click(".mineRow .btn.primary")
    h.wait_for_url(lambda u: "/host/" in u, timeout=30000)
    code = h.url.split("/host/")[1][:6]
    pl = {}
    for n in ("Ana", "Beto"):
        pg = page(phone=True)
        pg.goto(f"{SITE}/{code}{QS}")
        pg.fill("#nameInput", n)
        pg.press("#nameInput", "Enter")
        pl[n] = pg
    h.wait_for_function("() => document.body.textContent.includes('Beto')", timeout=30000)

    def put(pg, v):
        pg.locator("input[name='slider']").evaluate("(x, v) => { x.value = v; x.dispatchEvent(new Event('input', {bubbles: true})); }", str(v))

    def ask(answers, shoot=None):
        h.click("#hNext")
        for n in ("Ana", "Beto"):
            pl[n].wait_for_selector("input[name='slider']", timeout=30000)
        if shoot:
            put(pl["Ana"], answers["Ana"])
            shot(h, shoot + "-screen-asking")
            shot(pl["Ana"], shoot + "-phone-asking")
        for n, v in answers.items():
            put(pl[n], v)
            pl[n].click(".slide .btn.primary")
        h.wait_for_selector(".slideRes .typeRight", timeout=30000)
        for n in ("Ana", "Beto"):
            pl[n].wait_for_selector(".big-ok, .big-no", timeout=15000)

    # 1: a year, medium margin
    h.click("#hNext")
    for n in ("Ana", "Beto"):
        pl[n].wait_for_selector("input[name='slider']", timeout=30000)
    a = pl["Ana"]
    check(a.inner_text(".slide .scaleEnds") .split() == ["1900", "2025"], f"the phone shows From and To ({a.inner_text('.slide .scaleEnds')!r})")
    check(a.inner_text(".sval") == "1963", f"the slider starts in the middle ({a.inner_text('.sval')!r})")  # pinned: starts mid-range
    a.click(".nudge >> nth=1")
    a.click(".nudge >> nth=1")
    check(a.inner_text(".sval") == "1965", "+ moves one step")
    a.locator("input[name='slider']").focus()
    for _ in range(4):
        a.keyboard.press("ArrowRight")
    check(a.inner_text(".sval") == "1969", "and so does the keyboard's arrow")
    check("1969" not in h.inner_text(".res"), "the big screen doesn't give the answer away while asking")
    shot(h, "2-screen-asking"); shot(a, "2-phone-asking")
    a.click(".slide .btn.primary")
    put(pl["Beto"], 2000)
    pl["Beto"].click(".slide .btn.primary")
    h.wait_for_selector(".slideRes .typeRight", timeout=30000)
    for n in ("Ana", "Beto"):
        pl[n].wait_for_selector(".big-ok, .big-no", timeout=15000)
    check(h.inner_text(".slideRes .typeRight") == "1969", "the big screen shows the right number")
    check("1 of 2" in h.inner_text(".slideRes .avg"), f"and how many were close enough ({h.inner_text('.slideRes .avg')!r})")
    check(h.locator(".track .dot").count() == 2 and h.locator(".track .dot.ok").count() == 1, "a dot per guess, the close one marked")
    h.wait_for_timeout(1600)
    shot(h, "3-screen-reveal"); shot(pl["Beto"], "3-phone-wrong")
    a1 = score(a)
    check(800 <= a1 <= 1000 and a.locator(".big-no").count() == 0, f"Ana: right, 800 to 1000 points ({a1})")  # pinned: 80% precision, 20% speed
    bt = pl["Beto"].inner_text("#playView") if pl["Beto"].locator("#playView").count() else pl["Beto"].inner_text("body")
    check("Right answer: 1969" in bt and "You said 2000 (31 off)" in bt and score(pl["Beto"]) == 0, f"Beto: out of the margin, told the answer and how far off ({bt[:200]!r})")
    h.click("#hNext")
    h.wait_for_selector(".board", timeout=15000)

    # 2: pi, no margin, double
    ask({"Ana": 3.14, "Beto": 3.15})
    a2 = score(a) - a1
    check(1600 <= a2 <= 2000, f"double points for the exact one ({a2})")  # pinned: double = up to 2000
    check(score(pl["Beto"]) == 0 and "1 of 2 got it exactly" in h.inner_text(".slideRes .avg"), "0.01 off doesn't count without a margin")
    h.click("#hNext")
    h.wait_for_selector(".board", timeout=15000)

    # 3: a price with a unit, maximum margin
    ask({"Ana": 3, "Beto": 10}, shoot="4")
    a3, b3 = score(a) - a1 - a2, score(pl["Beto"])
    check(0 < b3 < a3, f"maximum: everyone gets points, the closer more (Ana {a3}, Beto {b3})")
    check(h.inner_text(".slideRes .typeRight") == "2.5 €", f"the unit shows with the number ({h.inner_text('.slideRes .typeRight')!r})")
    h.wait_for_timeout(1600)
    shot(h, "4-screen-reveal")
    h.click("#hNext")
    h.wait_for_selector(".board", timeout=15000)
    h.click("#hNext")
    h.wait_for_selector(".podium", timeout=15000)
    with h.expect_download() as dl:
        h.click("#hNext")
    got = list(csv.reader(io.StringIO(open(dl.value.path(), encoding="utf-8-sig").read())))
    ana = next(r for r in got if r[0] == "Ana")
    check(ana[2:] == ["1969 ✓", "3.14 ✓", "3 € ✓"], f"the results file has each guess ({ana[2:]})")  # pinned: the CSV cell format
    b.close()

print("ALL OK" if not errors else "FAILED: " + "; ".join(errors))
sys.exit(1 if errors else 0)
