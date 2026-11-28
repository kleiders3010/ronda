# A player's phone when the host's screen drops, and when the link itself dies without closing (2026-11-28, Ronda
# leftovers after the UX review):
#   1. the host's screen goes away: the phone says so after a short grace ("Stay here: the game goes on"), and the
#      line goes when the host is back;
#   2. heartbeat: a link that stays "open" but carries nothing (a phone that changed networks) is found by its
#      unanswered "ping" and reopened, and the game goes on on the new link.
# ?beat=0.1 on the phone makes the heartbeat and the grace ten times shorter (never under 1 s a ping).
# Run against the local server: cd worker && npx wrangler dev -c wrangler.test.toml --port 8788
#   python worker/hostleft_test.py [base-url]
import sys

sys.stdout.reconfigure(encoding="utf-8")
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8788"
Q = {"id": "uxhostl001", "title": "Host left", "questions": [
    {"kind": "quiz", "text": "First", "answers": ["a", "b", "", ""], "correct": [0], "time": 0},
    {"kind": "quiz", "text": "Second", "answers": ["c", "d", "", ""], "correct": [0], "time": 0}]}
errors = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what, flush=True)
    if not ok:
        errors.append(what)


def soft(fn, *a, **k):
    try:
        fn(*a, **k)
        return True
    except Exception:
        return False


with sync_playwright() as p:
    b = p.chromium.launch(headless=True, channel="msedge", args=["--disable-gpu"])

    def page(width=360, height=740):
        pg = b.new_context(locale="en-US", viewport={"width": width, "height": height}).new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        return pg

    h = page(1280, 800)
    h.goto(BASE + "/")
    h.evaluate("q => localStorage.setItem('ronda.rondas', JSON.stringify([q]))", Q)
    h.reload()
    h.click(".mineRow .btn.primary")
    h.wait_for_url(lambda u: "/host/" in u, timeout=30000)
    code = h.url.split("/host/")[1][:6]
    host_url = h.url

    # the phone's link goes through here: the first one can be made silent (open, but nothing passes)
    pl = page()
    links = {"n": 0, "silent": False}

    def relay(ws):
        links["n"] += 1
        mine = links["n"]
        server = ws.connect_to_server()
        ws.on_message(lambda m: None if (links["silent"] and mine == 1) else server.send(m))
        server.on_message(lambda m: None if (links["silent"] and mine == 1) else ws.send(m))

    pl.route_web_socket(lambda u: "/ws/" in u, relay)
    pl.goto(f"{BASE}/{code}?beat=0.1")
    pl.wait_for_selector("#name:not([hidden])")
    pl.fill("#nameInput", "Ana")
    pl.press("#nameInput", "Enter")
    h.wait_for_selector(".who", timeout=30000)
    pl.wait_for_function("() => document.getElementById('pMain').textContent.length > 0", timeout=10000)

    # 1. the host's screen goes away, then comes back
    check(pl.locator("#pHost").count() == 1 and pl.is_hidden("#pHost"), "with the host here, no 'host left' line")
    h.goto(BASE + "/")
    shown = soft(pl.wait_for_selector, "#pHost:visible", timeout=10000)
    check(shown, "the host's screen went away: the phone says so")
    if shown:
        check("Stay here" in pl.inner_text("#pHost"), f"it tells the player to stay ({pl.inner_text('#pHost')!r})")  # pinned: the decision: stay, the game goes on
    h.goto(host_url)
    back = soft(pl.wait_for_selector, "#pHost", state="hidden", timeout=15000)
    check(back, "the host is back: the line goes")

    # 2. the heartbeat: the link goes silent without closing; the phone finds out and opens a new one
    before = links["n"]
    links["silent"] = True
    for _ in range(40):  # up to 10 s: at ?beat=0.1 a ping every 2 s, its answer awaited 0.8 s
        if links["n"] > before:
            break
        pl.wait_for_timeout(250)
    check(links["n"] > before, f"a silent link is found and a new one opened ({before} -> {links['n']} links)")
    h.wait_for_selector("#hNext:not([disabled])", timeout=15000)
    h.click("#hNext")
    goes_on = soft(pl.wait_for_function, "() => document.getElementById('pMain').textContent.includes('a')", timeout=15000)
    check(goes_on and pl.locator("#pMain button").count() >= 2, "the game goes on over the new link")

    check(not [e for e in errors if e.startswith("pageerror")], "no page errors")
    b.close()

print("errors:", errors)
print("OK" if not errors else "FAILED")
sys.exit(1 if errors else 0)
