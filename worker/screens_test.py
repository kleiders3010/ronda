# Short screens: a host on a 1280x720 laptop (or projector) and players on a phone held sideways (740x360) and
# upright (360x640), with a long question and four long answers. Checked: the host sees the question, all four
# answers and the Next button without scrolling; a player can reach (and tap) every answer.
#   python worker/screens_test.py [site]
import sys
sys.stdout.reconfigure(encoding='utf-8')
from playwright.sync_api import sync_playwright

SITE = sys.argv[1] if len(sys.argv) > 1 else "https://quiz.jurisgames.com"
LONG = "Which of these rivers flows through the most countries before it reaches the sea, counting every border it crosses?"
ANS = ["The Danube, through ten countries", "The Nile, from Lake Victoria north", "The Amazon, mostly through Brazil", "The Rhine, from the Alps to the North Sea"]
Q = {"id": "screens01", "title": "Screens check", "questions": [
    {"kind": "quiz", "text": LONG, "answers": ANS, "correct": [0], "time": 120}]}
errors = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what, flush=True)
    if not ok:
        errors.append(what)


IN_VIEW = """(sel) => [...document.querySelectorAll(sel)].map(e => { const r = e.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth + 1; })"""
REACH = """(sel) => [...document.querySelectorAll(sel)].map(e => { e.scrollIntoView({block: 'nearest'}); const r = e.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y);
  return !!hit && (hit === e || e.contains(hit)); })"""

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, channel="msedge")

    def page(w, h):
        pg = b.new_context(locale="en-US", viewport={"width": w, "height": h}).new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        return pg

    h = page(1280, 720)
    h.goto(SITE + "/")
    h.evaluate("q => localStorage.setItem('rondas', JSON.stringify([q]))", Q)
    h.reload()
    h.click(".mineRow .btn.primary")
    h.wait_for_url(lambda u: "/host/" in u, timeout=30000)
    code = h.url.split("/host/")[1][:6]
    players = []
    for i, (w, ht) in enumerate(((740, 360), (360, 640))):
        pl = page(w, ht)
        pl.goto(f"{SITE}/{code}")
        pl.fill("#nameInput", f"P{i}")
        pl.press("#nameInput", "Enter")
        players.append((pl, w, ht))
    h.wait_for_function("document.body.textContent.includes('P1')", timeout=30000)
    h.click("#hNext")
    h.wait_for_selector(".ha", timeout=30000)
    h.wait_for_timeout(800)
    seen = h.evaluate(IN_VIEW, ".ha, #hNext")
    check(len(seen) == 5 and all(seen), f"1280x720 host: four answers and Next on screen without scrolling ({seen})")
    for pl, w, ht in players:
        pl.wait_for_selector(".pa.c3", timeout=30000)
        pl.wait_for_timeout(500)
        r = pl.evaluate(REACH, ".pa")
        check(len(r) == 4 and all(r), f"{w}x{ht} player: every answer can be reached and tapped ({r})")
    h.context.close()
    b.close()

print("\nALL OK" if not errors else "\nFAILED:\n" + "\n".join(errors))
sys.exit(1 if errors else 0)
