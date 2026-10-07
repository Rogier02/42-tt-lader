// "A challenger approaches"
// Every week (Monday 08:00, server time) each player who hasn't opted out gets a challenger: a random
// opponent within RATING_BAND, preferring another coalition and someone they haven't played lately.
// Players who complete their weekly challenge can be drawn again for one bonus round that week.
// A challenger match is worth MULTIPLIER x season points and coalition points. Ratings are unaffected.

const MATCHUPS = { multiplier: 3, ratingBand: 150, drawDay: 1, drawHour: 8, maxPerWeek: 2 };
const DAY = 864e5;

// Start of the current matchup week (the most recent draw moment).
function weekStart(now = Date.now()) {
  const d = new Date(now);
  d.setHours(MATCHUPS.drawHour, 0, 0, 0);
  const back = (d.getDay() - MATCHUPS.drawDay + 7) % 7;
  d.setDate(d.getDate() - back);
  if (d.getTime() > now) d.setDate(d.getDate() - 7);
  return d.getTime();
}
const weekKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// Pairs players up. ratings: Map id -> rating. Returns [[a, b], ...]; everyone ends up in at least one pair
// when there are 2 or more players (the odd one out gets paired with the closest player).
// opts.forbid: pairs that may not be drawn (e.g. already met this week). opts.everyone: give the odd one out a pair too.
function pair(ids, ratings, coalitionOf, recentlyPlayed, random = Math.random, opts = {}) {
  const forbid = opts.forbid || new Set(), everyone = opts.everyone !== false;
  // Most constrained first: players with the fewest opponents in their rating band get paired before others,
  // so strong and weak players at the edges don't end up with nobody close to them.
  const band = (a) => ids.filter((b) => b !== a && !forbid.has(key(a, b)) && Math.abs(ratings.get(a) - ratings.get(b)) <= MATCHUPS.ratingBand).length;
  const pool = [...ids].map((id) => [id, band(id) + random()]).sort((x, y) => x[1] - y[1]).map(([id]) => id), taken = new Set(), pairs = [];
  const score = (a, b) => (coalitionOf.get(a) && coalitionOf.get(a) !== coalitionOf.get(b) ? 2 : 0) + (recentlyPlayed.has(key(a, b)) ? 0 : 1) + random() * 0.5;
  for (const a of pool) {
    if (taken.has(a)) continue;
    const free = pool.filter((b) => b !== a && !taken.has(b) && !forbid.has(key(a, b)));
    if (!free.length) continue;
    const inBand = free.filter((b) => Math.abs(ratings.get(a) - ratings.get(b)) <= MATCHUPS.ratingBand);
    const b = inBand.length
      ? inBand.sort((x, y) => score(a, y) - score(a, x))[0]
      : free.sort((x, y) => Math.abs(ratings.get(a) - ratings.get(x)) - Math.abs(ratings.get(a) - ratings.get(y)))[0];
    taken.add(a); taken.add(b); pairs.push([a, b]);
  }
  const left = pool.filter((id) => !taken.has(id));
  if (everyone && left.length === 1 && pool.length > 1) {
    const a = left[0];
    const b = pool.filter((x) => x !== a).sort((x, y) => Math.abs(ratings.get(a) - ratings.get(x)) - Math.abs(ratings.get(a) - ratings.get(y)))[0];
    pairs.push([a, b]);
  }
  return pairs;
}
const key = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

// Runs the weekly draw if it hasn't happened yet, and pairs up players waiting for a bonus round.
// ratings: Map id -> current rating. Returns the number of matchups created.
function tick(db, ratings, now = Date.now(), random = Math.random) {
  const start = weekStart(now), week = weekKey(start), expires = start + 7 * DAY;
  const eligible = db.prepare('SELECT id, coalition FROM users WHERE matchups_opt_out = 0').all();
  const coalitionOf = new Map(eligible.map((u) => [u.id, u.coalition]));
  const recent = new Set(db.prepare(`SELECT reporter_id a, opponent_id b FROM matches WHERE status = 'confirmed' AND confirmed_at > ?`)
    .all(now - 14 * DAY).map((m) => key(m.a, m.b)));
  const ins = db.prepare('INSERT INTO matchups (week, kind, a_id, b_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)');
  const rate = (id) => ratings.get(id) ?? 1500;
  const rmap = new Map(eligible.map((u) => [u.id, rate(u.id)]));
  let created = 0;

  if (!db.prepare(`SELECT 1 FROM matchups WHERE week = ? AND kind = 'weekly' LIMIT 1`).get(week) && eligible.length >= 2) {
    for (const [a, b] of pair(eligible.map((u) => u.id), rmap, coalitionOf, recent, random)) { ins.run(week, 'weekly', a, b, now, expires); created++; }
  }

  // Bonus round: players who completed a challenge this week, have room for one more, and no open one.
  const mine = db.prepare(`SELECT m.*, (SELECT COUNT(*) FROM matches x WHERE x.matchup_id = m.id AND x.status = 'confirmed') AS done
                           FROM matchups m WHERE week = ?`).all(week);
  const count = new Map(), open = new Set(), completed = new Set();
  for (const m of mine) for (const id of [m.a_id, m.b_id]) {
    count.set(id, (count.get(id) || 0) + 1);
    if (m.done) completed.add(id); else if (m.expires_at > now) open.add(id);
  }
  const waiting = [...completed].filter((id) => coalitionOf.has(id) && !open.has(id) && (count.get(id) || 0) < MATCHUPS.maxPerWeek);
  if (waiting.length >= 2) {
    // A bonus round is always a new opponent: pairs that already met this week are never drawn again.
    const metThisWeek = new Set(mine.map((m) => key(m.a_id, m.b_id)));
    const pairs = pair(waiting, rmap, coalitionOf, recent, random, { forbid: metThisWeek, everyone: false });
    for (const [a, b] of pairs) { ins.run(week, 'bonus', a, b, now, expires); created++; }
  }
  return created;
}

// The open matchup between two players right now, if any (used when a result is logged).
function openBetween(db, a, b, now = Date.now()) {
  return db.prepare(`SELECT m.* FROM matchups m WHERE ((a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?)) AND expires_at > ?
                     AND NOT EXISTS (SELECT 1 FROM matches x WHERE x.matchup_id = m.id AND x.status IN ('pending','confirmed'))
                     ORDER BY created_at LIMIT 1`).get(a, b, b, a, now);
}

module.exports = { MATCHUPS, tick, openBetween, weekStart, pair };
