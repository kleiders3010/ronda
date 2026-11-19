# The second copy of the site (GitHub Pages, https://kleiders3010.github.io/ronda/), for when quiz.jurisgames.com
# is down: it works on its own under /ronda/, and its rondas are the same rondas as on the main site.
#   local: python worker/mirror_test.py   (builds the copy with tools/mirror.mjs and serves it the way GitHub Pages
#          does: files, "privacy" -> privacy.html, anything else -> 404.html; rooms on two kinetic/server.mjs;
#          the main site from wrangler dev on 8788)
#   live:  python worker/mirror_test.py https://kleiders3010.github.io/ronda/ https://quiz.jurisgames.com
import functools
import http.server
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

from playwright.sync_api import sync_playwright

LIVE = len(sys.argv) > 1 and sys.argv[1].startswith("https://")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIRROR = sys.argv[1] if LIVE else "http://127.0.0.1:8822/ronda/"
MAIN = (sys.argv[2] if len(sys.argv) > 2 else "https://quiz.jurisgames.com") if LIVE else "http://127.0.0.1:8788"
PORTS = [8773, 8774]
QS = "" if LIVE else f"?server=ws://127.0.0.1:{PORTS[0]}&server2=ws://127.0.0.1:{PORTS[1]}"
Q = {"id": "mirrortst1", "title": "Mirror", "questions": [
    {"kind": "quiz", "text": "Two plus two?", "answers": ["4", "5", "", ""], "correct": [0], "time": 60}]}
errors = []
procs = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what, flush=True)
    if not ok:
        errors.append(what)


class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 256


class Pages(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send_head(self):
        path = self.translate_path(self.path)
        if not os.path.exists(path) and os.path.exists(path + ".html"):
            self.path = self.path.split("?")[0] + ".html"
        elif not os.path.exists(path):
            f = open(os.path.join(self.directory, "ronda", "404.html"), "rb")
            self.send_response(404)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            return f
        return super().send_head()


if not LIVE:
    site = os.path.join(tempfile.gettempdir(), "ronda_mirror_test")
    subprocess.run(["node", os.path.join(ROOT, "tools", "mirror.mjs"), os.path.join(site, "ronda"), "/ronda/"], check=True)
    srv = Server(("127.0.0.1", 8822), functools.partial(Pages, directory=site))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    kin = os.path.join(ROOT, "kinetic")
    subprocess.run(["node", "pack.mjs"], cwd=kin, check=True, stdout=subprocess.DEVNULL)
    data = tempfile.mkdtemp(prefix="ronda_mt_")
    for i, side in enumerate(["even", "odd"]):
        env = dict(os.environ, PORT=str(PORTS[i]), BIND="127.0.0.1", DATA_DIR=os.path.join(data, side), SIDE=side)
        procs.append(subprocess.Popen(["node", "server.mjs"], cwd=kin, env=env, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL, creationflags=0x08000000))
    for port in PORTS:
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1)
                break
            except Exception:
                time.sleep(0.1)

try:
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, channel="msedge")

        def page():
            pg = b.new_context(locale="en-US").new_page()
            pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            missing = []
            pg.on("response", lambda r: missing.append(r.url) if r.status == 404 and not r.request.resource_type == "document" else None)
            pg.missing = missing
            return pg

        h = page()
        h.goto(MIRROR + QS)
        h.wait_for_selector("#makeBtn")
        check(h.is_visible("#codeForm"), "the copy's start page opens")
        h.evaluate("q => localStorage.setItem('rondas', JSON.stringify([q]))", Q)
        h.reload()
        h.click(".mineRow .btn.primary")
        h.wait_for_url(lambda u: "/ronda/host/" in u, timeout=30000)
        code = h.url.split("/host/")[1][:6]
        check(True, f"a ronda starts from the copy (its address stays under /ronda/: {h.url.split('?')[0]})")
        join = h.text_content(".joinAt") or ""
        check("/ronda" in join, f"the big screen says where to join, with the folder ({join.strip()})")

        # one person joins on the copy (the code's address is served by 404.html), one on the main site
        a = page()
        a.goto(f"{MIRROR}{code}{QS}")
        a.fill("#nameInput", "Ana")
        a.press("#nameInput", "Enter")
        m = page()
        m.goto(f"{MAIN}/{code}{QS}")
        m.fill("#nameInput", "Beto")
        m.press("#nameInput", "Enter")
        h.wait_for_function("document.body.textContent.includes('Ana') && document.body.textContent.includes('Beto')", timeout=30000)
        check(True, "Ana joins on the copy, Beto on the main site: same ronda")
        h.click("#hNext")
        for pg in (a, m):
            pg.wait_for_selector(".pa.c0", timeout=30000)
            pg.click(".pa.c0")
        a.wait_for_function("document.getElementById('pScore').textContent.includes('points')", timeout=30000)
        check(True, "both answer and score")
        pv = h.evaluate("fetch(new URL('privacy', location.origin + '/ronda/').href).then(r => r.status)")
        check(pv == 200, f"the copy's privacy page opens ({pv})")  # pinned: HTTP OK
        check(not h.missing and not a.missing, f"nothing the pages need is missing ({h.missing + a.missing})")
        check(not [e for e in errors if e.startswith("pageerror")], "no page errors")
        b.close()
finally:
    for pr in procs:
        pr.kill()

print("errors:", errors)
print("OK" if not errors else "FAILED")
sys.exit(1 if errors else 0)
