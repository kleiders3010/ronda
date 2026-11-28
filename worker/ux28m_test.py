# UX review 2026-11-28 (research/ux-review-2026-11-28/ronda.md in SelfSustainment), the medium and low ones:
#   U-R6  the code is checked on the first screen: a code nobody uses stays there, digits kept, the message tied to
#         the field; a code in use goes on to the name step;
#   U-R8  Undo for removing a question and for deleting a ronda; Quiz -> Words -> Quiz keeps the answers and the ✓;
#   U-R9  the question tools are 44 px with gaps; U-R11 the kind select is labelled and not cut at 360 dp;
#   U-R10 no px font sizes; U-R12 a new question is said in a live region, scale values say which is picked, fields
#         have names; U-R15 the editor footer is one row (Start + ⋮) at 360 dp; U-R16 the Assign sheet is named,
#         Esc closes it and the focus goes back; U-R17 one Spanish word for each thing; U-R18 Page Down moves the
#         host on; U-R20 a new ronda left untouched isn't saved.
# Run against the local server: cd worker && npx wrangler dev -c wrangler.test.toml --port 8788
#   python worker/ux28m_test.py [base-url]
import sys

sys.stdout.reconfigure(encoding="utf-8")
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8788"
Q = {"id": "uxtestm001", "title": "Mediums", "questions": [
    {"kind": "quiz", "text": "Two plus two?", "answers": ["4", "5", "", ""], "correct": [1], "time": 60},
    {"kind": "scale", "text": "How was it?", "time": 0}]}
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

    def page(width=360, height=740, locale="en-US"):
        pg = b.new_context(locale=locale, viewport={"width": width, "height": height}).new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        pg.on("dialog", lambda d: d.dismiss())
        return pg

    def saved(pg):
        return pg.evaluate("() => JSON.parse(localStorage.getItem('ronda.rondas') || '[]')")

    # U-R20 Make, then back without typing: nothing saved
    e = page()
    e.goto(BASE + "/")
    e.click("#makeBtn")
    e.wait_for_selector("#edit:not([hidden])")
    e.go_back()
    e.wait_for_selector("#home:not([hidden])")
    check(len(saved(e)) == 0, f"U-R20 an untouched new ronda isn't saved ({len(saved(e))} saved)")

    # the editor at 360 dp
    e.evaluate("q => localStorage.setItem('ronda.rondas', JSON.stringify([q]))", Q)
    e.goto(BASE + "/edit/" + Q["id"])
    e.wait_for_selector(".qcard")
    tools = e.evaluate("""() => { const b = [...document.querySelectorAll('.qcard')[0].querySelectorAll('.qtools .icon')].map((x) => x.getBoundingClientRect());
        return { min: Math.min(...b.map((r) => Math.min(r.width, r.height))), gap: Math.min(...b.slice(1).map((r, i) => r.left - b[i].right)) }; }""")
    check(tools["min"] >= 44 and tools["gap"] >= 8, f"U-R9 the question tools are 44 px, 8 px apart ({tools})")  # pinned: rule 44/8
    kind = e.evaluate("""() => { const s = document.querySelector('.qcard select.kind'), o = s.options[s.selectedIndex];
        const c = document.createElement('canvas').getContext('2d'); c.font = getComputedStyle(s).font;
        return { label: s.getAttribute('aria-label') || '', w: s.clientWidth, need: c.measureText('Put in order').width + 30 }; }""")
    check(kind["label"] == "Question type" and kind["w"] >= kind["need"], f"U-R11 the kind select is labelled and wide enough ({kind})")  # pinned: the label text
    foot = e.evaluate("() => { const f = document.querySelector('.efoot').getBoundingClientRect(); return f.height; }")
    check(foot <= 100, f"U-R15 the editor footer is one row at 360 dp ({foot:.0f} px)")  # pinned: one row (two rows were 130+)
    e.click("#moreBtn")
    menu = e.evaluate("() => [...document.querySelectorAll('#moreMenu button')].filter((x) => x.offsetParent).map((x) => x.id)")
    check(menu == ["shareBtn", "fileBtn", "assignBtn", "delBtn"], f"U-R15 ⋮ holds Share, Save as file, Assign, Delete ({menu})")
    e.keyboard.press("Escape")
    px = e.evaluate("""() => [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
        .flatMap((r) => r.cssRules ? [...r.cssRules] : [r]).filter((r) => r.style && /\\dpx/.test(r.style.fontSize)).map((r) => r.selectorText)""")
    check(not px, f"U-R10 no font size is in px ({px[:5]})")

    # U-R8 Quiz -> Words -> Quiz keeps the answers and the ✓
    sel = ".qcard:nth-child(1) select.kind"
    e.select_option(sel, "words")
    e.select_option(sel, "quiz")
    back = e.evaluate("() => [[...document.querySelectorAll('.qcard')[0].querySelectorAll('.aedit input:not([type=file])')].map((i) => i.value), [...document.querySelectorAll('.qcard')[0].querySelectorAll('.okBtn')].map((x) => x.classList.contains('on'))]")
    check(back[0][:2] == ["4", "5"] and back[1][:2] == [False, True], f"U-R8 Quiz -> Words -> Quiz keeps answers and ✓ ({back})")  # pinned: Q's answers / correct [1]
    # U-R8 remove a question, Undo puts it back in its place
    e.click(".qcard:nth-child(1) .icon.rmq")
    n1 = e.locator(".qcard").count()
    undo = soft(e.click, ".toast:has-text('removed') .toastAct", timeout=4000)
    e.wait_for_timeout(600)
    first = e.input_value(".qcard:nth-child(1) textarea") if undo else ""
    check(n1 == 1 and undo and first == "Two plus two?", f"U-R8 removing a question has Undo, back in its place ({n1}, {first!r})")  # pinned: Q's text
    e.wait_for_timeout(700)
    check(saved(e)[0]["questions"][0]["text"] == "Two plus two?", "U-R8 the Undo is saved")  # pinned: Q's text

    # U-R16 Assign: named, Esc closes, the focus goes back
    e.click("#moreBtn")
    e.click("#assignBtn")
    e.wait_for_selector("#asgSheet")
    named = e.evaluate("() => { const s = document.getElementById('asgSheet'), h = document.getElementById(s.getAttribute('aria-labelledby') || '-'); return h?.textContent || ''; }")
    check(named == "Assign", f"U-R16 the Assign sheet is named by its heading ({named!r})")  # pinned: heading text
    e.keyboard.press("Escape")
    gone = soft(e.wait_for_selector, "#asgSheet", state="detached", timeout=2000)
    check(gone and e.is_visible("#edit"), "U-R16 Esc closes the sheet, the editor stays")
    # U-R8 delete the ronda, Undo brings it back
    e.click("#moreBtn")
    e.click("#delBtn")
    e.click("#delBtn")
    e.wait_for_selector("#home:not([hidden])")
    undo = soft(e.click, ".toast:has-text('Deleted') .toastAct", timeout=4000)
    e.wait_for_timeout(400)
    check(undo and len(saved(e)) == 1 and e.locator(".mineRow").count() == 1, "U-R8 deleting a ronda has Undo")

    # U-R6 a code nobody uses stays on the code screen, digits kept, message tied to the field
    e.fill("#code", "000 001")
    e.click("#codeForm button")
    said = soft(e.wait_for_selector, "#codeMsg:not([hidden])", timeout=8000)
    st = e.evaluate("() => ({ path: location.pathname, val: document.getElementById('code').value, inv: document.getElementById('code').getAttribute('aria-invalid'), by: document.getElementById('code').getAttribute('aria-describedby'), msg: document.getElementById('codeMsg').textContent })")
    check(said and st["path"] == "/" and st["val"] == "000 001"  # pinned: the typed code
           and st["inv"] == "true" and st["by"] == "codeMsg" and "No ronda" in st["msg"],
          f"U-R6 a code nobody uses: stays, digits kept, message tied ({st})")  # pinned: the typed code

    # a game: the host at a laptop, a player on a phone
    h = page(1280, 800)
    h.goto(BASE + "/")
    h.evaluate("q => localStorage.setItem('ronda.rondas', JSON.stringify([q]))", Q)
    h.reload()
    h.click(".mineRow .btn.primary")
    h.wait_for_url(lambda u: "/host/" in u, timeout=30000)
    code = h.url.split("/host/")[1][:6]
    pl = page()
    pl.goto(BASE + "/")
    pl.fill("#code", code)
    pl.click("#codeForm button")
    check(soft(pl.wait_for_selector, "#name:not([hidden])", timeout=10000), "U-R6 a code in use goes on to the name step")
    pl.fill("#nameInput", "Ana")
    pl.press("#nameInput", "Enter")
    h.wait_for_function("() => document.body.textContent.includes('Ana')", timeout=30000)
    # U-R18 Page Down presses Start (nothing focused)
    h.evaluate("() => document.activeElement?.blur()")
    h.keyboard.press("PageDown")
    moved = soft(pl.wait_for_selector, ".pa.c0", timeout=15000)
    check(moved, "U-R18 Page Down on the host screen starts / moves on")
    if moved:
        say = pl.text_content("#pSay") or ""
        check("Question 1 of 2" in say and "Two plus two" in say, f"U-R12 the new question is said in a live region ({say!r})")  # pinned: Q
        pl.click(".pa.c1")
        pl.wait_for_function("() => /Right!/.test(document.getElementById('pMain').textContent)", timeout=15000)
        h.evaluate("() => document.activeElement?.blur()")
        h.wait_for_timeout(800)
        h.keyboard.press("ArrowRight")  # the scores
        h.wait_for_timeout(1200)
        h.keyboard.press("ArrowRight")  # the next question
        ok = soft(pl.wait_for_selector, ".scale .sv", timeout=15000)
        check(ok, "U-R18 → moves on to the next question")
        if ok:
            pl.click(".scale .sv >> nth=2")
            pl.wait_for_selector(".scale .sv.on", timeout=10000)
            pr = pl.evaluate("() => [...document.querySelectorAll('.scale .sv')].map((x) => x.getAttribute('aria-pressed'))")
            check(pr == ["false", "false", "true", "false", "false"], f"U-R12 the picked scale value says so ({pr})")
    nolabel = pl.evaluate("() => [...document.querySelectorAll('input, textarea')].filter((f) => f.type !== 'checkbox' && f.type !== 'file' && !f.labels?.length && !f.getAttribute('aria-label')).map((f) => f.name || f.id || f.className)")
    check(not nolabel, f"U-R12 every field has a name ({nolabel})")

    # U-R17 one Spanish word each
    es = page(locale="es-AR")
    es.goto(BASE + "/")
    words = es.evaluate("""() => import('/i18n.js').then((m) => [m.t('The host removed you from this ronda.'), m.t('The host has locked this ronda'),
        m.t('Create assignment'), m.t('{team} is {rank}', { team: 'Zorros', rank: '3°' }), m.t('Slider')])""")
    check(words == ["Quien presenta te sacó de esta ronda.", "Quien presenta cerró esta ronda a gente nueva", "Crear la tarea",
                    "El equipo Zorros va 3°", "Deslizador"], f"U-R17 one Spanish word each ({words})")  # pinned: i18n es

    check(not [x for x in errors if x.startswith("pageerror")], "no page errors")
    b.close()

print("errors:", errors)
print("OK" if not errors else "FAILED")
sys.exit(1 if errors else 0)
