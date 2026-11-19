# Short screens: a host on a 1280x720 laptop (or projector) and players on a phone held sideways (740x360) and
# upright (360x640), with a long question and six long answers, then four. Checked: the host sees the question, all four
# answers and the Next button without scrolling; a player can reach (and tap) every answer; every button anyone sees
# has text that stands out from what's behind it (the players' Questions button was once white on white).
#   python worker/screens_test.py [site]
import sys
sys.stdout.reconfigure(encoding='utf-8')
from playwright.sync_api import sync_playwright

SITE = sys.argv[1] if len(sys.argv) > 1 else "https://quiz.jurisgames.com"
LONG = "Which of these rivers flows through the most countries before it reaches the sea, counting every border it crosses?"
ANS = ["The Danube, through ten countries", "The Nile, from Lake Victoria north", "The Amazon, mostly through Brazil", "The Rhine, from the Alps to the North Sea",
       "The Mekong, from Tibet to Vietnam", "The Niger, in a long arc through West Africa"]
Q = {"id": "screens01", "title": "Screens check", "questions": [
    {"kind": "quiz", "text": LONG, "answers": ANS, "correct": [0], "time": 120},
    {"kind": "quiz", "text": LONG, "answers": ANS[:4], "correct": [0], "time": 120}]}
errors = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what, flush=True)
    if not ok:
        errors.append(what)


IN_VIEW = """(sel) => [...document.querySelectorAll(sel)].map(e => { const r = e.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth + 1; })"""
# each visible button with text: contrast of its text colour against the first solid background behind it
CONTRAST = """() => { const rgb = (c) => (c.match(/[\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b) };
  const out = [];
  for (const e of document.querySelectorAll('button, .btn')) {
    const r = e.getBoundingClientRect(), txt = e.textContent.trim();
    if (!txt || !r.width || !r.height || getComputedStyle(e).visibility === 'hidden') continue;
    let bg = null;
    for (let x = e; x; x = x.parentElement) { const c = rgb(getComputedStyle(x).backgroundColor); if (c.length === 3 || c[3] > .5) { bg = c; break } }
    const a = lum(rgb(getComputedStyle(e).color)), b = lum(bg || [255, 255, 255]);
    const k = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    if (k < 3) out.push(txt.slice(0, 20) + ' ' + k.toFixed(1));
  }
  return out }"""
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
    for n in (6, 4):
        h.click("#hNext")  # the question
        h.wait_for_function(f"document.querySelectorAll('.ha').length === {n}", timeout=30000)
        h.wait_for_timeout(800)
        seen = h.evaluate(IN_VIEW, ".ha, #hNext")
        check(len(seen) == n + 1 and all(seen), f"1280x720 host: {n} answers and Next on screen without scrolling ({seen})")
        for pl, w, ht in players:
            pl.wait_for_function(f"document.querySelectorAll('.pa').length === {n}", timeout=30000)
            pl.wait_for_timeout(500)
            r = pl.evaluate(REACH, ".pa")
            check(len(r) == n and all(r), f"{w}x{ht} player: all {n} answers can be reached and tapped ({r})")
            low = pl.evaluate(CONTRAST)
            check(not low, f"{w}x{ht} player: every button's text stands out from its background ({low})")
        low = h.evaluate(CONTRAST)
        check(not low, f"1280x720 host: every button's text stands out from its background ({low})")
        if n == 6:
            h.click("#hNext")  # results
            h.wait_for_selector(".ha.right", timeout=30000)
            h.click("#hNext")  # ranking
            h.wait_for_selector(".board", timeout=30000)
    h.context.close()
    b.close()

print("\nALL OK" if not errors else "\nFAILED:\n" + "\n".join(errors))
sys.exit(1 if errors else 0)
