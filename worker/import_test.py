# Audit R13: a ronda that comes in a link or a file is cleaned to the shapes the server takes; a link asks before it
# adds anything; a save that didn't work never says "Saved".
#   python worker/import_test.py [site]   (local: cd worker && npx wrangler dev --port 8788)
import base64, json, sys
from playwright.sync_api import sync_playwright

SITE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8788"
errors = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok:
        errors.append(what)


def link(data):
    return SITE + "/#r=j" + base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")


ODD = {"title": 12345, "questions": [None, "text", {"kind": "quiz", "text": {"x": 1}, "answers": [1, None, "b"], "correct": [9, 1]},
                                     {"kind": "nope", "text": "Two plus two?", "answers": ["4", "5"], "correct": [0], "evil": "<img src=x>"},
                                     {"kind": "slider", "text": "How far?", "min": "a", "max": 10, "ans": 5}]}

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page()
    page_errors = []
    page.on("pageerror", lambda e: page_errors.append(str(e)))
    page.goto(SITE + "/")
    page.evaluate("() => localStorage.clear()")

    page.goto(link(ODD))
    page.wait_for_selector("#addSheet", timeout=10000)
    sheet = page.inner_text("#addSheet")
    check("Add this ronda?" in sheet and "3 questions" in sheet, f"a link asks first, saying what it is ({sheet!r})")
    check(page.evaluate("() => JSON.parse(localStorage.getItem('ronda.rondas') || '[]').length") == 0, "nothing is saved before Add")
    page.click("#addSheet >> text=Cancel")
    check(page.locator("#addSheet").count() == 0 and "#r=" not in page.url, "Cancel: nothing added, the link is gone from the address")
    check(page.evaluate("() => JSON.parse(localStorage.getItem('ronda.rondas') || '[]').length") == 0, "and nothing was saved")

    page.goto(link(ODD))
    page.wait_for_selector("#addSheet", timeout=10000)
    page.click("#addSheet [name=add]")
    page.wait_for_url(lambda u: "/edit/" in u, timeout=10000)
    saved = page.evaluate("() => JSON.parse(localStorage.getItem('ronda.rondas'))[0]")
    qs = saved["questions"]
    check(len(qs) == 3 and all(isinstance(q.get("text"), str) for q in qs), f"Add: 3 questions kept, every text is text ({[q.get('text') for q in qs]})")
    check(qs[1]["kind"] == "quiz" and "evil" not in qs[1], "an unknown kind becomes a quiz question; unknown fields are dropped")  # pinned: audit R13, same kinds as the server
    check(qs[0]["answers"] == ["1", "", "b"] and qs[0]["correct"] == [1], f"answers become text, right answers that don't exist are dropped ({qs[0]['answers']}, {qs[0]['correct']})")
    check(saved["title"] == "12345", "the title is text")  # pinned: audit R13, numbers become text
    check(page.locator(".qcard").count() == 3, "the editor opens with them")

    # a full storage: the editor says it didn't save
    page.evaluate("""() => { let i = 0; for (const n of [1 << 20, 1 << 16, 1 << 12, 1 << 8, 16, 1]) { try { for (;;) localStorage.setItem('fill' + i++, 'x'.repeat(n)); } catch {} } }""")
    page.locator(".qcard textarea.qtext").nth(1).fill("Changed while full " + "y" * 200)
    page.wait_for_function("() => document.querySelector('#saved').textContent.includes('Not saved')", timeout=5000)
    check(True, "storage full: the editor says Not saved, never Saved")
    check(page.locator(".toast", has_text="storage is full").count() >= 1, "and tells what to do")
    page.evaluate("() => Object.keys(localStorage).filter((k) => k.startsWith('fill')).forEach((k) => localStorage.removeItem(k))")

    # what an older version kept under the bare key moves over once (audit R11)
    page.evaluate("() => { localStorage.clear(); localStorage.setItem('rondas', JSON.stringify([{ id: 'old1234567', title: 'Old one', questions: [] }])); }")
    page.goto(SITE + "/")
    page.wait_for_selector("#home:not([hidden])", timeout=10000)
    moved = page.evaluate("() => [localStorage.getItem('rondas'), JSON.parse(localStorage.getItem('ronda.rondas') || '[]').map((q) => q.title)]")
    check(moved[0] is None and moved[1] == ["Old one"], f"an older version's saved rondas move to the ronda. key ({moved})")  # pinned: audit R11, the key prefix

    page.goto(SITE + "/#r=jnot-a-ronda")
    page.wait_for_selector(".toast", timeout=5000)
    check("broken" in page.inner_text("#toasts") and page.locator("#addSheet").count() == 0, "a broken link: says so, asks nothing")
    check(not page_errors, f"no page errors {page_errors}")
    b.close()

print("errors:", errors)
print("OK" if not errors else "FAILED")
sys.exit(1 if errors else 0)
