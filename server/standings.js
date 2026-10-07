// Replays every confirmed match in order to produce ratings, records and season points.
// Recomputing from the log keeps every number auditable and makes rule changes safe.
const rules = require('./rules');
const MULT = require('./matchups').MATCHUPS.multiplier; // challenger matches count triple

const POINTS = { win: 3, loss: 1, upsetBonus: 2, upsetMargin: 50, champion: 10, runnerUp: 6, semifinal: 3 };

// Coalition race: only matches between players of different coalitions count.
// A win scores for the winner's coalition, a loss costs nothing (the other coalition gains instead).
// Beating a higher-rated player scores more. The first `fullPerPairPerWeek` matches between the same two
// players each week score in full; after that each win still scores `afterCap`, so variety pays more.
const COALITION_POINTS = {
  win: 3,
  upset: 5, upsetMargin: 50,          // opponent rated 50+ higher
  bigUpset: 9, bigUpsetMargin: 100,   // opponent rated 100+ higher
  fullPerPairPerWeek: 3, afterCap: 1,
  champion: 10, runnerUp: 6, semifinal: 3,
  tournamentPlayer: 1,                // every player in a finished tournament, on top of any placement points
};
function coalitionWinPoints(ratingGap, nthThisWeek) {
  const C = COALITION_POINTS;
  if (nthThisWeek > C.fullPerPairPerWeek) return C.afterCap;
  if (ratingGap >= C.bigUpsetMargin) return C.bigUpset;
  if (ratingGap >= C.upsetMargin) return C.upset;
  return C.win;
}
const WEEK = 7 * 864e5;

// Season points and the coalition race count from seasonStart up to seasonEnd (null = still running).
function compute(db, seasonStart, coalitionNames = [], seasonEnd = null) {
  const inRange = (t) => t >= seasonStart && (seasonEnd == null || t < seasonEnd);
  const players = new Map();
  const coalitionOf = new Map(db.prepare('SELECT id, coalition FROM users').all().map((u) => [u.id, u.coalition]));
  const coalitions = new Map();
  const coal = (name) => {
    if (!coalitions.has(name)) coalitions.set(name, { name, points: 0, wins: 0, losses: 0, members: 0, contributors: {}, vs: {} });
    return coalitions.get(name);
  };
  coalitionNames.forEach(coal);
  for (const c of coalitionOf.values()) if (c) coal(c).members++;
  const pairWeek = new Map();
  const scoreCoalition = (userId, n) => { const c = coalitionOf.get(userId); if (!c || !n) return; coal(c).points += n; coal(c).contributors[userId] = (coal(c).contributors[userId] || 0) + n; };
  for (const u of db.prepare('SELECT id, login, name, image_url FROM users ORDER BY id').all()) {
    players.set(u.id, { id: u.id, login: u.login, name: u.name, image: u.image_url, ...rules.START, w: 0, l: 0, pts: 0, hist: [] });
  }

  const meta = new Map(); // matchId -> {delta, pts, upset}
  const rows = db.prepare(`SELECT id, reporter_id, opponent_id, winner_id, confirmed_at, matchup_id FROM matches
                           WHERE status = 'confirmed' ORDER BY confirmed_at, id`).all();
  for (const m of rows) {
    const A = players.get(m.reporter_id), B = players.get(m.opponent_id);
    const aWon = m.winner_id === A.id;
    const W = aWon ? A : B, L = aWon ? B : A;
    const gap = L.r - W.r; // how much higher the loser was rated before the match
    const upset = W.r < L.r - POINTS.upsetMargin;
    const na = rules.glicko(A, B, aWon ? 1 : 0), nb = rules.glicko(B, A, aWon ? 0 : 1);
    const inSeason = inRange(m.confirmed_at);
    const x = m.matchup_id ? MULT : 1;
    const wPts = inSeason ? (POINTS.win + (upset ? POINTS.upsetBonus : 0)) * x : 0;
    const lPts = inSeason ? POINTS.loss * x : 0;
    // Coalition race
    let coalPts = 0;
    const cw = coalitionOf.get(W.id), cl = coalitionOf.get(L.id);
    if (inSeason && cw && cl && cw !== cl) {
      // Challenger matches don't count toward (or get reduced by) the weekly limit per pair.
      const key = `${Math.min(A.id, B.id)}-${Math.max(A.id, B.id)}-${Math.floor(m.confirmed_at / WEEK)}`;
      const n = m.matchup_id ? 1 : (pairWeek.get(key) || 0) + 1;
      if (!m.matchup_id) pairWeek.set(key, n);
      coal(cw).wins++; coal(cl).losses++;
      coal(cw).vs[cl] = coal(cw).vs[cl] || { w: 0, l: 0 }; coal(cw).vs[cl].w++;
      coal(cl).vs[cw] = coal(cl).vs[cw] || { w: 0, l: 0 }; coal(cl).vs[cw].l++;
      coalPts = coalitionWinPoints(gap, n) * x;
      scoreCoalition(W.id, coalPts);
    }
    meta.set(m.id, { delta: { [A.id]: na.r - A.r, [B.id]: nb.r - B.r }, pts: { [W.id]: wPts, [L.id]: lPts }, upset, coalPts, coalition: coalPts ? cw : null, challenger: !!m.matchup_id });
    Object.assign(A, na); Object.assign(B, nb);
    W.w++; L.l++; W.pts += wPts; L.pts += lPts;
    A.hist.push({ t: m.confirmed_at, r: A.r }); B.hist.push({ t: m.confirmed_at, r: B.r });
  }

  const awards = new Map(); // tournamentId -> [{id, n, why}]
  for (const t of db.prepare('SELECT id, bracket, seeds, finished_at FROM tournaments WHERE finished_at IS NOT NULL').all()) {
    const rounds = JSON.parse(t.bracket), list = [], counts = inRange(t.finished_at);
    if (counts) for (const id of JSON.parse(t.seeds)) scoreCoalition(id, COALITION_POINTS.tournamentPlayer);
    const coalN = { Champion: COALITION_POINTS.champion, 'Runner-up': COALITION_POINTS.runnerUp, Semifinalist: COALITION_POINTS.semifinal };
    const give = (id, n, why) => {
      if (id == null) return;
      list.push({ id, n, why });
      if (counts) { players.get(id).pts += n; scoreCoalition(id, coalN[why]); }
    };
    const final = rounds[rounds.length - 1][0];
    give(final.w, POINTS.champion, 'Champion');
    give(final.a === final.w ? final.b : final.a, POINTS.runnerUp, 'Runner-up');
    if (rounds.length > 1) for (const s of rounds[rounds.length - 2]) if (!s.bye) give(s.a === s.w ? s.b : s.a, POINTS.semifinal, 'Semifinalist');
    awards.set(t.id, list);
  }

  return { players, meta, awards, coalitions: [...coalitions.values()].sort((a, b) => b.points - a.points) };
}

module.exports = { compute, POINTS, COALITION_POINTS, coalitionWinPoints };
