# Ronda UI spec

Written 2026-11-18 from reference material pulled that night (kept out of this repo: the screenshots belong to their makers): Kahoot Play listing (11 shots),
Quizizz/Wayground Play listing (8), the live join pages of menti.com, kahoot.it and app.sli.do (phone), and the
Mentimeter live-polling, word-cloud and live-quiz feature pages (desktop).

## What the references actually do

- **Joining** (all three): one screen, one field, one button. Kahoot: "Game PIN" + dark "Enter". Mentimeter: "Enter
  the code to join / It's on the screen in front of you", 8 digits shown as "1234 5678". Slido: "# enter code here"
  with an arrow button. Then a name (Kahoot) or nothing (Mentimeter, anonymous). All three put a cookie banner or
  terms line under it.
- **Kahoot question, player side**: a 2x2 grid of big coloured tiles (red, blue, yellow, green), each with a shape;
  on the phone the tiles carry shapes only, the question and answer text are on the big screen. The host screen
  shows the question on top, a picture in the middle and the same four tiles with text below.
- **Kahoot editor**: "Add question" sheet split into "Test knowledge" (Quiz, True or False, Puzzle, Type answer) and
  "Collect opinions" (Word cloud, Poll, ...), many behind a paywall (orange lock marks).
- **Quizizz player**: one question per screen, full-width stacked answer bars in four colours with the text on
  them, a progress chip "1/21", a streak and percent at the top.
- **Mentimeter**: results as plain vertical bars with the count above each and the label under it, the question
  top-left; a QR + "7/9" counter of who answered; formats: Multiple choice, Word cloud, Open ended, Scales,
  Ranking, Q&A. "1. Ask a question 2. Share the link 3. See results live".

## Best of all of them, for Ronda

1. **Home**: the code field first (most people opening it are joining), big, "Enter the code from the screen";
   below it one button "Make a quiz or poll", and the user's saved rondas as a short list (tap to open,
   play button to start). No sign-up, no cookie banner (nothing to consent to).
2. **Join**: code (6 digits, typed or from the QR / link `/123456`), then a name, then "You're in. Look at the
   screen." with your name shown. Link joins skip the code step.
3. **Editor**, one page: title, then the questions as cards. "Add" offers four kinds in two words each, none
   locked: **Quiz** (right answer, points), **Poll** (vote, no right answer), **Words** (short answers, word cloud),
   **Scale** (1 to 5). A card: the question, 2-4 answers (Quiz: tap the check mark of the right one(s)), time for
   Quiz (10/20/30/60 s). Saved as you type. Buttons at the bottom: **Start**, Share (a link that carries the whole
   quiz, or a file).
4. **Host screen** (laptop, TV, shared screen in a call, or a phone): lobby with the code huge, the QR and the
   address, names popping in, count, **Start**. Each question: text big, answers as coloured bars with letter A-D
   and the text, a time bar, "12 of 20 answered". When time runs out or everyone answered: bars fill with counts,
   the right one marked. Quiz: then the top 5. End: top 3, "Download results".
5. **Player phone**: answers as big coloured buttons with letter **and text** (so it works without seeing the big
   screen, e.g. on a call on the same phone); after tapping: "Sent"; at reveal: right / wrong, points, place.
   Words: a text field + send (up to 3). Scale: five big buttons 1-5.
6. Own look: Ronda's colours (not Kahoot's red/blue/yellow/green set), letters instead of Kahoot's shapes, no
   mascots, dark host screen readable on a projector, light text on solid colours (contrast checked).
