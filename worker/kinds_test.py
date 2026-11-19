# "Type answer" and "Put in order" questions (Kahoot's type-answer and puzzle, paid there). A host and two players.
# Type answer: Ana types the answer in lower case without the accent and gets points; Beto types another and doesn't;
# the screen shows the answer, how many got it and what people typed. Put in order: both see the same mix (never
# already in order), Ana taps them back in order and scores, Beto doesn't. The ranking, the podium and the results
# file (with ✓/✗) count both kinds. Also: the editor offers both kinds and won't start a type question with no answer.
#   python worker/kinds_test.py [site] [query, to pick the server]   (local: cd worker && npx wrangler dev --port 8788)
import csv
import io
import sys
sys.stdout.reconfigure(encoding='utf-8')
from playwright.sync_api import sync_playwright

SITE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8788"
QS = sys.argv[2] if len(sys.argv) > 2 else ""  # e.g. ?server=wss://down.invalid&server2=wss://games.jurisgames.com/ronda
STEPS = ["Wake up", "Breakfast", "Lunch", "Dinner"]
Q = {"id": "kinds01", "title": "Kinds check", "questions": [
    {"kind": "type", "text": "Capital of Argentina?", "accept": ["Buenos Aires", "CABA", "", ""], "time": 60},
    {"kind": "order", "text": "Put the day in order", "answers": STEPS, "time": 60}]}
errors = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what, flush=True)
    if not ok:
        errors.append(what)


with sync_playwright() as p:
    b = p.chromium.launch(headless=True, channel="msedge")

    def page():
        pg = b.new_context(locale="en-US", accept_downloads=True).new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        return pg

    # the editor
    e = page()
    e.goto(SITE + "/" + QS)
    e.click("#makeBtn")
    e.wait_for_selector("[data-add='type']")
    check(e.is_visible("[data-add='order']"), "the editor offers Type answer and Put in order")
    e.click("[data-add='type']")
    e.wait_for_selector("input[name='accept']")
    e.context.close()

    h = page()
    h.goto(SITE + "/" + QS)
    h.evaluate("q => localStorage.setItem('rondas', JSON.stringify([q]))", Q)
    h.reload()
    h.click(".mineRow .btn.primary")
    h.wait_for_url(lambda u: "/host/" in u, timeout=30000)
    code = h.url.split("/host/")[1][:6]
    pl = {}
    for n in ("Ana", "Beto"):
        pg = page()
        pg.goto(f"{SITE}/{code}{QS}")
        pg.fill("#nameInput", n)
        pg.press("#nameInput", "Enter")
        pl[n] = pg
    h.wait_for_function("document.body.textContent.includes('Beto')", timeout=30000)

    # type answer
    h.click("#hNext")
    for n, said in (("Ana", "buenos aires"), ("Beto", "Rosario")):
        pl[n].wait_for_selector("input[name='typed']", timeout=30000)
        pl[n].fill("input[name='typed']", said)
        pl[n].press("input[name='typed']", "Enter")
    h.wait_for_selector(".typeRes", timeout=30000)
    check(h.inner_text(".typeRight") == "Buenos Aires" and "1 of 2" in h.inner_text(".typeRes"), "the screen shows the answer and 1 of 2 got it")  # pinned: the first accepted spelling is the one shown
    check("Rosario" in h.inner_text("div.typed") and "buenos aires" in h.inner_text("div.typed").lower(), "and what people typed")
    pl["Ana"].wait_for_selector(".big-ok", timeout=15000)
    check("Right" in pl["Ana"].inner_text(".big-ok") and pl["Ana"].is_visible(".gain"), "Ana: Right! with points (case and accent don't matter)")
    pl["Beto"].wait_for_selector(".big-no", timeout=15000)
    check("Buenos Aires" in pl["Beto"].inner_text("#pMain"), "Beto: not this time, and the right answer")
    h.click("#hNext")
    h.wait_for_selector(".board", timeout=15000)
    check("Ana" in h.inner_text(".top li:first-child"), "the ranking counts it")

    # put in order
    h.click("#hNext")
    shown = {}
    for n in ("Ana", "Beto"):
        pl[n].wait_for_selector(".pAnswers.order .pa", timeout=30000)
        shown[n] = [x.inner_text().strip() for x in pl[n].query_selector_all(".pAnswers.order .atext")]
    check(shown["Ana"] == shown["Beto"] and sorted(shown["Ana"]) == sorted(STEPS) and shown["Ana"] != STEPS, f"both see the same mix, not in order ({shown['Ana']})")
    for s in STEPS:
        pl["Ana"].click(f".pAnswers.order .pa:has-text('{s}')")
    pl["Ana"].click("#pMain button[name=sendOrder]")
    for s in reversed(STEPS):
        pl["Beto"].click(f".pAnswers.order .pa:has-text('{s}')")
    pl["Beto"].click("#pMain button[name=sendOrder]")
    h.wait_for_function("document.querySelector('.avg')?.textContent.includes('1 of 2')", timeout=30000)
    check([x.inner_text().strip() for x in h.query_selector_all(".hAnswers.order .atext")] == STEPS, "the screen shows the right order and 1 of 2")
    pl["Ana"].wait_for_selector(".big-ok", timeout=15000)
    pl["Beto"].wait_for_selector(".big-no", timeout=15000)
    check(pl["Beto"].query_selector(".orderList") is not None, "Beto: not this time, with the right order")
    h.click("#hNext")
    h.wait_for_selector(".board", timeout=15000)
    h.click("#hNext")
    h.wait_for_selector(".podium", timeout=15000)
    check("Ana" in h.inner_text(".step.s1"), "the podium: Ana first")
    with h.expect_download() as dl:
        h.click("#hNext")
    rows = list(csv.reader(io.StringIO(open(dl.value.path(), encoding="utf-8-sig").read())))
    ana = next(r for r in rows if r[0] == "Ana")
    beto = next(r for r in rows if r[0] == "Beto")
    check(ana[2] == "buenos aires ✓" and beto[2] == "Rosario ✗", "results file: typed answers with ✓/✗")  # pinned: the file keeps what was typed, as typed
    check(ana[3] == " → ".join(STEPS) + " ✓" and beto[3].endswith("✗"), "results file: the order each one gave")
    b.close()

print("\nALL OK" if not errors else "\nFAILED:\n" + "\n".join(errors))
sys.exit(1 if errors else 0)
