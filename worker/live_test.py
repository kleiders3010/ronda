# The live site with its two room servers: a ronda on Cloudflare (even code) and, when Cloudflare can't be reached
# (here: an address that doesn't exist in its place), one on the game host (odd code); people join and play both.
# Killing a server in the middle of a game is worker/failover_test.py (local: it needs to kill them).
#   python worker/live_test.py [site]
import sys

from playwright.sync_api import sync_playwright

SITE = sys.argv[1] if len(sys.argv) > 1 else "https://quiz.jurisgames.com"
Q = {"id": "livetest01", "title": "Live check", "questions": [
    {"kind": "quiz", "text": "Two plus two?", "answers": ["4", "5", "", ""], "correct": [0], "time": 60}]}
errors = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what, flush=True)
    if not ok:
        errors.append(what)


with sync_playwright() as p:
    b = p.chromium.launch(headless=True, channel="msedge")

    def page():
        pg = b.new_context(locale="en-US").new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        return pg

    def play(qs, want_side, what):
        h = page()
        h.goto(SITE + "/" + qs)
        h.evaluate("q => localStorage.setItem('rondas', JSON.stringify([q]))", Q)
        h.reload()
        h.click(".mineRow .btn.primary")
        h.wait_for_url(lambda u: "/host/" in u, timeout=30000)
        code = h.url.split("/host/")[1][:6]
        check(sum(map(int, code)) % 2 == want_side, f"{what}: the ronda starts there (code {code})")
        pl = page()
        pl.goto(f"{SITE}/{code}{qs}")
        pl.fill("#nameInput", "Ana")
        pl.press("#nameInput", "Enter")
        h.wait_for_function("document.body.textContent.includes('Ana')", timeout=30000)
        h.click("#hNext")
        pl.wait_for_selector(".pa.c0", timeout=30000)
        pl.click(".pa.c0")
        pl.wait_for_function("document.getElementById('pScore').textContent.includes('points')", timeout=30000)
        check(True, f"{what}: someone joins and scores ({pl.text_content('#pScore')})")
        h.click("#hNext")
        h.wait_for_timeout(500)
        h.context.close()
        pl.context.close()

    play("", 0, "Cloudflare")
    play("?server=wss://down.invalid&server2=wss://games.jurisgames.com/ronda", 1, "Cloudflare unreachable, the game host")
    check(not [e for e in errors if e.startswith("pageerror")], "no page errors")
    b.close()

print("errors:", errors)
print("OK" if not errors else "FAILED")
sys.exit(1 if errors else 0)
