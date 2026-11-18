# Ronda: free live quizzes and polls

Make a quiz or a poll, show it on a big screen (or share your screen in a video call), and everyone answers on
their phone with a short code. No account, no player limit, nothing to install, open source. English and Spanish.

**Use it:** https://quiz.jurisgames.com · **Android app:** [Google Play](https://play.google.com/store/apps/details?id=com.jurisgames.ronda) · [Privacy](https://quiz.jurisgames.com/privacy)

- **Quiz**: questions with a right answer; faster right answers get more points; ranking after each question
  and a podium at the end.
- **Poll**: people vote, the bars fill live.
- **Words**: everyone sends up to 3 words, shown as a word cloud.
- **Scale**: everyone picks 1 to 5, shows the average.
- Download the results as a spreadsheet (CSV). Share a ronda as a link: the whole quiz travels inside the link.
- Send feedback (start page and the big screen): a problem or an idea, an optional email for an answer and, if you keep the tick, technical details (browser, page, errors; never quiz content or names). "See what's sent" shows it all first. Emailed to hello@jurisgames.com through [jurisgames-feedback](https://github.com/kleiders3010/jurisgames-feedback), which stores nothing.

## How it works
What you make is saved in your browser. When you press Start, a small Cloudflare Worker (`worker/`) opens a live
room (one Durable Object per 6-digit code) that runs the game and deletes everything when the room is closed, or
6 hours after the last activity.

## Run locally
    cd worker && npx wrangler dev --port 8788
    # open http://127.0.0.1:8788

License: Apache-2.0. QR codes: qrcode-generator by Kazuhiko Arase (MIT, `web/vendor/qrcode.js`).
