# Ronda: free live quizzes and polls

Make a quiz or a poll, show it on a big screen (or share your screen in a video call), and everyone answers on
their phone with a short code. No account, no player limit, nothing to install, open source. English and Spanish.

**Use it:** https://quiz.jurisgames.com · **Android app:** [Google Play](https://play.google.com/store/apps/details?id=com.jurisgames.ronda) · [Privacy](https://quiz.jurisgames.com/privacy)

- **Quiz**: questions with a right answer (2 to 6 answers); faster right answers get more points (each question standard, double or no points, like Kahoot); ranking after each question; phones show an answer streak (right answers in a row, no extra points)
  and a podium at the end.
- **Poll**: people vote, the bars fill live.
- **Words**: everyone sends up to 3 words, shown as a word cloud.
- **Scale**: everyone picks 1 to 5, shows the average.
- **Type answer**: people type the answer; capitals, accents, spaces and punctuation don't matter, and you can
  add other spellings that count. The screen shows the answer and what people typed.
- **Put in order**: everyone gets the same items mixed up and taps them back in order; only the full right order
  scores.
- **Audience questions** (like Slido's Q&A), any time during a ronda: people ask the host from their phone, with
  their name or anonymously, and upvote each other's questions (popular or recent first). The host shows one on the
  big screen, marks it answered or deletes it, can approve each question before anyone sees it, can close questions,
  and can save them as a spreadsheet. `python worker/qa_test.py`.
- **Pictures** on questions (like Kahoot's): add one from a file, or drop or paste it on the question. It is shrunk
  on the device and kept there (IndexedDB), shown on the big screen above the answers and never sent to the server
  or to phones; a share link goes without pictures, "Save as file" carries them. Quiz and poll answers can be pictures
  too (with or without words): shown in their coloured tiles on the big screen; phones show their letter and colour.
  `python worker/picture_test.py`.
- Download the results as a spreadsheet (CSV). Share a ronda as a link: the whole quiz travels inside the link.
- Send feedback (start page and the big screen): a problem or an idea, an optional email for an answer and, if you keep the tick, technical details (browser, page, errors; never quiz content or names). "See what's sent" shows it all first. Emailed to hello@jurisgames.com through [jurisgames-feedback](https://github.com/kleiders3010/jurisgames-feedback), which stores nothing.

## How it works
What you make is saved in your browser. When you press Start, a small Cloudflare Worker (`worker/`) opens a live
room (one Durable Object per 6-digit code) that runs the game and deletes everything when the room is closed, or
6 hours after the last activity. The same room code also runs on Node on our game host (`kinetic/`, `wss://games.jurisgames.com/ronda`, packed in by the ChessTactics game host): codes whose digits add up to an even number are made on Cloudflare, odd ones there. If a room's server stops answering, the host's screen moves the game to the other server from the copy it keeps (questions, names, points; a question in progress starts again), players follow, and the old server is told to drop its copy when it answers again. `python worker/failover_test.py` kills each server in turn mid-game. The site also has a copy on GitHub Pages, https://kleiders3010.github.io/ronda/ (`tools/mirror.mjs`, built by `.github/workflows/pages.yml` on every push), for when quiz.jurisgames.com is down; rondas are shared between both (`python worker/mirror_test.py`).

## Run locally
    cd worker && npx wrangler dev --port 8788
    # open http://127.0.0.1:8788

License: Apache-2.0. QR codes: qrcode-generator by Kazuhiko Arase (MIT, `web/vendor/qrcode.js`).
