// Seasons: the current one runs until an admin ends it. Ending a season freezes its final
// coalition standings and top players, then starts the next season. Season points reset; ratings carry over.

function ensureSeason(db, config) {
  if (db.prepare('SELECT 1 FROM seasons LIMIT 1').get()) return;
  const firstMatch = db.prepare('SELECT MIN(confirmed_at) AS t FROM matches WHERE confirmed_at IS NOT NULL').get().t;
  const start = config.seasonStart || firstMatch || Date.now();
  db.prepare('INSERT INTO seasons (name, starts_at) VALUES (?, ?)').run(config.seasonName, start);
}

const currentSeason = (db) => db.prepare('SELECT * FROM seasons WHERE ends_at IS NULL ORDER BY id DESC LIMIT 1').get();

// Freeze what the season ended with. Names are copied so history survives later profile changes.
function snapshot(st) {
  const who = (id) => { const p = st.players.get(Number(id)); return { id: Number(id), name: p?.name ?? 'Unknown', login: p?.login ?? '' }; };
  const coalitions = st.coalitions.map((c) => ({
    name: c.name, points: c.points, wins: c.wins, losses: c.losses, members: c.members,
    top: Object.entries(c.contributors).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, pts]) => ({ ...who(id), pts })),
  }));
  const contributions = st.coalitions.flatMap((c) => Object.entries(c.contributors).map(([id, pts]) => ({ ...who(id), pts, coalition: c.name })));
  const mvp = contributions.sort((a, b) => b.pts - a.pts)[0] || null;
  const topPlayers = [...st.players.values()].filter((p) => p.pts > 0).sort((a, b) => b.pts - a.pts).slice(0, 3).map((p) => ({ ...who(p.id), pts: p.pts }));
  const winner = coalitions[0] && coalitions[0].points > 0 ? coalitions[0].name : null;
  return { winner, coalitions, mvp, topPlayers };
}

function seasonRoutes(app, { db, now, tx, fail, auth, standings, invalidate }) {
  const adminOnly = async (req, reply) => { if (!req.user.is_admin) return fail(reply, 403, 'Only admins can do this.'); };
  const cleanDate = (v) => (v === null || v === '' || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : NaN);

  app.post('/api/seasons/current', { preHandler: [auth, adminOnly] }, async (req, reply) => {
    const cur = currentSeason(db);
    const name = String(req.body?.name ?? cur.name).trim().slice(0, 40);
    const prize = String(req.body?.prize ?? cur.prize).trim().slice(0, 300);
    const plannedEnd = req.body && 'plannedEnd' in req.body ? cleanDate(req.body.plannedEnd) : cur.planned_end;
    if (!name) return fail(reply, 400, 'The season needs a name.');
    if (Number.isNaN(plannedEnd)) return fail(reply, 400, 'That end date is not valid.');
    db.prepare('UPDATE seasons SET name = ?, prize = ?, planned_end = ? WHERE id = ?').run(name, prize, plannedEnd, cur.id);
    return { ok: true };
  });

  app.post('/api/seasons/end', { preHandler: [auth, adminOnly] }, async (req, reply) => {
    const cur = currentSeason(db);
    const nextName = String(req.body?.nextName || '').trim().slice(0, 40);
    const nextPrize = String(req.body?.nextPrize || '').trim().slice(0, 300);
    const nextEnd = cleanDate(req.body?.nextPlannedEnd);
    if (!nextName) return fail(reply, 400, 'Give the next season a name.');
    if (nextName === cur.name) return fail(reply, 400, 'The next season needs a different name.');
    if (Number.isNaN(nextEnd)) return fail(reply, 400, 'That end date is not valid.');
    const results = snapshot(standings());
    const ts = now();
    tx(() => {
      db.prepare('UPDATE seasons SET ends_at = ?, results = ? WHERE id = ?').run(ts, JSON.stringify(results), cur.id);
      db.prepare('INSERT INTO seasons (name, starts_at, planned_end, prize) VALUES (?, ?, ?, ?)').run(nextName, ts, nextEnd, nextPrize);
    });
    invalidate();
    return { ok: true, winner: results.winner };
  });
}

module.exports = { ensureSeason, currentSeason, snapshot, seasonRoutes };
