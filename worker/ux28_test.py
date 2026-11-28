# UX review 2026-11-28 (research/ux-review-2026-11-28/ronda.md in SelfSustainment), the high ones + plurals:
#   U-R1 a dropped link shows "Reconnecting…", an answer tapped while it is down arrives when it is back,
#        and a server that never answers says so (with Try again) instead of "Joining…" for ever;
#   U-R2 Back during a game asks once (host and player); home offers "Back to it" for a running room;
#   U-R3 closing a room without the results downloaded asks once;
#   U-R4 the host's footer fits a 360 dp phone (main button inside the screen);
#   U-R5 a blocked Start marks the question at fault and focuses it;
#   U-R7 "1 question" / "1 pregunta", not "1 questions".
# Run against the local server: cd worker && npx wrangler dev -c wrangler.test.toml --port 8788
#   python worker/ux28_test.py [base-url]
import sys

sys.stdout.reconfigure(encoding="utf-8")
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8788"
Q = {"id": "uxtest0001", "title": "UX check", "questions": [
    {"kind": "quiz", "text": "Two plus two?", "answers": ["4", "5", "", ""], "correct": [0], "time": 60}]}
BAD = {"id": "uxtest0002", "title": "Broken", "questions": [
    {"kind": "quiz", "text": "Fine one?", "answers": ["a", "b", "", ""], "correct": [0], "time": 20},
    {"kind": "quiz", "text": "", "answers": ["a", "b", "", ""], "correct": [0], "time": 20}]}
# every socket the page opens is kept, and new ones can be sent nowhere: a link that drops and stays down
SOCKS = """
const W = window.WebSocket;
window.__socks = [];
window.__block = false;
window.WebSocket = function (u, p) { const s = new W(window.__block ? "ws://127.0.0.1:9/down" : u, p); window.__socks.push(s); return s; };
window.WebSocket.prototype = W.prototype;
Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
"""
errors = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what, flush=True)
    if not ok:
        errors.append(what)


with sync_playwright() as p:
    b = p.chromium.launch(headless=True, channel="msedge", args=["--disable-gpu"])

    def page(width=1280, height=800, locale="en-US"):
        ctx = b.new_context(locale=locale, viewport={"width": width, "height": height})
        ctx.add_init_script(SOCKS)
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        return pg

    # U-R7 plurals, both languages
    for loc, want in (("en-US", "1 question"), ("es-AR", "1 pregunta")):
        pg = page(locale=loc)
        pg.goto(BASE + "/")
        pg.evaluate("q => localStorage.setItem('ronda.rondas', JSON.stringify([q]))", Q)
        pg.reload()
        row = pg.text_content(".mineRow .small") or ""
        check(row.strip() == want, f"U-R7 home list says {want!r} ({row!r})")  # pinned: one-question ronda
        pg.context.close()

    # U-R5 blocked Start: question 2 has no text
    h = page()
    h.goto(BASE + "/")
    h.evaluate("q => localStorage.setItem('ronda.rondas', JSON.stringify([q]))", BAD)
    h.reload()
    h.click(".mineRow .btn.primary")
    h.wait_for_selector(".qcard.bad", timeout=5000)
    bad = h.evaluate("() => [...document.querySelectorAll('.qcard')].findIndex((c) => c.classList.contains('bad'))")
    check(bad == 1, f"U-R5 the question at fault is marked (card {bad})")  # pinned: BAD's second question
    focused = h.evaluate("() => !!document.activeElement.closest('.qcard.bad')")
    check(focused, "U-R5 the focus is in the question at fault")
    inview = h.evaluate("() => { const r = document.querySelector('.qcard.bad').getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }")
    check(inview, "U-R5 the question at fault is on screen")
    h.context.close()

    # a game: host (phone width for U-R4) + one player
    h = page(360, 740)
    h.goto(BASE + "/")
    h.evaluate("q => localStorage.setItem('ronda.rondas', JSON.stringify([q]))", Q)
    h.reload()
    h.click(".mineRow .btn.primary")
    h.wait_for_url(lambda u: "/host/" in u, timeout=30000)
    code = h.url.split("/host/")[1][:6]
    pl = page(360, 740)
    pl.goto(f"{BASE}/{code}")
    pl.fill("#nameInput", "Ana")
    pl.press("#nameInput", "Enter")
    h.wait_for_function("() => document.body.textContent.includes('Ana')", timeout=30000)

    fit = h.evaluate("""() => { const f = document.querySelector('.hfoot'), n = document.getElementById('hNext').getBoundingClientRect();
        return { over: f.scrollWidth - f.clientWidth, right: n.right, vw: innerWidth }; }""")
    check(fit["over"] <= 0 and fit["right"] <= fit["vw"], f"U-R4 host footer fits 360 dp ({fit})")

    h.click("#hNext")
    pl.wait_for_selector(".pa.c0", timeout=30000)

    # U-R1 the player's link drops and stays down; an answer tapped meanwhile arrives once it is back
    # close() alone waits for the server to answer the close (wrangler dev never did): the drop is reported at once,
    # as the browser does when the network goes
    pl.evaluate("() => { window.__block = true; window.__socks.filter((s) => s.readyState < 2).forEach((s) => { s.close(); s.onclose?.(new CloseEvent('close')); }); }")
    pl.wait_for_timeout(1800)
    bar = pl.evaluate("() => { const n = document.getElementById('net'); return n && !n.hidden ? n.textContent : ''; }")
    check("Reconnecting" in bar, f"U-R1 a dropped link says so ({bar!r})")
    pl.click(".pa.c0")
    pl.evaluate("() => { window.__block = false; }")
    try:
        # one player: the question ends as soon as the answer is in, and the phone shows the result
        pl.wait_for_function("() => /Right!/.test(document.getElementById('pMain').textContent)", timeout=15000)
        check(True, "U-R1 the answer tapped while the link was down arrives")
    except Exception:
        seen = h.evaluate("() => document.querySelector('.answered')?.textContent")
        mine = pl.evaluate("() => [document.getElementById('pMain').textContent.slice(0, 80), window.__socks.map((s) => s.readyState)]")
        check(False, f"U-R1 the answer tapped while the link was down arrives (host {seen!r}, player {mine})")
    pl.wait_for_function("() => { const n = document.getElementById('net'); return !n || n.hidden; }", timeout=10000)
    check(True, "U-R1 the bar goes when the link is back")

    # U-R2 Back during the game asks; Stay keeps the game
    pl.go_back()
    pl.wait_for_selector("#leaveAsk", timeout=3000)
    pl.click("#leaveAsk .btn.primary")
    check(pl.url.rstrip("/").endswith("/" + code), f"U-R2 player: Back asks, Stay keeps the game ({pl.url})")
    h.go_back()
    asked = True
    try:
        h.wait_for_selector("#leaveAsk", timeout=3000)
    except Exception:
        asked = False
    check(asked, "U-R2 host: Back during the game asks")
    if asked:
        h.click("#leaveAsk .btn.ghost")  # Leave
        h.wait_for_selector(".mineRow.running", timeout=5000)
        h.click(".mineRow.running .btn.primary")
        h.wait_for_url(lambda u: "/host/" + code in u, timeout=5000)
        h.wait_for_selector("#hNext", state="visible", timeout=15000)
        check(True, "U-R2 home offers Back to it, and it goes back to the room")

    # to the end: reveal, (board), finish
    for _ in range(4):
        if h.evaluate("() => document.getElementById('hNext').textContent") == "Download results":
            break
        h.click("#hNext")
        h.wait_for_timeout(800)
    # U-R3 closing without the results asks once
    h.click("text=Close the room")
    h.wait_for_selector(".closeAsk", timeout=3000)
    check(h.url.endswith("/host/" + code), "U-R3 Close without results asks first (still on the room)")

    # U-R1 a server that never answers: a worded error with Try again, not Joining… for ever
    pg = page(360, 740)
    pg.add_init_script("window.__block = true")
    pg.goto(f"{BASE}/{code}")
    pg.fill("#nameInput", "Bo")
    pg.press("#nameInput", "Enter")
    pg.wait_for_timeout(16500)
    bar = pg.evaluate("() => { const n = document.getElementById('net'); return n && !n.hidden ? n.textContent : ''; }")
    check("Can't reach Ronda" in bar and "Try again" in bar, f"U-R1 no server: worded error with Try again ({bar!r})")

    check(not [e for e in errors if e.startswith("pageerror")], "no page errors")
    b.close()

print("errors:", errors)
print("OK" if not errors else "FAILED")
sys.exit(1 if errors else 0)
