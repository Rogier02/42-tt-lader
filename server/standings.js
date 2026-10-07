// Replays every confirmed match in order to produce ratings, records and season points.
// Recomputing from the log keeps every number auditable and makes rule changes safe.
const rules = require('./rules');

const POINTS = { win: 3, loss: 1, upsetBonus: 2, upsetMargin: 50, champion: 10, runnerUp: 6, semifinal: 3 };

function compute(db, seasonStart) {
  const players = new Map();
  for (const u of db.prepare('SELECT id, login, name, image_url FROM users ORDER BY id').all()) {
    players.set(u.id, { id: u.id, login: u.login, name: u.name, image: u.image_url, ...rules.START, w: 0, l: 0, pts: 0, hist: [] });
  }

  const meta = new Map(); // matchId -> {delta, pts, upset}
  const rows = db.prepare(`SELECT id, reporter_id, opponent_id, winner_id, confirmed_at FROM matches
                           WHERE status = 'confirmed' ORDER BY confirmed_at, id`).all();
  for (const m of rows) {
    const A = players.get(m.reporter_id), B = players.get(m.opponent_id);
    const aWon = m.winner_id === A.id;
    const W = aWon ? A : B, L = aWon ? B : A;
    const upset = W.r < L.r - POINTS.upsetMargin;
    const na = rules.glicko(A, B, aWon ? 1 : 0), nb = rules.glicko(B, A, aWon ? 0 : 1);
    const inSeason = m.confirmed_at >= seasonStart;
    const wPts = inSeason ? POINTS.win + (upset ? POINTS.upsetBonus : 0) : 0;
    const lPts = inSeason ? POINTS.loss : 0;
    meta.set(m.id, { delta: { [A.id]: na.r - A.r, [B.id]: nb.r - B.r }, pts: { [W.id]: wPts, [L.id]: lPts }, upset });
    Object.assign(A, na); Object.assign(B, nb);
    W.w++; L.l++; W.pts += wPts; L.pts += lPts;
    A.hist.push({ t: m.confirmed_at, r: A.r }); B.hist.push({ t: m.confirmed_at, r: B.r });
  }

  const awards = new Map(); // tournamentId -> [{id, n, why}]
  for (const t of db.prepare('SELECT id, bracket, finished_at FROM tournaments WHERE finished_at IS NOT NULL').all()) {
    const rounds = JSON.parse(t.bracket), list = [];
    const give = (id, n, why) => { if (id == null) return; list.push({ id, n, why }); if (t.finished_at >= seasonStart) players.get(id).pts += n; };
    const final = rounds[rounds.length - 1][0];
    give(final.w, POINTS.champion, 'Champion');
    give(final.a === final.w ? final.b : final.a, POINTS.runnerUp, 'Runner-up');
    if (rounds.length > 1) for (const s of rounds[rounds.length - 2]) if (!s.bye) give(s.a === s.w ? s.b : s.a, POINTS.semifinal, 'Semifinalist');
    awards.set(t.id, list);
  }

  return { players, meta, awards };
}

module.exports = { compute, POINTS };
