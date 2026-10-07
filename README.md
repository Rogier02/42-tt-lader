# 42 Table Tennis Ladder

A rating ladder for the table tennis players at 42. Students sign in with their 42 account, log matches, climb the ladder, and run small knockout tournaments.

## Run it locally

You need Node.js 22.13 or newer. Check your version with `node -v`.

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

Without 42 credentials the app runs in **dev mode**. Sign-in is simulated, and an empty database is filled with 14 demo players, about 70 matches and a knockout that's still running. To start over, delete the `data/` folder.

Run the tests with `npm test`.

## Turn on real 42 sign-in

1. Go to profile.intra.42.fr, open **API**, and register a new app.
2. Set the redirect URI to `<BASE_URL>/auth/42/callback`, for example `http://localhost:3000/auth/42/callback`.
3. Copy `.env.example` to `.env` and fill in these values:
   - `FT_CLIENT_ID` and `FT_CLIENT_SECRET` from the app you registered
   - `COOKIE_SECRET`, which you can generate with `openssl rand -hex 32`
   - `BASE_URL`
4. Restart the server. The login screen now shows **Sign in with 42 intra**.

You can also set these optional values:
- `ALLOWED_CAMPUS_IDS` limits sign-in to students of your campus.
- `ADMIN_LOGINS` lists the 42 logins that may enter results for any tournament.

## How it works

| Part | Where |
|---|---|
| Server, routes, 42 OAuth, sessions | `server/app.js` |
| Glicko-2, score rules, brackets | `server/rules.js` |
| Ratings and points, replayed from the match log | `server/standings.js` |
| Database schema (SQLite, built into Node) | `server/db.js` |
| The web app (one page) | `public/index.html` |
| The original static demo, for GitHub Pages | `docs/index.html` |

**The match log is the source of truth.** Ratings, records and season points are never stored. The server recomputes them by replaying every confirmed match in order. That keeps every number auditable. It also means you can fix a result or change the points rules and the whole ladder updates.

### Rules

- **Rating:** [Glicko-2](http://www.glicko.net/glicko/glicko2.pdf) with τ = 0.5. Each match is treated as its own rating period, and the rating deviation never drops below 45.
- **Season points:**
  - a win earns 3, plus 2 more for beating someone rated 50 or more points higher
  - a loss earns 1
  - tournaments award the champion 10, the runner-up 6 and each semifinalist 3
  - points count only from `SEASON_START` on, while ratings carry over between seasons
- **Confirmation:** one player logs the result and the opponent confirms or disputes it. Results nobody responds to confirm themselves after `AUTO_CONFIRM_HOURS` (24 by default).
- **Scores:** sets follow ITTF rules: play to 11, win by 2.
- **Tournaments:** single elimination, best of 3, seeded by rating. Top seeds get byes. The two players, the organiser or an admin can enter a result, and tournament results count right away.

## Deploying

A single small server is enough. The app is one Node process and one SQLite file.

- Set `HOST=0.0.0.0` and `BASE_URL=https://your-domain`, and put the server behind HTTPS. Most hosts handle HTTPS for you.
- Keep `data/ladder.db` on a persistent disk and back it up regularly.
- Update the redirect URI in your 42 app to match the new `BASE_URL`.

## Privacy

The app stores each user's 42 login, display name, profile picture link and the matches they play. If someone asks to be removed, delete their user row and their matches.
