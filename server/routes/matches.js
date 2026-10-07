// Friendly matches and challenges between two players.
const rules = require('../rules');
const matchups = require('../matchups');

module.exports = function matchRoutes(app, { db, now, fail, auth, standings, invalidate }) {
  const userExists = (id) => db.prepare('SELECT id FROM users WHERE id = ?').get(Number(id));

  app.post('/api/matches', { preHandler: auth }, async (req, reply) => {
    const { opponentId, bestOf, sets } = req.body || {};
    const opp = userExists(opponentId);
    if (!opp) return fail(reply, 400, 'Choose an opponent.');
    if (opp.id === req.user.id) return fail(reply, 400, "You can't play yourself.");
    const err = rules.checkMatch(sets, Number(bestOf));
    if (err) return fail(reply, 400, err);
    const [a, b] = rules.tally(sets);
    const winner = a > b ? req.user.id : opp.id;
    const mu = matchups.openBetween(db, req.user.id, opp.id, now());
    const ts = now();
    const id = Number(db.prepare(`INSERT INTO matches (reporter_id, opponent_id, best_of, sets, winner_id, status, created_at, issued_at, matchup_id)
                                  VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(req.user.id, opp.id, Number(bestOf), JSON.stringify(sets), winner, ts, ts, mu ? mu.id : null).lastInsertRowid);
    // Playing an accepted challenge closes it.
    db.prepare(`UPDATE challenges SET status = 'played', responded_at = ? WHERE status = 'accepted'
                AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`).run(now(), req.user.id, opp.id, opp.id, req.user.id);
    return { id, challenger: !!mu };
  });

  function changeStatus(req, reply, { from, to, who }) {
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(Number(req.params.id));
    if (!m) return fail(reply, 404, 'Match not found.');
    if (![].concat(from).includes(m.status)) return fail(reply, 409, `This result is already ${m.status}.`);
    if (m[who] !== req.user.id) return fail(reply, 403, 'This result is not yours to change.');
    if (to === 'disputed') {
      const reason = String(req.body?.reason || '').trim().slice(0, 200);
      db.prepare(`UPDATE matches SET status = 'disputed', disputed_at = ?, dispute_reason = ? WHERE id = ?`).run(now(), reason, m.id);
    } else {
      db.prepare('UPDATE matches SET status = ?, confirmed_at = ? WHERE id = ?').run(to, to === 'confirmed' ? now() : null, m.id);
    }
    invalidate();
    const st = standings();
    return { ok: true, delta: st.meta.get(m.id)?.delta?.[req.user.id] ?? null, pts: st.meta.get(m.id)?.pts?.[req.user.id] ?? null };
  }
  // The opponent confirms (also after disputing, if it was a misclick) or disputes; the reporter can withdraw.
  app.post('/api/matches/:id/confirm', { preHandler: auth }, async (req, reply) => changeStatus(req, reply, { from: ['pending', 'disputed'], to: 'confirmed', who: 'opponent_id' }));
  app.post('/api/matches/:id/dispute', { preHandler: auth }, async (req, reply) => changeStatus(req, reply, { from: 'pending', to: 'disputed', who: 'opponent_id' }));
  app.post('/api/matches/:id/withdraw', { preHandler: auth }, async (req, reply) => changeStatus(req, reply, { from: ['pending', 'disputed'], to: 'withdrawn', who: 'reporter_id' }));

  // The reporter fixes a pending or disputed result and sends it again. It keeps its original played time,
  // so it stays in the same place in the rating order; the auto-confirm clock restarts.
  app.post('/api/matches/:id/edit', { preHandler: auth }, async (req, reply) => {
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(Number(req.params.id));
    if (!m) return fail(reply, 404, 'Match not found.');
    if (m.reporter_id !== req.user.id) return fail(reply, 403, 'Only the player who logged this result can edit it.');
    if (!['pending', 'disputed'].includes(m.status)) return fail(reply, 409, `This result is already ${m.status}.`);
    const { bestOf, sets } = req.body || {};
    const err = rules.checkMatch(sets, Number(bestOf));
    if (err) return fail(reply, 400, err);
    const [a, b] = rules.tally(sets);
    // If the challenger matchup was taken over by another result in the meantime, this one no longer counts for it.
    const taken = m.matchup_id && db.prepare(`SELECT 1 FROM matches WHERE matchup_id = ? AND id != ? AND status IN ('pending','confirmed')`).get(m.matchup_id, m.id);
    db.prepare(`UPDATE matches SET best_of = ?, sets = ?, winner_id = ?, status = 'pending', issued_at = ?, edited_at = ?, edits = edits + 1,
                matchup_id = ? WHERE id = ?`).run(Number(bestOf), JSON.stringify(sets), a > b ? m.reporter_id : m.opponent_id, now(), now(), taken ? null : m.matchup_id, m.id);
    return { ok: true };
  });

  // ---------- challenges ----------
  app.post('/api/challenges', { preHandler: auth }, async (req, reply) => {
    const { opponentId, bestOf } = req.body || {};
    const message = String(req.body?.message || '').trim().slice(0, 140);
    const opp = userExists(opponentId);
    if (!opp) return fail(reply, 400, 'Choose who to challenge.');
    if (opp.id === req.user.id) return fail(reply, 400, "You can't challenge yourself.");
    if (!rules.BEST_OF.includes(Number(bestOf))) return fail(reply, 400, 'Best of 3, 5 or 7 only.');
    const open = db.prepare(`SELECT id FROM challenges WHERE status IN ('open','accepted')
                             AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`).get(req.user.id, opp.id, opp.id, req.user.id);
    if (open) return fail(reply, 409, 'You already have an open challenge with this player.');
    const id = Number(db.prepare(`INSERT INTO challenges (from_id, to_id, best_of, message, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)`)
      .run(req.user.id, opp.id, Number(bestOf), message, now()).lastInsertRowid);
    return { id };
  });

  function respond(req, reply, { from, to, who }) {
    const c = db.prepare('SELECT * FROM challenges WHERE id = ?').get(Number(req.params.id));
    if (!c) return fail(reply, 404, 'Challenge not found.');
    if (!from.includes(c.status)) return fail(reply, 409, `This challenge is already ${c.status}.`);
    if (c[who] !== req.user.id) return fail(reply, 403, 'This challenge is not yours to change.');
    db.prepare('UPDATE challenges SET status = ?, responded_at = ? WHERE id = ?').run(to, now(), c.id);
    return { ok: true };
  }
  app.post('/api/challenges/:id/accept', { preHandler: auth }, async (req, reply) => respond(req, reply, { from: ['open'], to: 'accepted', who: 'to_id' }));
  app.post('/api/challenges/:id/decline', { preHandler: auth }, async (req, reply) => respond(req, reply, { from: ['open', 'accepted'], to: 'declined', who: 'to_id' }));
  app.post('/api/challenges/:id/cancel', { preHandler: auth }, async (req, reply) => respond(req, reply, { from: ['open', 'accepted'], to: 'cancelled', who: 'from_id' }));
};
