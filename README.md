# Cousins' Poker

A private, browser-based No-Limit Hold'em tournament — built from scratch so it's genuinely
yours: your code, your server, your table, no third-party poker site involved.

Create a table, get a 5-letter code, send it to your cousins, everyone joins from their
phone or laptop, the host hits **Start**, and it plays a full multi-table-style NLH
tournament: blinds that increase on a timer, side pots handled correctly when someone goes
all-in, hand-by-hand elimination, and a final winner.

**Zero dependencies.** No `npm install` needed — it's built entirely on Node's built-in
modules (the hand evaluator, IDs, and web server are all hand-written in `server/`). That
means it deploys anywhere that can run `node server/index.js`, with nothing to go wrong in
between.

## Running it yourself (to try it locally)

```
node server/index.js
```

Then open `http://localhost:3000`. Two browser tabs (or one normal + one incognito window)
will simulate two players joining the same table.

## Putting it online so your cousins in France can join

For your cousins to reach it, the server needs to run somewhere on the public internet
rather than on your own laptop. The easiest free option that reliably supports this kind of
always-on server is **[Render](https://render.com)**. Here's the whole path, no coding
required beyond what's already written:

1. **Put the code on GitHub** (a free account, if you don't have one already — [github.com/join](https://github.com/join)):
   - Create a new repository (any name, e.g. `cousins-poker`).
   - On the repo page, click **Add file → Upload files**, and drag in this entire project
     folder (or its contents). Commit the upload.

2. **Deploy it on Render** (also free — [render.com](https://render.com)):
   - Sign up, then click **New → Web Service**.
   - Connect the GitHub repo you just created.
   - Settings: **Build Command** → leave blank or `npm install` (there's nothing to
     install, so this is instant either way). **Start Command** → `node server/index.js`.
   - Choose the **Free** instance type and click **Deploy**.
   - After a minute or two you'll get a live URL like `https://cousins-poker.onrender.com`.

3. **Play:**
   - Open your URL, create the tournament, and you'll get a 5-letter table code plus a
     shareable invite link (`.../?join=CODE`).
   - Send that link to your cousins over WhatsApp, iMessage, whatever — they open it, type
     their name, and they're seated. No app, no account, no download.

One thing worth knowing about the free tier: if the table sits idle for 15+ minutes (nobody
polling it), Render "spins down" the server to save resources, and the next visit takes
about a minute to wake back up. That's a non-issue once you're mid-game — action pings the
server constantly — it just means the very first person to open the link before you start
might see a short loading delay.

## Because it's really yours

The whole point of building this instead of pointing you at someone else's site: it's your
GitHub repo and your Render account. You can reskin it, add a custom domain, tweak the blind
structure, or hand the code to a cousin who wants to add a feature — nobody else's platform,
nobody else's rules.

## How the tournament works

- **Starting stack & blind pace** are set when you create the table (defaults: 10,000 chips,
  15-minute levels).
- **Blinds increase automatically** on the schedule in `server/game.js` — 14 levels from
  25/50 up through 2,000/4,000 with antes kicking in from level 4.
- **Side pots** are computed correctly whenever a shorter stack goes all-in against deeper
  stacks — nobody can win more than they're eligible to.
- **A player who goes quiet mid-hand** (phone locks, connection drops) is auto-folded (or
  auto-checked if they owe nothing) after 60 seconds, so the table never stalls waiting on
  one person.
- **Elimination and final standings** are tracked automatically; the last player with chips
  is the tournament winner.

## Known simplifications (vs. formal casino rules)

Built for a friendly family game, not a casino:
- A short all-in that's less than a full minimum raise still re-opens the betting round for
  players who already acted (in formal rules it sometimes shouldn't). This essentially never
  matters in practice and keeps the logic much simpler.
- No rebuys/add-ons or late registration once a tournament has started — everyone joins in
  the lobby before the host clicks Start.
- Odd chips left over when splitting a pot go to the first eligible winner found, rather than
  strictly to the seat closest to the button.

## Project structure

```
server/
  index.js          — the web server (plain Node http, no framework) and JSON API
  game.js            — the poker/tournament engine (betting rounds, side pots, blinds, eliminations)
  handEvaluator.js   — 7-card hand evaluator (High Card through Royal Flush), no dependencies
  deck.js            — shuffling
  ids.js             — table codes and player tokens
public/
  index.html, style.css, app.js  — the whole frontend, no build step, no framework
test/
  handEvaluator.test.js   — unit tests for hand ranking
  integration.test.js     — plays real hands through the HTTP API, including a forced
                             all-in/side-pot scenario and a full tournament to conclusion
```

Run the tests any time with `node test/handEvaluator.test.js` and
`node test/integration.test.js`.
