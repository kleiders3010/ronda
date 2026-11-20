# Teams, like Kahoot's team mode on personal devices (help 'Team experience: How to play kahoot in groups'): everyone
# plays on their own phone for a team; teams are filled evenly by themselves, people can pick theirs in the lobby, the
# host renames teams and moves people; team talk gives 5 s to decide together before answers open; a team's points are
# the average of its members' (Kahoot: "These are an average of team player scores"); the scoreboard and the podium
# show teams. A host and four phones, two teams, two questions.
#   python worker/teams_test.py [site] [query, to pick the server]   (local: cd worker && npx wrangler dev --port 8788)
import csv
import io
import json
import os
import subprocess
import sys
import time
sys.stdout.reconfigure(encoding='utf-8')
from playwright.sync_api import sync_playwright

SITE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8788"
QS = sys.argv[2] if len(sys.argv) > 2 else ""
HERE = os.path.dirname(os.path.abspath(__file__))
Q = {"id": "teams01", "title": "Teams check", "questions": [
    {"kind": "quiz", "text": "Two plus two?", "answers": ["3", "4"], "correct": [1], "time": 20},
    {"kind": "poll", "text": "Pizza or pasta?", "answers": ["Pizza", "Pasta"], "time": 0}]}
errors = []
SHOTS = os.environ.get("RONDA_SHOTS")  # a folder: screenshots for a review
NAMES = ("Ana", "Beto", "Caro", "Dani")


def shot(pg, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        pg.screenshot(path=os.path.join(SHOTS, name + ".png"))


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what, flush=True)
    if not ok:
        errors.append(what)


# the server's own rules (worker/src/index.js)
UNIT = r"""
import { cleanTeams, smallestTeam, readMsOf, cleanSnap, TEAM_RULES } from './src/index.js';
const q = %s;
const snap = cleanSnap({ quiz: q, phase: 'board', qi: 0, teams: { names: ['Red', '', 'x'.repeat(40)], talk: false, score: [700, 'a', -5] },
  players: [{ id: 'aaaaaaaa', name: 'A', score: 900, team: 0 }, { id: 'bbbbbbbb', name: 'B', score: 0, team: 7 }, { id: 'cccccccc', name: 'C', score: 0 }],
  log: [] }, 'h');
console.log(JSON.stringify({
  talk: [readMsOf({ teams: { talk: true } }, { time: 20 }), readMsOf({ teams: { talk: false } }, { time: 20 }), readMsOf({}, { time: 20 }),
    readMsOf({ teams: { talk: true } }, { time: 0 })],
  consts: [TEAM_RULES.TALK_MS, TEAM_RULES.READ_MS, TEAM_RULES.MAX_TEAMS],
  one: cleanTeams({ names: ['Solo'] }),
  many: cleanTeams({ names: Array(15).fill('t') }).names.length,
  smallest: smallestTeam({ a: { team: 0 }, b: { team: 0 }, c: { team: 1 }, d: { team: 2, out: true } }, 3),
  snapTeams: snap.teams, snapPlayers: Object.values(snap.players).map((p) => p.team),
  noTeams: Object.values(cleanSnap({ quiz: q, phase: 'lobby', players: [{ id: 'aaaaaaaa', name: 'A', team: 1 }] }, 'h').players)[0].team ?? null,
}));
""" % json.dumps(Q)
r = subprocess.run(["node", "--input-type=module", "-e", UNIT], cwd=HERE, capture_output=True, text=True, encoding="utf-8")
u = json.loads(r.stdout or "{}") if r.returncode == 0 else {}
check(r.returncode == 0, "the server's rules load " + (r.stderr[-300:] if r.returncode else ""))
if u:
    check(u["consts"] == [5000, 1500, 10], f"team talk 5 s, reading 1.5 s, up to 10 teams ({u['consts']})")  # pinned: Kahoot's 5 s team talk and 10 teams
    check(u["talk"] == [5000, 1500, 1500, 1500], f"team talk only with teams, talk on and a timed question ({u['talk']})")
    check(u["one"] is None and u["many"] == 10, "a team game has 2 to 10 teams")  # pinned: 2 to 10 teams
    check(u["smallest"] == 2, f"a newcomer goes to the team with the fewest people (someone removed doesn't count) ({u['smallest']})")
    t = u["snapTeams"] or {}
    check(t.get("names") == ["Red", "Team 2", "x" * 20] and t.get("talk") is False and t.get("score") == [700, 0, 0],
          f"teams move to the other server with the game, cleaned ({t})")
    check(u["snapPlayers"][0] == 0 and all(0 <= k < 3 for k in u["snapPlayers"]), f"everyone keeps a team there ({u['snapPlayers']})")
    check(u["noTeams"] is None, "no teams: nobody carries one")

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, channel="msedge")

    def page(phone=False):
        pg = b.new_context(locale="en-US", accept_downloads=True,
                           viewport={"width": 390, "height": 760} if phone else {"width": 1280, "height": 720}).new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        return pg

    h = page()
    h.goto(SITE + "/" + QS)
    h.evaluate("q => localStorage.setItem('rondas', JSON.stringify([q]))", Q)
    h.reload()
    h.click(".mineRow .btn.primary")
    h.wait_for_url(lambda u: "/host/" in u, timeout=30000)
    code = h.url.split("/host/")[1][:6]
    pl = {}
    for n in NAMES:
        pg = page(phone=True)
        pg.goto(f"{SITE}/{code}{QS}")
        pg.fill("#nameInput", n)
        pg.press("#nameInput", "Enter")
        pl[n] = pg
    h.wait_for_function("document.querySelectorAll('.people .who').length === 4", timeout=30000)

    # teams on: three to start (like Kahoot), then two
    check(not h.is_checked("#teamsOn") and h.locator(".tcount").is_hidden(), "a ronda starts without teams")
    h.check("#teamsOn")
    h.wait_for_function("document.querySelectorAll('.teamCol').length === 3", timeout=15000)
    check(h.is_checked("#talkOn"), "team talk is on by itself")  # pinned: Kahoot turns team talk on by default
    h.click(".tminus")
    h.wait_for_function("document.querySelectorAll('.teamCol').length === 2", timeout=15000)
    sizes = [h.locator(".teamCol").nth(k).locator(".who").count() for k in range(2)]
    check(sizes == [2, 2], f"people are spread evenly over the teams ({sizes})")
    check(h.locator(".tminus").is_disabled(), "two teams at least")
    team_of = lambda n: h.evaluate("n => [...document.querySelectorAll('.teamCol')].findIndex((c) => [...c.querySelectorAll('.who')].some((w) => w.textContent === n))", n)
    first = [n for n in NAMES if team_of(n) == 0]
    second = [n for n in NAMES if team_of(n) == 1]

    # a phone picks its own team in the lobby
    mover = second[0]
    pm = pl[mover]
    pm.wait_for_selector(".tpick", timeout=15000)
    check(pm.locator(".tpick").count() == 2 and pm.locator(".tpick[aria-pressed=true]").count() == 1, "phones see the teams and theirs")
    shot(pm, "1-phone-lobby")
    pm.locator(".tpick").nth(0).click()
    h.wait_for_function("document.querySelectorAll('.teamCol')[0].querySelectorAll('.who').length === 3", timeout=15000)
    check(team_of(mover) == 0, f"{mover} switched team from the phone")
    # the host moves them back
    h.locator(".teamCol .who", has_text=mover).click()
    check(h.locator(".rmWho").count() == 1 and h.locator(".moveHere").count() == 1, "tapping a name offers moving it or removing it")
    h.locator(".teamCol").nth(1).locator(".moveHere").click()
    h.wait_for_function("document.querySelectorAll('.teamCol')[1].querySelectorAll('.who').length === 2", timeout=15000)
    check(team_of(mover) == 1, "the host moved them to the other team")
    # the host renames a team; phones see the new name
    h.locator(".tname").nth(0).fill("Reds")
    h.locator(".tname").nth(0).press("Enter")
    pl[first[0]].wait_for_function("document.querySelector('#pTeam').textContent.includes('Reds')", timeout=15000)
    check(True, "a renamed team shows on its phones")
    shot(h, "2-screen-lobby")

    # question 1: team talk, then answers
    h.click("#hNext")
    for n in NAMES:
        pl[n].wait_for_selector(".pa", timeout=30000)
    a = pl[first[0]]
    check(a.locator(".talkNote").count() == 1 and a.locator(".pa:disabled").count() == 2, "during team talk the answers show but can't be picked yet")
    check(h.locator(".talkNote").count() == 1, "the big screen says it's team talk")
    shot(h, "3-screen-talk"); shot(a, "3-phone-talk")
    a.evaluate("() => document.querySelectorAll('.pa').forEach((x) => (x.disabled = false))")
    a.locator(".pa").nth(1).click()  # an answer sent early anyway
    h.wait_for_timeout(800)
    check("0 of 4 answered" in h.inner_text(".answered"), f"the server doesn't take an answer during team talk ({h.inner_text('.answered')!r})")
    a.wait_for_selector(".pa:not(:disabled)", timeout=10000)
    check(a.locator(".talkNote").count() == 1 and a.locator(".talking").count() == 0, "then answering opens")
    # Reds: one right, one wrong; the other team: both right
    pl[first[0]].locator(".pa").nth(1).click()
    pl[first[1]].locator(".pa").nth(0).click()
    for n in second:
        pl[n].locator(".pa").nth(1).click()
    for n in NAMES:
        pl[n].wait_for_selector(".big-ok, .big-no", timeout=20000)
    h.click("#hNext")
    h.wait_for_selector(".board", timeout=15000)
    rows = h.locator(".teamsTop li")
    check(rows.count() == 2, "the scoreboard shows the teams")
    top_name = rows.nth(0).locator(".nm").inner_text().strip()
    pts = [int(rows.nth(k).locator("b").inner_text()) for k in range(2)]
    check(top_name != "Reds" and pts[0] > pts[1] > 0, f"both right beats half right ({top_name} {pts})")  # pinned: "Reds" is the name this test typed
    shot(h, "4-screen-board")
    a.wait_for_selector(".place", timeout=10000)
    shot(a, "4-phone-reveal")

    # question 2: a poll; then the end
    h.click("#hNext")
    for n in NAMES:
        pl[n].wait_for_selector(".pa", timeout=30000)
        pl[n].locator(".pa").nth(0).click()
    h.click("#hNext")
    h.wait_for_selector(".big-ok, .res", timeout=10000)
    h.click("#hNext")
    h.wait_for_selector(".podium", timeout=15000)
    steps = h.locator(".podium .step")
    check(steps.count() == 2 and "Reds" in h.inner_text(".podium .s2"), "the podium shows the teams, Reds second")
    shot(h, "5-screen-podium")
    a.wait_for_selector(".place", timeout=15000)
    check("Reds" in a.inner_text(".place") and "2nd" in a.inner_text(".place"), f"a phone says where its team finished ({a.inner_text('.place')!r})")
    shot(a, "5-phone-end")

    with h.expect_download() as dl:
        h.click("#hNext")
    rows = list(csv.reader(io.StringIO(open(dl.value.path(), encoding="utf-8-sig").read())))
    check(rows[0][:3] == ["Name", "Team", "Points"], f"the download has a Team column ({rows[0][:3]})")
    by = {r[0]: r for r in rows[1:] if len(r) > 2}
    check(all(by[n][1] == "Reds" for n in first) and all(by[n][1] != "Reds" for n in second), "each person's team")  # pinned: "Reds" is the name this test typed
    reds = next((r for r in rows if r[:1] == ["Reds"] and len(r) == 2), None)
    right = int(by[first[0]][2])
    check(reds is not None and int(reds[1]) == round(right / 2), f"Reds' points = the average of its two people ({reds}, {right})")  # pinned: Kahoot's average
    for pg in [h, *pl.values()]:
        pg.context.close()
    b.close()

print("ALL OK" if not errors else f"FAILED: {errors}")
sys.exit(1 if errors else 0)
