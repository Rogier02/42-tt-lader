# 42 Table Tennis Ladder

A rating ladder for the table tennis players at 42. Players sign in, log matches, climb the ladder, and play small knockout tournaments.

> **Status: clickable demo.** Everything runs in the browser. Sign-in is simulated, and data is saved in the browser's local storage. There is no backend yet.

## Try it

Open `index.html` in any browser. You don't need a build step or a server.

To host it for free, enable **GitHub Pages**: in the repo, go to Settings → Pages → Deploy from branch → `main` / root.

## What the demo does

- **Simulated 42 sign-in.** You pick one of 14 example players. The real version will use 42 OAuth.
- **Ladder.** Players are ranked by a Glicko-2 rating. Ratings marked *provisional* are still settling, because the player has few games or a high rating deviation.
- **Season points.** These are separate from rating and reward playing:
  - a win earns 3 points, plus 2 more for an upset over a player rated 50 or more points higher
  - a loss earns 1 point
  - tournaments award the champion 10, the runner-up 6, and each semifinalist 3
- **Match logging with confirmation.** One player logs the score and the opponent confirms or disputes it. Ratings change only after confirmation.
- **Score validation.** Each set follows ITTF rules: play to 11, win by 2. Matches are best of 3 or best of 5.
- **Prediction.** Before you log a match, the page shows your win chance and how much your rating would move either way.
- **Knockout tournaments.** Single elimination, seeded by rating. Top seeds get byes when the field isn't a power of two. Tournament matches also count toward the ladder.
- **Profiles.** Each player has a rating-history chart and a list of recent matches.

**Reset demo data** restores the example dataset.

## Roadmap

1. A backend and database, for example Postgres. Rating updates, match confirmation and brackets move server-side.
2. Real sign-in through the 42 intra API (OAuth2). The app needs to be registered at profile.intra.42.fr.
3. Auto-confirm results 24 hours after logging.
4. Rating deviation that grows with inactivity, so a player's rating becomes uncertain again after time away.
5. Seasons that reset points while keeping ratings.
6. A QR code at the table that opens the "log a match" screen.

## Rating system

Ratings use [Glicko-2](http://www.glicko.net/glicko/glicko2.pdf) with τ = 0.5. Each match is treated as its own rating period, and the rating deviation never drops below 45.
