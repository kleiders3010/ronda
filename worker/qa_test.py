# Audience questions (like Slido's Q&A): people ask the host from their phones, by name or anonymously, and upvote;
# the host sees them by votes, shows one on the big screen, marks it answered, can approve each one first, can close
# questions, and saves them to a file. A host and two players (one on a small phone).
#   python worker/qa_test.py [site] [query, to pick the server]   (local: cd worker && npx wrangler dev --port 8788)
import csv
import io
import sys
sys.stdout.reconfigure(encoding='utf-8')
from playwright.sync_api import sync_playwright

SITE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8788"
QS = sys.argv[2] if len(sys.argv) > 2 else ""
Q = {"id": "qa01", "title": "Q&A check", "questions": [{"kind": "poll", "text": "Coffee or tea?", "answers": ["Coffee", "Tea"], "time": 0}]}
QA1 = "Will the slides be shared after the talk?"
QA2 = "Is there a break before lunch?"
QA3 = "Can we get the recording?"
errors = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what, flush=True)
    if not ok:
        errors.append(what)


def ask(pg, text, anon=False):
    pg.fill("#askForm textarea[name=ask]", text)
    if anon:
        pg.check("#askForm input[name=anon]")
    pg.click("#askForm button[name=sendAsk]")


def items(pg, ul):
    return pg.eval_on_selector_all(ul + " .qaItem", "els => els.map(e => e.innerText)")


with sync_playwright() as p:
    b = p.chromium.launch(headless=True, channel="msedge")

    def page(vp=None):
        pg = b.new_context(locale="en-US", accept_downloads=True, **({"viewport": vp} if vp else {})).new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        return pg

    h = page({"width": 1280, "height": 720})
    h.goto(SITE + "/" + QS)
    h.evaluate("q => localStorage.setItem('rondas', JSON.stringify([q]))", Q)
    h.reload()
    h.click(".mineRow .btn.primary")
    h.wait_for_url(lambda u: "/host/" in u, timeout=30000)
    code = h.url.split("/host/")[1][:6]
    pl = {}
    for n, vp in (("Ana", None), ("Beto", {"width": 360, "height": 640})):
        pg = page(vp)
        pg.goto(f"{SITE}/{code}{QS}")
        pg.fill("#nameInput", n)
        pg.press("#nameInput", "Enter")
        pg.wait_for_selector("#pQa:not([hidden])", timeout=30000)
        pl[n] = pg
    ana, beto = pl["Ana"], pl["Beto"]
    check(True, "players see a Questions button")  # pinned: questions are open by default

    # asking and voting
    ana.click("#pQa")
    ask(ana, QA1)
    beto.click("#pQa")
    ask(beto, QA2, anon=True)
    beto.wait_for_function(f"document.querySelector('#pQaList').innerText.includes({QA1!r})", timeout=15000)
    beto.click(f"#pQaList .qaItem:has-text({QA1!r}) button[name=vote]")
    ana.wait_for_function(f"document.querySelector('#pQaList .qaItem')?.innerText.includes({QA1!r}) && document.querySelector('#pQaList .qaItem button[name=vote]').innerText.includes('1')", timeout=15000)
    got = items(ana, "#pQaList")
    check(len(got) == 2 and "Anonymous" in got[1] and "Beto" not in "".join(got), "Ana sees both, hers on top with 1 vote, Beto's anonymous")
    check("Yours" in got[0], "and hers marked as hers")
    beto.wait_for_function("document.querySelector('#pQaList button[aria-pressed=true]')", timeout=15000)
    inview = beto.evaluate("""() => ['#askForm button[name=sendAsk]', '#pQaClose', '#pQaList button[name=vote]'].map(s => {
      const r = document.querySelector(s).getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; })""")
    check(all(inview), f"on a small phone: send, close and the votes are on screen ({inview})")
    beto.click(f"#pQaList .qaItem:has-text({QA1!r}) button[name=vote]")  # takes it back
    ana.wait_for_function("document.querySelector('#pQaList .qaItem button[name=vote]').innerText.includes('0')", timeout=15000)
    beto.click(f"#pQaList .qaItem:has-text({QA1!r}) button[name=vote]")
    ana.wait_for_function("document.querySelector('#pQaList .qaItem button[name=vote]').innerText.includes('1')", timeout=15000)
    check(True, "a vote can be taken back and given again")

    # the host
    h.wait_for_function("document.querySelector('#hQa').textContent.includes('2')", timeout=15000)
    h.click("#hQa")
    got = items(h, "#hQaList")
    check(len(got) == 2 and QA1 in got[0] and "Ana" in got[0] and "Anonymous" in got[1] and "Beto" not in got[1], "the host sees them by votes; anonymous stays anonymous")
    h.click(f"#hQaList .qaItem:has-text({QA1!r}) button[name=show]")
    h.wait_for_selector("#hQaShow:not([hidden])", timeout=15000)
    check(h.inner_text("#hQaShow .qaBig") == QA1 and "Ana" in h.inner_text("#hQaShow .qaWho"), "shown on the big screen, with who asked")
    ana.wait_for_function("document.querySelector('#pQaList .qaItem.hi')", timeout=15000)
    check("On the screen now" in ana.inner_text("#pQaList .qaItem.hi"), "phones say it's on the screen now")
    check(h.is_hidden("#hQaPanel"), "showing one closes the list")
    h.click("#hQaShow button[data-do=done]")
    h.wait_for_selector("#hQaShow", state="hidden", timeout=15000)
    beto.wait_for_function(f"document.querySelector('#pQaList .qaItem.done')?.innerText.includes({QA1!r})", timeout=15000)
    check(beto.is_disabled("#pQaList .qaItem.done button[name=vote]") and "Answered" in beto.inner_text("#pQaList .qaItem.done"), "answered: marked, last, no more votes")

    # review before it shows
    h.click("#hQa")
    h.check("#qaMod")
    h.wait_for_timeout(600)
    ask(ana, QA3)
    h.wait_for_function("document.querySelector('#hQa').textContent.includes('approve')", timeout=15000)
    ana.wait_for_function(f"document.querySelector('#pQaList').innerText.includes({QA3!r})", timeout=15000)
    check("Waiting for the host" in ana.inner_text(f"#pQaList .qaItem:has-text({QA3!r})"), "with review on, the asker sees it waiting")
    beto.wait_for_timeout(800)
    check(QA3 not in beto.inner_text("#pQaList"), "and nobody else sees it yet")
    h.click(f"#hQaList .qaItem:has-text({QA3!r}) button[name=ok]")
    beto.wait_for_function(f"document.querySelector('#pQaList').innerText.includes({QA3!r})", timeout=15000)
    check(True, "approved: everyone sees it")
    h.click(f"#hQaList .qaItem:has-text({QA2!r}) button[name=del]")
    ana.wait_for_function(f"!document.querySelector('#pQaList').innerText.includes({QA2!r})", timeout=15000)
    check(True, "the host can delete one")

    # closed
    h.uncheck("#qaOpen")
    ana.wait_for_selector("#askClosed:not([hidden])", timeout=15000)
    check(ana.is_hidden("#askForm"), "closed: no more asking, the list stays")

    # the questions file
    with h.expect_download() as dl:
        h.click("#qaSave")
    rows = list(csv.reader(io.StringIO(open(dl.value.path(), encoding="utf-8-sig").read())))
    check(rows[0][:3] == ["Question", "Asked by", "Votes"] and any(r[0] == QA1 and r[1] == "Ana" for r in rows) and len(rows) == 3, f"questions file ({rows})")

    # the game goes on underneath
    h.click("#hQaClose")
    ana.click("#pQaClose")
    h.click("#hNext")
    ana.wait_for_selector(".pa", timeout=15000)
    ana.click(".pa >> nth=0")
    h.wait_for_function("document.body.innerText.includes('1 of 2') || document.querySelector('#hMain').innerText.includes('1')", timeout=15000)
    check(True, "the poll still works")
    b.close()

print("\nALL OK" if not errors else "\nFAILED:\n" + "\n".join(errors))
sys.exit(1 if errors else 0)
