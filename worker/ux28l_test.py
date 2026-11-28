# UX review 2026-11-28 (research/ux-review-2026-11-28/ronda.md in SelfSustainment), the low ones U-R23..U-R29:
#   U-R23 an empty name / word says why under the field; U-R25 "Remove animations" stops the pops and bars;
#   U-R26 home and editor follow the system's dark theme; U-R27 a player's phone asks to stay awake;
#   U-R28 the audience Q&A isn't called "Questions" on the host; U-R29 the editor's amber / cyan rows carry white
#   letters at 4.5:1 or more.
# Run against the local server: cd worker && npx wrangler dev -c wrangler.test.toml --port 8788
#   python worker/ux28l_test.py [base-url]
import sys

sys.stdout.reconfigure(encoding="utf-8")
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8788"
Q = {"id": "uxtestl001", "title": "Lows", "questions": [
    {"kind": "words", "text": "One word?", "time": 0},
    {"kind": "quiz", "text": "Pick", "answers": ["a", "b", "c", ""], "correct": [0], "time": 60}]}
WAKE = "window.__wake = 0; Object.defineProperty(navigator, 'wakeLock', { value: { request: async () => { window.__wake++; return { release() {} }; } } });"
errors = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what, flush=True)
    if not ok:
        errors.append(what)


def ratio(rgb):
    def lum(c):
        c = [x / 255 for x in c]
        c = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    return 1.05 / (lum(rgb) + 0.05)


with sync_playwright() as p:
    b = p.chromium.launch(headless=True, channel="msedge", args=["--disable-gpu"])

    def page(width=360, height=740, **kw):
        ctx = b.new_context(locale="en-US", viewport={"width": width, "height": height}, **kw)
        ctx.add_init_script(WAKE)
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        return pg

    # U-R26 dark and light
    for scheme, dark in (("dark", True), ("light", False)):
        pg = page(color_scheme=scheme)
        pg.goto(BASE + "/")
        pg.evaluate("q => localStorage.setItem('ronda.rondas', JSON.stringify([q]))", Q)
        pg.goto(BASE + "/edit/" + Q["id"])
        pg.wait_for_selector(".qcard")
        bg = pg.evaluate("() => { for (let n = document.getElementById('edit'); n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (c !== 'rgba(0, 0, 0, 0)') return c; } return 'rgb(255, 255, 255)'; }")  # the colour shown
        nums = [int(x) for x in bg[bg.index("(") + 1:bg.index(")")].split(",")[:3]]
        check((sum(nums) < 150) == dark, f"U-R26 the editor follows the {scheme} theme ({bg})")
        if not dark:
            # U-R29 the amber and cyan editor rows (the quiz question)
            rows = pg.evaluate("() => ['.aedit.c1', '.aedit.c2'].map((s) => getComputedStyle(document.querySelector(s)).backgroundColor)")
            rs = [ratio([int(x) for x in r[r.index("(") + 1:r.index(")")].split(",")[:3]]) for r in rows]
            check(min(rs) >= 4.5, f"U-R29 white letters on the amber / cyan rows reach 4.5:1 ({[round(x, 1) for x in rs]})")  # pinned: WCAG AA
        pg.context.close()

    # a game: host + a player with "Remove animations" on
    h = page(1280, 800)
    h.goto(BASE + "/")
    h.evaluate("q => localStorage.setItem('ronda.rondas', JSON.stringify([q]))", Q)
    h.reload()
    h.click(".mineRow .btn.primary")
    h.wait_for_url(lambda u: "/host/" in u, timeout=30000)
    code = h.url.split("/host/")[1][:6]
    hq = h.text_content("#hQa") or ""
    check("Questions" not in hq, f"U-R28 the host's Q&A button isn't called Questions ({hq!r})")
    pl = page(reduced_motion="reduce")
    pl.goto(f"{BASE}/{code}")
    pl.wait_for_selector("#name:not([hidden])")
    pl.fill("#nameInput", "")
    pl.press("#nameInput", "Enter")
    said = pl.evaluate("() => { const i = document.getElementById('nameInput'), m = document.getElementById(i.getAttribute('aria-describedby') || '-'); return [i.getAttribute('aria-invalid'), m && !m.hidden ? m.textContent : '']; }")
    check(said[0] == "true" and "name" in said[1], f"U-R23 an empty name says why, under the field ({said})")  # pinned: ARIA "true"
    pl.fill("#nameInput", "Ana")
    pl.press("#nameInput", "Enter")
    h.wait_for_selector(".who", timeout=30000)
    pl.wait_for_function("() => window.__wake > 0", timeout=10000)
    check(True, "U-R27 the player's phone asks to stay awake")
    h.click("#hNext")
    pl.wait_for_selector(".wordForm input", timeout=30000)
    pl.click(".wordForm .btn.primary")
    msg = pl.evaluate("() => [...document.querySelectorAll('.fieldMsg')].filter((m) => !m.hidden).map((m) => m.textContent)")
    check(bool(msg), f"U-R23 an empty word says why ({msg})")
    anim = pl.evaluate("() => { const d = document.createElement('div'); d.className = 'talkNote'; document.body.append(d); const a = getComputedStyle(d).animationName; d.remove(); return a; }")
    check(anim == "none", f"U-R25 with Remove animations on, nothing pops ({anim!r})")  # pinned: CSS keyword

    check(not [e for e in errors if e.startswith("pageerror")], "no page errors")
    b.close()

print("errors:", errors)
print("OK" if not errors else "FAILED")
sys.exit(1 if errors else 0)
