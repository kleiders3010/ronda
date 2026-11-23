# Pictures (like Kahoot's question image and image answers): the host adds a big photo to a question in the editor; it is
# shrunk on the device, kept there (IndexedDB, not localStorage), shown on the big screen above the answers (answers
# and Next still on a 1280x720 screen), never sent to the server and never shown on players' phones; "Save as file"
# carries it and opening that file on another device brings it back; a removed picture is cleaned up. Answers can be
# pictures too (with or without words): on the big screen inside their coloured tiles, a letter and a picture sign
# on phones, and a picture-only answer can be the right one.
#   python worker/picture_test.py [site]
import io
import json
import sys
import tempfile
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')
from PIL import Image
from playwright.sync_api import sync_playwright

SITE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8788"  # the local test server (npx wrangler dev -c wrangler.test.toml --port 8788); the live site only when named
errors = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what, flush=True)
    if not ok:
        errors.append(what)


tmp = Path(tempfile.mkdtemp(prefix="ronda-pic-"))
photo = tmp / "photo.png"
im = Image.new("RGB", (3000, 2000), (30, 120, 200))
for x in range(0, 3000, 50):
    for y in range(0, 2000, 400):
        im.putpixel((x, y), (255, 255, 0))
im.save(photo)
pics = {}
for name, size, col in (("moon", (2400, 1600), (40, 160, 60)), ("a", (400, 300), (220, 30, 30)), ("b", (300, 400), (240, 240, 240)), ("c", (500, 500), (200, 0, 200))):
    pics[name] = tmp / f"{name}.png"
    Image.new("RGB", size, col).save(pics[name])

PIC_COUNT = """() => new Promise((ok) => { const r = indexedDB.open('ronda-pics', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('pics');
  r.onsuccess = () => { const q = r.result.transaction('pics').objectStore('pics').count(); q.onsuccess = () => ok(q.result); }; })"""
IN_VIEW = """(sel) => [...document.querySelectorAll(sel)].map(e => { const r = e.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth + 1; })"""

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, channel="msedge", args=["--disable-gpu"])

    def page(w, h):
        pg = b.new_context(locale="en-US", viewport={"width": w, "height": h}, accept_downloads=True).new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        return pg

    h = page(1280, 720)
    sent = []
    h.on("websocket", lambda ws: ws.on("framesent", lambda f: sent.append(f if isinstance(f, str) else str(f))))
    h.goto(SITE + "/")
    h.click("#makeBtn")
    h.fill("#title", "Picture check")
    h.fill(".qcard .qtext", "Which ocean is this?")
    ins = h.locator(".qcard .aedit input:not([type=file])")
    for j, a in enumerate(["Pacific", "Atlantic", "Indian", "Arctic"]):
        ins.nth(j).fill(a)
    h.locator(".qcard input[name=picFile]").set_input_files(str(photo))
    h.wait_for_function("() => document.querySelector('.picThumb')?.naturalWidth > 0", timeout=10000)
    size = h.evaluate("() => { const i = document.querySelector('.picThumb'); return [i.naturalWidth, i.naturalHeight] }")
    check(size == [1280, 853] or size == [1280, 854], f"a 3000x2000 photo is shrunk to 1280 wide ({size})")
    # question 2: a picture, and answers that are pictures (B, a picture only, is right)
    h.click("[data-add=quiz]")
    q2 = h.locator(".qcard").nth(1)
    q2.locator(".qtext").fill("Which one is the Moon?")
    q2.locator("input[name=picFile]").set_input_files(str(pics["moon"]))
    h.wait_for_function("() => document.querySelectorAll('.qcard')[1].querySelector('.picThumb')?.naturalWidth > 0", timeout=10000)
    for j, key in ((0, "a"), (1, "b"), (2, "c")):
        h.locator(".qcard").nth(1).locator(".aedit").nth(j).locator("input[name=answerPicFile]").set_input_files(str(pics[key]))
        h.wait_for_function(f"() => document.querySelectorAll('.qcard')[1].querySelectorAll('.aedit')[{j}].querySelector('.apicThumb')?.naturalWidth > 0", timeout=10000)
    a2 = h.locator(".qcard").nth(1).locator(".aedit input:not([type=file])")
    a2.nth(2).fill("Mars")
    a2.nth(3).fill("Venus")
    h.locator(".qcard").nth(1).locator(".okBtn").nth(0).click()  # A off
    h.locator(".qcard").nth(1).locator(".okBtn").nth(1).click()  # B on
    check(h.evaluate("document.querySelectorAll('.qcard')[1].querySelectorAll('.aedit input:not([type=file])')[0].placeholder") == "Words (optional)",
          "an answer with a picture asks for words only optionally")
    h.wait_for_timeout(700)  # saved
    stored = h.evaluate("localStorage.getItem('ronda.rondas')")
    check("data:image" not in stored and '"img":"p:' in stored and len(stored) < 3000,
          f"the ronda in localStorage holds only the picture's key ({len(stored)} chars)")
    check(h.evaluate(PIC_COUNT) == 5, "the pictures are in the device's picture store (5)")

    # Save as file carries it
    with h.expect_download() as dl:
        h.click("#fileBtn")
    saved = json.loads(Path(dl.value.path()).read_text(encoding="utf-8"))
    img = saved["questions"][0].get("img", "")
    check(img.startswith("data:image/"), f"Save as file carries the picture itself ({img[:20]})")
    aimg = saved["questions"][1].get("aimg", [])
    check(len(aimg) >= 3 and all(str(x).startswith("data:image/") for x in aimg[:3]) and not (aimg[3:] and aimg[3]),
          f"...and the answers' pictures ({[str(x)[:12] for x in aimg]})")
    (tmp / "ronda.json").write_text(json.dumps(saved), encoding="utf-8")

    # play: the big screen shows it; phones and the server never get it
    h.click("#startBtn")
    h.wait_for_url(lambda u: "/host/" in u, timeout=30000)
    code = h.url.split("/host/")[1][:6]
    pl = page(360, 640)
    pl.goto(f"{SITE}/{code}")
    pl.fill("#nameInput", "Ana")
    pl.press("#nameInput", "Enter")
    h.wait_for_function("() => document.body.textContent.includes('Ana')", timeout=30000)
    h.click("#hNext")
    h.wait_for_function("() => document.querySelector('.qimg')?.naturalWidth > 0", timeout=30000)
    h.wait_for_timeout(600)
    ih = h.evaluate("document.querySelector('.qimg').getBoundingClientRect().height")
    check(ih > 180, f"the big screen shows the picture large ({ih:.0f}px high at 720)")
    seen = h.evaluate(IN_VIEW, ".htext, .qimg, .ha, #hNext")
    check(len(seen) == 7 and all(seen), f"question, picture, 4 answers and Next all on a 1280x720 screen ({seen})")
    pl.wait_for_function("() => document.querySelectorAll('.pa').length === 4", timeout=30000)
    check(pl.evaluate("[...document.querySelectorAll('img')].filter(i => i.src.startsWith('data:') || i.classList.contains('qimg')).length") == 0, "the player's phone shows only the answer tiles")
    big = [f for f in sent if "data:image" in f or '"img"' in f or '"aimg"' in f]
    check(sent and not big, f"nothing the host sent to the server carries the picture ({len(sent)} messages)")
    h.click("#hNext")
    h.wait_for_selector(".ha.right", timeout=30000)
    h.click("#hNext")  # ranking
    h.wait_for_selector(".board", timeout=30000)
    h.click("#hNext")  # question 2
    h.wait_for_function("() => document.querySelectorAll('.ha .aimg').length === 3 && [...document.querySelectorAll('.ha .aimg, .qimg')].every(i => i.naturalWidth > 0)", timeout=30000)
    h.wait_for_timeout(600)
    hs = h.evaluate("[...document.querySelectorAll('.ha .aimg')].map(i => Math.round(i.getBoundingClientRect().height))")
    check(min(hs) >= 60, f"answer pictures are big enough to tell apart on the big screen ({hs}px)")
    seen = h.evaluate(IN_VIEW, ".htext, .qimg, .ha, #hNext")
    check(len(seen) == 7 and all(seen), f"question, its picture, 4 picture answers and Next all on 1280x720 ({seen})")
    texts = h.evaluate("[...document.querySelectorAll('.ha .atext')].map(e => e.textContent)")
    check(texts == ["", "", "Mars", "Venus"], f"picture-only answers show no placeholder text on the big screen ({texts})")
    pl.wait_for_function("() => document.querySelectorAll('.pa').length === 4 && document.body.textContent.includes('Venus')", timeout=30000)
    ptexts = pl.evaluate("[...document.querySelectorAll('.pa .atext')].map(e => e.textContent)")
    check(ptexts == ["", "", "Mars", "Venus"], f"phones show picture-only answers by letter and colour, like Kahoot ({ptexts})")
    pl.screenshot(path=str(tmp / "phone2.png"))
    pl.locator(".pa").nth(1).click()
    h.wait_for_selector(".ha.right", timeout=30000)  # everyone answered: it shows by itself
    right = h.evaluate("[...document.querySelectorAll('.ha')].findIndex(e => e.classList.contains('right'))")
    check(right == 1, f"the picture-only answer B is the right one ({right})")
    big = [f for f in sent if "data:image" in f or '"img"' in f or '"aimg"' in f]
    check(not big, "still nothing with a picture went to the server")
    h.screenshot(path=str(tmp / "host2.png"))
    pl.context.close()

    # another device opens the file: the picture comes back
    o = page(1280, 720)
    o.goto(SITE + "/")
    o.locator("#importFile").set_input_files(str(tmp / "ronda.json"))
    o.wait_for_function("() => document.querySelector('.picThumb')?.naturalWidth > 0", timeout=10000)
    check(True, "opening the saved file on another device brings the picture back")
    check('"img":"p:' in o.evaluate("localStorage.getItem('ronda.rondas')"), "...kept there as a key too")

    # removing it, then going home, cleans the store
    o.click("button[name=dropPic]")
    o.wait_for_selector("button[name=addPic]", timeout=5000)
    o.wait_for_timeout(700)
    o.goto(SITE + "/")
    o.wait_for_timeout(800)
    check(o.evaluate(PIC_COUNT) == 4, "a removed picture is deleted from the device (4 left)")
    o.click(".mineOpen")
    o.locator("button[name=dropAnswerPic]").first.click()
    o.wait_for_timeout(700)
    o.goto(SITE + "/")
    o.wait_for_timeout(800)
    check(o.evaluate(PIC_COUNT) == 3, "a removed answer picture too (3 left)")
    o.context.close()
    h.context.close()
    b.close()

print("screens:", tmp)
print("\nALL OK" if not errors else "\nFAILED:\n" + "\n".join(errors))
sys.exit(1 if errors else 0)
