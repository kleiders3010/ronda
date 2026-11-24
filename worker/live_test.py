# The live site: a ronda starts on the game host (item 46: Cloudflare is where games go when the host can't be
# reached), people join and play it, and the game host's copy answers. Moving a game between servers is worker/failover_test.py (local: it needs
# to kill them; the live page takes no ?server= switch, APP-RULES safety 103).
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
    b = p.chromium.launch(headless=True, channel="msedge", args=["--disable-gpu"])

    def page():
        pg = b.new_context(locale="en-US").new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        return pg

    def play(qs, want_side, what):
        h = page()
        h.goto(SITE + "/" + qs)
        h.evaluate("q => localStorage.setItem('ronda.rondas', JSON.stringify([q]))", Q)
        h.reload()
        h.click(".mineRow .btn.primary")
        h.wait_for_url(lambda u: "/host/" in u, timeout=30000)
        code = h.url.split("/host/")[1][:6]
        check(sum(map(int, code)) % 2 == want_side, f"{what}: the ronda starts there (code {code})")
        pl = page()
        pl.goto(f"{SITE}/{code}{qs}")
        pl.fill("#nameInput", "Ana")
        pl.press("#nameInput", "Enter")
        h.wait_for_function("() => document.body.textContent.includes('Ana')", timeout=30000)
        h.click("#hNext")
        pl.wait_for_selector(".pa.c0", timeout=30000)
        pl.click(".pa.c0")
        pl.wait_for_function("() => document.getElementById('pScore').textContent.includes('points')", timeout=30000)
        check(True, f"{what}: someone joins and scores ({pl.text_content('#pScore')})")
        h.click("#hNext")
        h.wait_for_timeout(500)
        h.context.close()
        pl.context.close()

    # new rondas start on the game host (odd digit sum) since 2026-11-22 (item 46); Cloudflare when it does not answer
    play("", 1, "Game host")
    # The live page no longer takes ?server= (APP-RULES safety 103), so a Cloudflare outage can't be faked from here:
    # moving to the game host is worker/failover_test.py (local, it kills servers); here only that the game host
    # answers.
    import urllib.request
    # Cloudflare's edge refuses Python's default client name (403, 2026-11-23); a named client passes
    req = urllib.request.Request("https://games.jurisgames.com/ronda/api/health", headers={"User-Agent": "ronda-live-test"})
    with urllib.request.urlopen(req, timeout=20) as r:
        check(r.status == 200 and b"ok" in r.read(), "the game host's Ronda copy answers")  # pinned: health answers {"ok": true}
    check(not [e for e in errors if e.startswith("pageerror")], "no page errors")
    b.close()

print("errors:", errors)
print("OK" if not errors else "FAILED")
sys.exit(1 if errors else 0)
