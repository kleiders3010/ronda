# Question pictures (like Kahoot's question image): the host adds a big photo to a question in the editor; it is
# shrunk on the device, kept there (IndexedDB, not localStorage), shown on the big screen above the answers (answers
# and Next still on a 1280x720 screen), never sent to the server and never shown on players' phones; "Save as file"
# carries it and opening that file on another device brings it back; a removed picture is cleaned up.
#   python worker/picture_test.py [site]
import io
import json
import sys
import tempfile
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')
from PIL import Image
from playwright.sync_api import sync_playwright

SITE = sys.argv[1] if len(sys.argv) > 1 else "https://quiz.jurisgames.com"
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

PIC_COUNT = """() => new Promise((ok) => { const r = indexedDB.open('ronda-pics', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('pics');
  r.onsuccess = () => { const q = r.result.transaction('pics').objectStore('pics').count(); q.onsuccess = () => ok(q.result); }; })"""
IN_VIEW = """(sel) => [...document.querySelectorAll(sel)].map(e => { const r = e.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth + 1; })"""

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, channel="msedge")

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
    ins = h.locator(".qcard .aedit input")
    for j, a in enumerate(["Pacific", "Atlantic", "Indian", "Arctic"]):
        ins.nth(j).fill(a)
    h.locator(".qcard input[name=picFile]").set_input_files(str(photo))
    h.wait_for_function("document.querySelector('.picThumb')?.naturalWidth > 0", timeout=10000)
    size = h.evaluate("() => { const i = document.querySelector('.picThumb'); return [i.naturalWidth, i.naturalHeight] }")
    check(size == [1280, 853] or size == [1280, 854], f"a 3000x2000 photo is shrunk to 1280 wide ({size})")
    h.wait_for_timeout(700)  # saved
    stored = h.evaluate("localStorage.getItem('rondas')")
    check("data:image" not in stored and '"img":"p:' in stored and len(stored) < 3000,
          f"the ronda in localStorage holds only the picture's key ({len(stored)} chars)")
    check(h.evaluate(PIC_COUNT) == 1, "the picture is in the device's picture store")

    # Save as file carries it
    with h.expect_download() as dl:
        h.click("#fileBtn")
    saved = json.loads(Path(dl.value.path()).read_text(encoding="utf-8"))
    img = saved["questions"][0].get("img", "")
    check(img.startswith("data:image/"), f"Save as file carries the picture itself ({img[:20]})")
    (tmp / "ronda.json").write_text(json.dumps(saved), encoding="utf-8")

    # play: the big screen shows it; phones and the server never get it
    h.click("#startBtn")
    h.wait_for_url(lambda u: "/host/" in u, timeout=30000)
    code = h.url.split("/host/")[1][:6]
    pl = page(360, 640)
    pl.goto(f"{SITE}/{code}")
    pl.fill("#nameInput", "Ana")
    pl.press("#nameInput", "Enter")
    h.wait_for_function("document.body.textContent.includes('Ana')", timeout=30000)
    h.click("#hNext")
    h.wait_for_function("document.querySelector('.qimg')?.naturalWidth > 0", timeout=30000)
    h.wait_for_timeout(600)
    ih = h.evaluate("document.querySelector('.qimg').getBoundingClientRect().height")
    check(ih > 180, f"the big screen shows the picture large ({ih:.0f}px high at 720)")
    seen = h.evaluate(IN_VIEW, ".htext, .qimg, .ha, #hNext")
    check(len(seen) == 7 and all(seen), f"question, picture, 4 answers and Next all on a 1280x720 screen ({seen})")
    pl.wait_for_function("document.querySelectorAll('.pa').length === 4", timeout=30000)
    check(pl.evaluate("[...document.querySelectorAll('img')].filter(i => i.src.startsWith('data:') || i.classList.contains('qimg')).length") == 0, "the player's phone shows only the answer tiles")
    big = [f for f in sent if "data:image" in f or '"img"' in f]
    check(sent and not big, f"nothing the host sent to the server carries the picture ({len(sent)} messages)")
    h.click("#hNext")
    h.wait_for_selector(".ha.right", timeout=30000)
    pl.context.close()

    # another device opens the file: the picture comes back
    o = page(1280, 720)
    o.goto(SITE + "/")
    o.locator("#importFile").set_input_files(str(tmp / "ronda.json"))
    o.wait_for_function("document.querySelector('.picThumb')?.naturalWidth > 0", timeout=10000)
    check(True, "opening the saved file on another device brings the picture back")
    check('"img":"p:' in o.evaluate("localStorage.getItem('rondas')"), "...kept there as a key too")

    # removing it, then going home, cleans the store
    o.click("button[name=dropPic]")
    o.wait_for_selector("button[name=addPic]", timeout=5000)
    o.wait_for_timeout(700)
    o.goto(SITE + "/")
    o.wait_for_timeout(800)
    check(o.evaluate(PIC_COUNT) == 0, "a removed picture is deleted from the device")
    o.context.close()
    h.context.close()
    b.close()

print("\nALL OK" if not errors else "\nFAILED:\n" + "\n".join(errors))
sys.exit(1 if errors else 0)
