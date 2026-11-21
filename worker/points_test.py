# Points per question, like Kahoot's (help 'How points work': Standard up to 1000, Double up to 2000, No points), and
# the answer streak shown on the phone (right answers in a row; no extra points). A host and two players.
# Editor: questions with a right answer have a Points picker (a poll doesn't) and the choice is kept.
# Game (three typed questions): 1 double (Ana right, Beto wrong), 2 no points (both right), 3 standard (both right).
# The big screen and the phones say "Double points" / "No points" while the question is up; Ana gets more than 1000
# on the double one, nothing on the no-points one (no "+0"), and her phone shows a streak of 2 after question 3 (the
# no-points question neither adds nor breaks it); Beto's streak is 1, so nothing shows.
#   python worker/points_test.py [site] [query, to pick the server]   (local: cd worker && npx wrangler dev -c wrangler.test.toml --port 8788)
import os
import re
import sys
sys.stdout.reconfigure(encoding='utf-8')
from playwright.sync_api import sync_playwright

SITE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8788"
QS = sys.argv[2] if len(sys.argv) > 2 else ""
Q = {"id": "points01", "title": "Points check", "questions": [
    {"kind": "type", "text": "Two plus two?", "accept": ["four", "4"], "time": 60, "pts": 2},
    {"kind": "type", "text": "Colour of the sky?", "accept": ["blue"], "time": 60, "pts": 0},
    {"kind": "type", "text": "Opposite of up?", "accept": ["down"], "time": 60}]}
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


with sync_playwright() as p:
    b = p.chromium.launch(headless=True, channel="msedge")

    def page(phone=False):
        pg = b.new_context(locale="en-US", viewport={"width": 390, "height": 760} if phone else {"width": 1280, "height": 720}).new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        return pg

    # the editor
    e = page(phone=True)
    e.goto(SITE + "/" + QS)
    e.click("#makeBtn")
    e.wait_for_selector("[data-add='poll']")
    first = e.locator(".qcard").first
    check(first.locator(".qpts select").count() == 1 and first.locator(".qpts select").input_value() == "1", "a quiz question has Points, standard to start")  # pinned: standard is the default, like Kahoot
    first.locator(".qpts select").select_option("2")
    first.locator(".qpts").evaluate("x => x.scrollIntoView({block: 'center'})")
    shot(e, "1-editor-points")
    e.click("[data-add='poll']")
    check(e.locator(".qcard").last.locator(".qpts").count() == 0, "a poll has no Points")
    e.wait_for_timeout(600)
    kept = e.evaluate("localStorage.getItem('ronda.rondas') || ''")
    check('"pts":2' in kept, "double points is kept with the ronda")
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

    shot_q = [False]

    def ask(answers):
        h.click("#hNext")
        for n in ("Ana", "Beto"):
            pl[n].wait_for_selector("input[name='typed']", timeout=30000)
        if not shot_q[0]:
            shot(h, "2-screen-double"); shot(pl["Ana"], "3-phone-double"); shot_q[0] = True
        tags = (h.locator(".qtop .ptsTag").all_inner_texts(), pl["Ana"].locator(".progress .ptsTag").all_inner_texts())
        for n, said in answers.items():
            pl[n].fill("input[name='typed']", said)
            pl[n].press("input[name='typed']", "Enter")
        h.wait_for_selector(".typeRes", timeout=30000)
        for n in ("Ana", "Beto"):
            pl[n].wait_for_selector(".big-ok, .big-no", timeout=15000)
        return tags

    # 1: double
    tags = ask({"Ana": "4", "Beto": "five"})
    check(tags == (["Double points"], ["Double points"]), f"the screen and the phone say Double points ({tags})")
    a1 = score(pl["Ana"])
    check(1000 < a1 <= 2000, f"Ana gets more than 1000 on a double question ({a1})")
    check(pl["Ana"].locator(".streak").count() == 0, "no streak shown after one right answer")
    check(pl["Ana"].locator(".big-no").count() == 0, "a right answer never also says 'Not this time'")
    check(pl["Beto"].locator(".big-no").count() == 1 and pl["Beto"].locator(".big-ok").count() == 0, "a wrong one says it once")
    h.click("#hNext")
    h.wait_for_selector(".board", timeout=15000)

    # 2: no points
    tags = ask({"Ana": "Blue", "Beto": "blue"})
    check(tags == (["No points"], ["No points"]), f"the screen and the phone say No points ({tags})")
    check("Right" in pl["Ana"].inner_text(".big-ok") and pl["Ana"].locator(".gain").count() == 0, "Right! with no '+0'")
    check(score(pl["Ana"]) == a1, "no points added")
    check(pl["Ana"].locator(".streak").count() == 0, "a no-points question doesn't add to the streak")
    h.click("#hNext")
    h.wait_for_selector(".board", timeout=15000)

    # 3: standard
    tags = ask({"Ana": "down", "Beto": "down"})
    check(tags == ([], []), f"no tag on a standard question ({tags})")
    a3 = score(pl["Ana"]) - a1
    check(0 < a3 <= 1000, f"standard: up to 1000 ({a3})")
    check("2" in pl["Ana"].inner_text(".streak"), "Ana: answer streak 2 (the no-points question didn't break it)")
    shot(pl["Ana"], "4-phone-streak")
    check(pl["Beto"].locator(".streak").count() == 0, "Beto: streak 1, nothing shown")

    b.close()

print("ALL OK" if not errors else "FAILED: " + "; ".join(errors))
sys.exit(1 if errors else 0)
