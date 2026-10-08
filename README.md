# 42 Table Tennis Ladder

A rating ladder for the table tennis players at 42. Students sign in with their 42 account, log matches, climb the ladder, and run small knockout tournaments.

## Two copies: test and live

The app runs as two separate copies on your computer, each with its own database:

| | Test | Live |
|---|---|---|
| Folder | this repo (`42-tt-ladder`) | `../42-tt-ladder-live` |
| Git branch | `dev`, where you work | `main`, what's released |
| Address | http://localhost:3000 | http://localhost:3001 |
| Sign-in | simulated, pick any demo player | real 42 accounts |
| Data | demo data, throw away any time | the real ladder, backed up daily |
| Start with | `npm run dev` | `npm run live` |

The test copy shows an orange **Test** badge, so you can always tell them apart.

### First-time setup

You need Node.js 22.13 or newer (`node -v`).

1. **Commit your work and create the `dev` branch.**
   ```bash
   git add -A && git commit -m "Test and live copies"
   git push
   git checkout -b dev
   git push -u origin dev
   ```
2. **Register the app on 42 intra.** Go to profile.intra.42.fr → Settings → API → *Register a new app*.
   - Name: anything, for example "42 Table Tennis Ladder".
   - Redirect URI: `http://localhost:3001/auth/42/callback`. Add `http://localhost:3000/auth/42/callback` on a second line if you ever want to try real sign-in on the test copy.
   - Scopes: *public*.
   - Then keep the app page open; you need its UID and SECRET.
3. **Set up the live copy.** It asks for the UID, the SECRET and your 42 login (which makes you admin).
   ```bash
   npm install
   npm run setup:live
   ```
4. **Release and start live.**
   ```bash
   npm run release
   npm run live        # in its own terminal window; keep it open
   ```
5. Open http://localhost:3001 and sign in with 42. You're the first player and the admin.

### Everyday work

```bash
npm run dev                      # test copy at localhost:3000; restarts when you save a file
# ...change things, try them...
git add -A && git commit -m "What changed"
npm run release                  # tests, then makes it live
```

`npm run release` refuses to run with uncommitted changes or failing tests. It then:
1. moves `main` up to `dev` and pushes both branches to GitHub
2. backs up the live database
3. installs the new version next to the old one
4. switches live over; a running `npm run live` picks it up within seconds

| Command | What it does |
|---|---|
| `npm run rollback` | Switches live back to the previous release. The database is left as is. |
| `npm run rollback -- --list` | Shows the releases on disk and which one is live. |
| `npm run backup:live` | Makes a copy of the live database now. Copies are in `../42-tt-ladder-live/backups/`. |
| `npm run setup:live` | Changes live settings, for example a renewed 42 app SECRET. Restart live afterwards. |

To start the test copy over with fresh demo data, delete its `data/` folder. In the demo data, Sanne de Vries is an admin.

Run the tests with `npm test`.

### Live settings

`../42-tt-ladder-live/.env` holds the live settings. It's written by `npm run setup:live` and never goes into git. Besides the 42 credentials:
- `ADMIN_LOGINS`: the 42 logins of admins. Admins approve tournaments, manage seasons and can manage any tournament.
- `ALLOWED_CAMPUS_IDS`: only students of these campuses can sign in. The live log prints each player's campus id when they sign in, so check yours after your first sign-in.
- `REQUIRE_TOURNAMENT_APPROVAL=false`: tournaments go live without approval.
- `CHALLENGERS=false`: switches off the weekly challenger matchups.
- `COALITIONS`: coalition names. Each player's coalition comes from the 42 API.

## How it works

| Part | Where |
|---|---|
| Server, 42 OAuth, sessions, the `/api/state` endpoint | `server/app.js` |
| Matches and challenges | `server/routes/matches.js` |
| Tournament calendar, approval, invites, brackets | `server/routes/tournaments.js` |
| Glicko-2, score rules, brackets | `server/rules.js` |
| Ratings and points, replayed from the match log | `server/standings.js` |
| Database schema and migrations (SQLite, built into Node) | `server/db.js` |
| The web app: layout and styles, then behaviour | `public/index.html`, `public/app.js` |
| The original static demo, for GitHub Pages | `docs/index.html` |

**The match log is the source of truth.** Ratings, records and season points are never stored. The server recomputes them by replaying every confirmed match in order. That keeps every number auditable. It also means you can fix a result or change the points rules and the whole ladder updates.

### Rules

- **Rating:** [Glicko-2](http://www.glicko.net/glicko/glicko2.pdf) with τ = 0.5. Each match is treated as its own rating period, and the rating deviation never drops below 45. Longer matches move ratings more: a best of 3 counts ×0.75, a best of 5 ×1 and a best of 7 ×1.25. Each match in a player's history shows their rating before and after it.
- **Season points:**
  - a win earns 3, plus 2 more for beating someone rated 50 or more points higher
  - a loss earns 1
  - tournaments award the champion 10, the runner-up 6 and each semifinalist 3
  - points count only from `SEASON_START` on, while ratings carry over between seasons
- **Confirmation:** one player logs the result and the opponent confirms or disputes it. Results nobody responds to confirm themselves after `AUTO_CONFIRM_HOURS` (24 by default).
- **Disputes:** disputing asks for confirmation first and takes an optional reason. A disputed result stays logged and shows as disputed for both players, but doesn't count. The reporter can edit it and send it again, or withdraw it, and the opponent can still confirm it after all. The reporter can also edit a result while it's waiting for confirmation. An edited result restarts the auto-confirm clock.
- **Order:** ratings are replayed in the order matches were played (logged), not the order they were confirmed. Confirming results in a different order always gives the same outcome, and a late confirmation or an edited result slots into its original place.
- **Scores:** sets follow ITTF rules: play to 11, win by 2.
- **Matches:** best of 3, 5 or 7. Choosing best of 7 shows a reminder that the school has one table.
- **Challenges:** you challenge a player and they accept or decline. Logging a result against them closes the challenge.
- **Tournaments:**
  - Anyone can plan one with a date, time, location, description and optional player limit. Sign-up can be open to everyone or invite only.
  - A tournament stays hidden until an admin approves it. Admins' own tournaments are published right away.
  - The format is set per stage (early rounds, quarterfinals, semifinals, final) as best of 3, 5 or 7. Three templates cover the usual cases: Quick, Standard and Championship. Once the bracket starts, the organiser can still change a round's format until it has results.
  - Brackets are single elimination, seeded by rating, and top seeds get byes. The two players, the organiser or an admin can enter a result, and tournament results count right away.
- **Coalitions:** Vela (red), Cetus (blue) and Pyxis (purple). With 42 sign-in, each player's coalition comes from the 42 API. Anyone without one gets a random coalition, balanced across the three.
- **Coalition race:** coalitions compete for points over the season. Only matches between players of different coalitions count.
  - A win earns your coalition 3 points. Beating someone rated 50+ higher earns 5, and a true upset against someone rated 100+ higher earns 9.
  - A loss costs nothing, but the other coalition scores.
  - Your first 3 matches against the same player each week score in full. After that, each win still earns 1 point, so variety pays more but playing the same person still counts.
  - Tournaments: every player earns +1 for their coalition for taking part. On top of that, placements score 10 for the champion, 6 for the runner-up and 3 for each semifinalist.
- **A challenger approaches:** every Monday at 08:00 the app gives every player a challenger. Opponents are random within 150 rating points, preferring someone from another coalition and someone you haven't played lately. With an odd number of players, one player gets two challengers.
  - Players have a week to play their challenger. Nothing happens if they don't.
  - Both players earn 3× season points and the winner earns 3× coalition points. Ratings count as normal.
  - Players who finish their challenge can be drawn again for one bonus round that week, always against someone new.
  - Players can switch weekly challengers off on their profile.
  - The settings are in `MATCHUPS` in `server/matchups.js`.
- **Activity:** a page listing every confirmed match by the day it was played: who played whom, the score and the time. Choose a day, 3 days or a week and step back through time. It shows the number of matches, the number of players, the most active player and the busiest day; the 3-day and week views have a bar per day.
- **Seasons:** an admin ends the current season from Ladder → Coalitions. That freezes the final standings (winning coalition, its top scorers and the MVP) and starts the next season right away. Season points and the coalition race reset; ratings carry over. Admins can also set a season name, a planned end date and a prize, which players see above the race. Past seasons are listed in the season history.
  - The numbers are in `COALITION_POINTS` in `server/standings.js`.
  - Coalition team matches (2v2, 3v3) are a planned next step.

## Going online later

Live runs on `localhost`, so only your own computer can reach it. Putting it on a server uses the same setup:
1. Clone the repo on the server.
2. Run `npm run setup:live`. Choose `HOST=0.0.0.0` and set `BASE_URL` to the public address, for example `https://ladder.example.com`.
3. Add that address's `/auth/42/callback` to the 42 app.
4. Keep `npm run live` running with a service manager, such as systemd or pm2, behind HTTPS (Caddy is the simplest).

The live database is one file, `data/ladder.db`. Moving it to the server moves the whole ladder.

## Privacy

The app stores each user's 42 login, display name, profile picture link and the matches they play. If someone asks to be removed, delete their user row and their matches.
