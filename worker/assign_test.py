# Assignments, like Kahoot's "Assign" (help 'How to assign a kahoot in web platform'): no big screen; everyone plays
# the whole ronda on their own phone, at their own pace, until a deadline (up to 28 days ahead). Answers can be mixed
# on each phone. Someone who leaves mid-way comes back where they were (same browser); time runs on the server. The
# host's report shows who started and finished, points, right answers and each question; the deadline can be moved
# or ended now; after it nobody new joins and whoever didn't finish is told. Results download as a spreadsheet.
#   python worker/assign_test.py [site] [query, to pick the server]   (local: cd worker && npx wrangler dev --port 8788)
import csv
import io
import json
import os
import subprocess
import sys
import time
sys.stdout.reconfigure(encoding='utf-8')
from playwright.sync_api import sync_playwright

SITE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8788"
QS = sys.argv[2] if len(sys.argv) > 2 else ""
HERE = os.path.dirname(os.path.abspath(__file__))
Q = {"id": "assign01", "title": "Homework check", "questions": [
    {"kind": "quiz", "text": "Two plus two?", "answers": ["3", "4", "5", "22"], "correct": [1], "time": 20},
    {"kind": "type", "text": "Capital of France?", "accept": ["Paris"], "time": 20},
    {"kind": "words", "text": "One word for today", "time": 0},
    {"kind": "poll", "text": "Pizza or pasta?", "answers": ["Pizza", "Pasta"], "time": 0},
    {"kind": "quiz", "text": "Pick the even one", "answers": ["7", "8"], "correct": [1], "time": 10}]}
DAY = 86400000
errors = []
SHOTS = os.environ.get("RONDA_SHOTS")


def shot(pg, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        pg.screenshot(path=os.path.join(SHOTS, name + ".png"))


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what, flush=True)
    if not ok:
        errors.append(what)


UNIT = r"""
import { expiry, SELF_RULES } from './src/index.js';
console.log(JSON.stringify({
  consts: [SELF_RULES.MAX_DAYS, SELF_RULES.KEEP_MS / 86400000],
  live: expiry({ touched: 1000 }) - 1000,
  self: expiry({ touched: 1000, self: { until: 5000 } }) - 5000,
}));
"""
r = subprocess.run(["node", "--input-type=module", "-e", UNIT], cwd=HERE, capture_output=True, text=True, encoding="utf-8")
u = json.loads(r.stdout or "{}") if r.returncode == 0 else {}
check(r.returncode == 0, "the server's rules load " + (r.stderr[-300:] if r.returncode else ""))
if u:
    check(u["consts"] == [28, 30], f"deadline up to 28 days, results kept 30 days after it ({u['consts']})")  # pinned: Kahoot's 28 days; privacy page's 30
    check(u["live"] == 6 * 3600000 and u["self"] == 30 * DAY, "a live game goes 6 h after the last activity, an assignment 30 days after its deadline")  # pinned: privacy page

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, channel="msedge")

    def ctx(phone=False):
        return b.new_context(locale="en-US", accept_downloads=True,
                             viewport={"width": 390, "height": 760} if phone else {"width": 1280, "height": 800})

    def page(c):
        pg = c.new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        return pg

    def view(pg):
        return pg.evaluate("document.querySelector('#pMain').innerText")

    def wait_text(pg, text, secs=20, sel="#pMain"):
        try:
            pg.wait_for_function("([s, t]) => (document.querySelector(s)?.innerText || '').includes(t)", arg=[sel, text], timeout=secs * 1000)
            return True
        except Exception:
            return False

    def tap_answer(pg, text):
        pg.wait_for_selector(".pa:not(:disabled)", timeout=20000)
        pg.locator(".pa", has=pg.locator(".atext", has_text=text)).first.click()

    def go_next(pg):
        pg.wait_for_selector(".goBtn:not(:disabled)", timeout=20000)
        pg.click(".goBtn")

    hc = ctx()
    h = page(hc)
    h.goto(SITE + "/" + QS)
    h.evaluate("q => localStorage.setItem('rondas', JSON.stringify([q]))", Q)
    h.goto(SITE + "/edit/assign01" + QS)
    h.click("#assignBtn")
    h.wait_for_selector("#asgSheet", timeout=10000)
    span = h.evaluate("[new Date(document.querySelector('#asgSheet [name=until]').value) - Date.now(), new Date(document.querySelector('#asgSheet [name=until]').max) - Date.now()]")
    check(6.9 * DAY < span[0] <= 7.05 * DAY, f"the deadline starts a week ahead, on the hour ({span[0] / DAY:.2f} days)")  # pinned: a week by default
    check(27.9 * DAY < span[1] <= 28 * DAY, "and can be up to 28 days ahead")
    check(h.is_checked("#asgSheet [name=mix]"), "answers are mixed on each phone unless turned off")  # pinned: Kahoot's 'Randomize answer order', on here
    check(not h.is_checked("#asgSheet [name=top]"), "the top 5 is off unless the host ticks it")  # pinned: safety audit R8, names of children stay private
    shot(h, "1-assign-sheet")
    h.evaluate("document.querySelector('#asgSheet [name=until]').value = '2020-01-01T10:00'")
    h.click("#asgSheet [name=make]")
    check(h.locator("#asgSheet .msg:not([hidden])").count() == 1 and "/edit/" in h.url, "a deadline in the past is refused")
    h.evaluate("(v) => document.querySelector('#asgSheet [name=until]').value = v",
               h.evaluate("() => { const d = new Date(Date.now() + 3 * 86400000); d.setMinutes(0, 0, 0); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }"))
    h.click("#asgSheet [name=make]")
    h.wait_for_url(lambda x: "/report/" in x, timeout=30000)
    code = h.url.split("/report/")[1][:6]
    check(not h.locator("#asgSheet").count(), f"Create assignment: the report opens ({code})")
    h.wait_for_selector(".rState.on", timeout=15000)
    check(h.locator(".rCode").inner_text().replace(" ", "") == code and h.locator("#rShare .qr").count() == 1, "it shows the code, the link and a QR code")
    check("Nobody yet" in h.inner_text("#rMain"), "nobody has started yet")
    LINK = h.locator(".rLink").inner_text().strip()
    check("#k=" in LINK and len(LINK.split("#k=")[1]) == 12, f"the link carries the assignment's key ({LINK.split('#')[0]}#k=...)")  # pinned: safety audit R8
    bare = page(ctx(True))
    bare.goto(f"{SITE}/{code}{QS}")
    bare.fill("#nameInput", "Probe")
    bare.press("#nameInput", "Enter")
    check(wait_text(bare, "No ronda is running with this code"), "the code alone doesn't open an assignment, and looks like a code nobody uses")
    check("Nobody yet" in h.inner_text("#rMain"), "and nobody was added")
    shot(h, "2-report-empty")

    # Ana plays it all
    ac = ctx(True)
    a = page(ac)
    a.goto(LINK)
    a.fill("#nameInput", "Ana")
    a.press("#nameInput", "Enter")
    check(wait_text(a, "Homework check") and wait_text(a, "5 questions") and wait_text(a, "Answer by"), "a phone first shows the title, how many questions and the deadline")
    shot(a, "3-phone-intro")
    go_next(a)
    a.wait_for_selector(".pa", timeout=20000)
    check("Two plus two?" in view(a) and a.locator(".pa").count() == 4 and a.locator(".timer").count() == 1,
          "the question and its answers are on the phone, with the timer")
    shot(a, "4-phone-question")
    tap_answer(a, "4")
    check(wait_text(a, "Right!"), "the right answer: Right! at once, no waiting for others")
    gained = a.evaluate("Number((document.querySelector('.gain')?.textContent || '0').replace('+', ''))")
    check(500 < gained <= 1000, f"points for a fast right answer ({gained})")
    check(a.locator(".goBtn", has_text="Next question").count() == 1, "then Next question")
    shot(a, "5-phone-right")
    go_next(a)
    a.wait_for_selector(".wordForm input", timeout=20000)
    a.fill(".wordForm input", "paris")
    a.press(".wordForm input", "Enter")
    check(wait_text(a, "Right!"), "a typed answer counts as in a live game")
    go_next(a)
    a.wait_for_selector(".wordForm input", timeout=20000)
    a.fill(".wordForm input", "sunny")
    a.press(".wordForm input", "Enter")
    a.wait_for_selector(".sentWords .chip", timeout=20000)
    check(a.locator(".goBtn", has_text="Next").count() == 1, "words: after a word, Next (more words can still go)")
    go_next(a)
    check(wait_text(a, "Thanks!"), "words done")
    go_next(a)
    tap_answer(a, "Pasta")
    check(wait_text(a, "Thanks!"), "a poll answer")
    go_next(a)
    a.wait_for_selector(".pa", timeout=20000)
    t0 = time.time()
    check(wait_text(a, "No answer this time", secs=20), f"time's up on a question: it says so by itself ({time.time() - t0:.1f} s)")
    check(a.locator(".goBtn", has_text="See your result").count() == 1, "the last one: See your result")
    go_next(a)
    check(wait_text(a, "Finished!"), "Finished!")
    check("2 of 3 right" in view(a) and a.locator(".top5 li").count() == 0, f"the result: right answers, points and place, no top 5 ({view(a)!r})")
    h.click("text=Top 5 hidden at the end: show it")
    a.wait_for_selector(".top5 li", timeout=15000)
    check(h.locator("text=Top 5 shown at the end: hide it").count() == 1, "the host turns the top 5 on: it shows at the end")
    shot(a, "6-phone-finished")
    a.reload()
    a.fill("#nameInput", "Ana")
    a.press("#nameInput", "Enter")
    check(wait_text(a, "Finished!") and a.locator(".goBtn").count() == 0, "coming back after finishing shows the result again, no second go")

    # Beto: the answers in another order, a wrong answer, leaves mid-way and comes back
    bc = ctx(True)
    o = page(bc)
    o.goto(LINK)
    o.fill("#nameInput", "Beto")
    o.press("#nameInput", "Enter")
    go_next(o)
    o.wait_for_selector(".pa", timeout=20000)
    orders = set()
    orders.add(tuple(o.locator(".pa .atext").all_inner_texts()))
    tap_answer(o, "3")
    check(wait_text(o, "Not this time") and wait_text(o, "4"), "a wrong answer: Not this time, and the right one")
    go_next(o)
    o.wait_for_selector(".wordForm input", timeout=20000)
    o.close()
    o = page(bc)
    o.goto(LINK)
    o.fill("#nameInput", "Beto")
    o.press("#nameInput", "Enter")
    check(wait_text(o, "Capital of France?"), "leaving and coming back (same browser): the same question, the clock still running")

    # more phones: the mixed order, and someone the host removes
    for k in range(4):
        c = ctx(True)
        x = page(c)
        x.goto(LINK)
        x.fill("#nameInput", "Dani" if k == 0 else f"P{k}")
        x.press("#nameInput", "Enter")
        go_next(x)
        x.wait_for_selector(".pa", timeout=20000)
        orders.add(tuple(x.locator(".pa .atext").all_inner_texts()))
        if k == 0:
            dani = x
        else:
            c.close()
    check(len(orders) > 1, f"the answers come in a different order on different phones ({len(orders)} orders in 5 phones)")

    h.wait_for_function("document.querySelectorAll('.rPeople tr').length === 7", timeout=20000)
    rows = h.evaluate("[...document.querySelectorAll('.rPeople tr')].slice(1).map((r) => [...r.cells].slice(0, 4).map((c) => c.innerText).concat(r.cells[1].className))")
    ana = next(r for r in rows if r[0] == "Ana")
    beto = next(r for r in rows if r[0] == "Beto")
    check(ana[4] == "ok" and ana[2] == "2 / 3" and int(ana[3]) > 1000, f"the report: Ana finished, 2 of 3 right, her points ({ana})")
    check(beto[4] != "ok" and beto[2] == "0 / 3", f"Beto is on the way ({beto})")
    q1 = h.locator(".rQ").nth(0).inner_text()
    check("50%" in q1 and "2 answered" in q1, f"each question: how many answered and got it right ({q1!r})")
    shot(h, "7-report")
    h.locator(".rPeople tr", has_text="Dani").locator(".rm").click()
    h.locator(".rPeople tr", has_text="Dani").locator(".rm").click()
    check(wait_text(dani, "removed you"), "the host removes someone: their phone says so")

    # the deadline: moved, then ended now
    before = h.inner_text(".rState")
    h.click("text=Change the deadline")
    h.evaluate("(v) => document.querySelector('.rUntil input').value = v",
               h.evaluate("() => { const d = new Date(Date.now() + 10 * 86400000); d.setMinutes(30, 0, 0); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }"))
    h.click(".rUntil .btn.primary")
    h.wait_for_function("(b) => document.querySelector('.rState')?.innerText !== b", arg=before, timeout=15000)
    check(":30" in h.inner_text(".rState"), f"the deadline moved ({h.inner_text('.rState')})")
    h.click("text=End now")
    h.click("text=Tap again to end it")
    h.wait_for_selector(".rState.off", timeout=15000)
    check(h.locator("#rShare").is_hidden(), "ended now: closed, the link is no longer offered")
    check(wait_text(o, "The time to answer is over"), "Beto, mid-way, is told the time to answer is over")
    h.wait_for_function("[...document.querySelectorAll('.rPeople tr')].some((r) => r.innerText.includes(\"Didn't finish\"))", timeout=15000)
    check(True, "the report says who didn't finish")
    late = page(ctx(True))
    late.goto(LINK)
    late.fill("#nameInput", "Late")
    late.press("#nameInput", "Enter")
    check(wait_text(late, "already finished"), "after the deadline nobody new can start")
    check(h.locator("text=Change the deadline").count() == 0, "a closed one can't be opened again (as in Kahoot)")

    # the spreadsheet
    with h.expect_download() as dl:
        h.click("text=Download results")
    rows = list(csv.reader(io.StringIO(open(dl.value.path(), encoding="utf-8-sig").read())))
    check(rows[0][:2] == ["Name", "Points"] and len(rows[0]) == 7, f"Download results: a row per person, a column per question ({rows[0][:3]})")
    ar = next(r for r in rows if r[0] == "Ana")
    check(ar[2] == "4 ✓" and ar[3].startswith("paris") and ar[5] == "Pasta", f"with what each answered ({ar})")

    # the start page lists it; it stays after a reload of the report; Delete removes it
    h.goto(SITE + "/" + QS)
    h.wait_for_selector("#asg .mineRow", timeout=10000)
    check("Homework check" in h.inner_text("#asg") and "Closed" in h.inner_text("#asg"), "the start page lists the assignment (closed)")
    h.click("#asg .mineOpen")
    h.wait_for_selector(".rPeople", timeout=20000)
    check(h.locator(".rState.off").count() == 1, "its report opens again, from the server")
    h.click("#rCtl >> text=Delete")
    h.click("#rCtl >> text=Tap again to delete")
    h.wait_for_selector("#home:not([hidden])", timeout=15000)
    check(h.locator("#asgWrap").is_hidden(), "Delete: gone from the list")
    gone = page(ctx(True))
    gone.goto(LINK)
    gone.fill("#nameInput", "Ana")
    gone.press("#nameInput", "Enter")
    check(wait_text(gone, "No ronda is running"), "and from the server")
    b.close()

print("errors:", errors)
print("OK" if not errors else "FAILED")
sys.exit(1 if errors else 0)
