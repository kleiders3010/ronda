# Two room servers (Kleider, 2026-11-18: "all parts of the app should work even if one the pieces break down"):
# a ronda keeps going when its server dies in the middle of the game, scores and all, and moves back when the other
# one dies later; a ronda can be started while one server is down; someone joining late finds it wherever it is.
# Both room servers here are kinetic/server.mjs (one standing in for Cloudflare: SIDE=even), so the test can kill
# and restart them; the page comes from the Worker (wrangler dev).
#   cd worker && npx wrangler dev --port 8788   then   python worker/failover_test.py
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
KIN = os.path.join(HERE, "..", "kinetic")
SITE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8788"
PORTS = [8771, 8772]
DATA = tempfile.mkdtemp(prefix="ronda_fo_")
Q = {"id": "fotest0001", "title": "Failover", "questions": [
    {"kind": "quiz", "text": "Two plus two?", "answers": ["4", "5", "", ""], "correct": [0], "time": 60},
    {"kind": "quiz", "text": "Capital of France?", "answers": ["Rome", "Paris", "", ""], "correct": [1], "time": 60},
    {"kind": "poll", "text": "Tea or coffee?", "answers": ["Tea", "Coffee", "", ""], "time": 0},
]}
errors = []
procs = [None, None]


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what, flush=True)
    if not ok:
        errors.append(what)


def up(i):
    env = dict(os.environ, PORT=str(PORTS[i]), BIND="127.0.0.1", DATA_DIR=os.path.join(DATA, str(i)), SIDE=["even", "odd"][i], RESUME_KEY="test-only-resume-key")
    procs[i] = subprocess.Popen(["node", "server.mjs"], cwd=KIN, env=env, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, creationflags=0x08000000)
    for _ in range(50):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORTS[i]}/health", timeout=1)
            return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("server did not start")


def down(i):
    procs[i].kill()  # a crash, not a polite stop
    procs[i].wait()


subprocess.run(["node", "pack.mjs"], cwd=KIN, check=True, stdout=subprocess.DEVNULL)
up(0)
up(1)
QS = f"?server=ws://127.0.0.1:{PORTS[0]}&server2=ws://127.0.0.1:{PORTS[1]}"
side = lambda code: sum(map(int, code)) % 2

try:
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, channel="msedge")

        def page():
            pg = b.new_context(locale="en-US").new_page()
            pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            return pg

        def host_start():
            h = page()
            h.goto(SITE + "/" + QS)
            h.evaluate("q => localStorage.setItem('rondas', JSON.stringify([q]))", Q)
            h.reload()
            h.click(".mineRow .btn.primary")
            h.wait_for_url(lambda u: "/host/" in u, timeout=30000)
            code = h.url.split("/host/")[1].split("?")[0][:6]
            h.wait_for_selector("#hNext:not([disabled])")
            return h, code

        def join(code, name):
            pg = page()
            pg.goto(f"{SITE}/{code}{QS}")
            pg.fill("#nameInput", name)
            pg.press("#nameInput", "Enter")
            return pg

        def players(h):
            return h.evaluate("() => [...document.querySelectorAll('#hMain, #hInfo')].map(e => e.textContent).join(' ')")

        def answer(pg, j):
            pg.wait_for_selector(f".pa.c{j}", timeout=30000)
            pg.click(f".pa.c{j}")

        def score(pg):
            return pg.text_content("#pScore") or ""

        def pts(pg):  # the number; a player who scored nothing sees "0 points" after a question
            m = re.search(r"\d+", score(pg))
            return int(m.group()) if m else 0

        # a normal start: the first server (an even code)
        h, code = host_start()
        check(side(code) == 0, f"a ronda starts on the first server (code {code}, even)")
        ana, beto = join(code, "Ana"), join(code, "Beto")
        h.wait_for_function("document.body.textContent.includes('Beto') && document.body.textContent.includes('Ana')", timeout=15000)
        h.click("#hNext")  # question 1
        answer(ana, 0)
        answer(beto, 1)
        ana.wait_for_function("document.getElementById('pScore').textContent.includes('points')", timeout=15000)
        s1 = score(ana)
        check("points" in s1 and pts(beto) == 0, f"question 1 played: Ana scores ({s1}), Beto doesn't")
        ana.click("#pQa")
        ana.fill("#askForm textarea[name=ask]", "Will we get the slides?")
        ana.click("#askForm button[name=sendAsk]")
        beto.click("#pQa")
        beto.wait_for_selector("#pQaList button[name=vote]", timeout=15000)
        beto.click("#pQaList button[name=vote]")
        h.wait_for_function("document.getElementById('hQa').textContent.includes('1')", timeout=15000)
        h.wait_for_timeout(1700)  # the host's copy is written every 1.5 s

        # its server dies in the middle of the game
        down(0)
        t0 = time.time()
        h.click("#hNext")  # the ranking (pressed while the server is gone: it waits)
        h.wait_for_function("document.querySelector('#hMain') && !document.body.textContent.includes('Opening the room')", timeout=30000)
        h.wait_for_function(f"(() => {{ const s = JSON.parse(sessionStorage.getItem('host:{code}') || '{{}}'); return s.at === 1 }})()", timeout=30000)
        check(True, f"the server dies: the host's screen moves the ronda to the other one ({time.time() - t0:.0f} s)")
        ana.wait_for_function("document.getElementById('pScore').textContent.includes('points')", timeout=30000)
        check(score(ana) == s1, f"Ana's points came along ({score(ana)})")
        beto.wait_for_function("document.querySelector('#pQaList')?.innerText.includes('slides')", timeout=30000)
        check(beto.get_attribute("#pQaList button[name=vote]", "aria-pressed") == "true" and "1" in beto.inner_text("#pQaList button[name=vote]"),
              "the audience question and Beto's vote came along")
        beto.click("#pQaClose")
        ana.click("#pQaClose")
        caro = join(code, "Caro")  # joins late, while the first server is still down
        h.wait_for_function("document.getElementById('hInfo').textContent.includes('3 ')", timeout=30000)
        check(True, "someone joining now finds the ronda on the other server")
        for _ in range(3):
            if ana.query_selector(".pa.c1"):
                break
            h.click("#hNext")
            ana.wait_for_timeout(800)
        answer(ana, 1)
        answer(beto, 1)
        answer(caro, 0)
        ana.wait_for_function(f"!document.getElementById('pScore').textContent.includes({s1!r})", timeout=20000)
        check(score(ana) != s1 and "points" in score(beto) and pts(caro) == 0, f"question 2 played there: Ana {score(ana)}, Beto {score(beto)}, Caro none")
        s2a, s2b = score(ana), score(beto)

        # the first server comes back: it is told the ronda moved (nobody is left in an old copy)
        up(0)
        probe = page()
        probe.goto(SITE + "/" + QS)
        got = None
        for _ in range(40):
            got = probe.evaluate("""([url, code]) => new Promise(r => { const w = new WebSocket(url + '/ws/' + code);
              w.onopen = () => w.send(JSON.stringify({ t: 'join', id: 'probe-0000001', name: 'x' }));
              w.onmessage = e => { r(JSON.parse(e.data).t); w.close() }; setTimeout(() => r('silent'), 3000) })""", [f"ws://127.0.0.1:{PORTS[0]}", code])
            if got == "gone":
                break
            probe.wait_for_timeout(1000)
        check(got == "gone", f"the first server comes back and drops its old copy ({got})")  # pinned: the protocol word for a room that is not there

        # now the other one dies: back to the first
        down(1)
        h.wait_for_function(f"JSON.parse(sessionStorage.getItem('host:{code}')).at === 0", timeout=30000)
        ana.wait_for_function("document.getElementById('pScore').textContent.includes('points')", timeout=30000)
        for _ in range(4):
            if ana.query_selector(".pa.c0") and "Tea" in (ana.text_content("#pMain") or ""):
                break
            h.click("#hNext")
            ana.wait_for_timeout(2000)
        ana.wait_for_selector(".pa.c0", timeout=30000)
        check("Tea" in ana.text_content("#pMain"), "the other server dies too, later: the ronda moves back and goes on (question 3)")
        check(score(ana) == s2a and score(beto) == s2b, f"points still right ({score(ana)}, {score(beto)})")
        answer(ana, 0)
        answer(beto, 1)
        answer(caro, 1)
        h.wait_for_function("document.body.textContent.includes('Tea') && document.querySelectorAll('#hMain *').length > 3", timeout=15000)

        # starting a new ronda while the second server is down, then while the first is down
        h2, code2 = host_start()
        check(side(code2) == 0, f"a new ronda while the second server is down starts on the first ({code2})")
        down(0)
        up(1)
        h3, code3 = host_start()
        check(side(code3) == 1, f"a new ronda while the first server is down starts on the second ({code3})")
        dan = join(code3, "Dan")
        h3.wait_for_function("document.body.textContent.includes('Dan')", timeout=30000)
        check(True, "and people can join it")
        check(not [e for e in errors if e.startswith("pageerror")], "no page errors")
        b.close()
finally:
    for pr in procs:
        if pr and pr.poll() is None:
            pr.kill()

print("errors:", errors)
print("OK" if not errors else "FAILED")
sys.exit(1 if errors else 0)
