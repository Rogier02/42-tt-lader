// Tournament lifecycle:
//   proposed (waiting for an admin) -> open (invites and sign-ups) -> live (bracket) -> done
//   or rejected (by an admin) / cancelled (by the organiser or an admin).
const rules = require('../rules');

module.exports = function tournamentRoutes(app, { db, config, now, tx, fail, auth, standings, invalidate }) {
  const load = (id) => db.prepare('SELECT * FROM tournaments WHERE id = ?').get(Number(id));
  const isOrganiser = (t, user) => t.created_by === user.id || !!user.is_admin;
  const players = (tid) => db.prepare('SELECT user_id, status FROM tournament_players WHERE tournament_id = ?').all(tid);
  const joinedCount = (tid) => db.prepare(`SELECT COUNT(*) AS n FROM tournament_players WHERE tournament_id = ? AND status = 'joined'`).get(tid).n;
  const setPlayer = db.prepare(`INSERT INTO tournament_players (tournament_id, user_id, status, invited_by, created_at) VALUES (?, ?, ?, ?, ?)
                                ON CONFLICT (tournament_id, user_id) DO UPDATE SET status = excluded.status`);
  const validUserIds = (ids) => [...new Set((Array.isArray(ids) ? ids : []).map(Number))].filter((id) => db.prepare('SELECT 1 FROM users WHERE id = ?').get(id));

  // Pre-handler that loads the tournament and checks its status.
  const withT = (statuses) => async (req, reply) => {
    req.t = load(req.params.id);
    if (!req.t) return fail(reply, 404, 'Tournament not found.');
    if (statuses && !statuses.includes(req.t.status)) return fail(reply, 409, `Not possible while the tournament is ${req.t.status}.`);
  };

  app.post('/api/tournaments', { preHandler: auth }, async (req, reply) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 60);
    const description = String(b.description || '').trim().slice(0, 500);
    const location = String(b.location || '').trim().slice(0, 60);
    const startsAt = Number(b.startsAt);
    const stages = rules.cleanStages(b.stages);
    const maxPlayers = b.maxPlayers ? Number(b.maxPlayers) : null;
    if (!name) return fail(reply, 400, 'Give the tournament a name.');
    if (!Number.isFinite(startsAt) || startsAt < now() - 3600e3) return fail(reply, 400, 'Pick a date and time in the future.');
    if (!stages) return fail(reply, 400, 'Each stage must be best of 3, 5 or 7.');
    if (maxPlayers !== null && (!Number.isInteger(maxPlayers) || maxPlayers < 3 || maxPlayers > 64)) return fail(reply, 400, 'Max players must be between 3 and 64.');
    const invites = validUserIds(b.inviteIds).filter((id) => id !== req.user.id);
    const status = config.requireApproval && !req.user.is_admin ? 'proposed' : 'open';
    const ts = now();
    const id = tx(() => {
      const tid = Number(db.prepare(`INSERT INTO tournaments (name, description, location, starts_at, status, created_by, created_at, best_of,
                                     stage_best_of, max_players, signup_open, approved_by, seeds, bracket)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]')`)
        .run(name, description, location, startsAt, status, req.user.id, ts, stages.early, JSON.stringify(stages), maxPlayers,
          b.signupOpen === false ? 0 : 1, status === 'open' ? req.user.id : null).lastInsertRowid);
      if (b.playing) setPlayer.run(tid, req.user.id, 'joined', null, ts);
      for (const uid of invites) setPlayer.run(tid, uid, 'invited', req.user.id, ts);
      return tid;
    });
    return { id, status };
  });

  // ---------- approval ----------
  const adminOnly = async (req, reply) => { if (!req.user.is_admin) return fail(reply, 403, 'Only admins can do this.'); };
  app.post('/api/tournaments/:id/approve', { preHandler: [auth, adminOnly, withT(['proposed'])] }, async (req) => {
    db.prepare(`UPDATE tournaments SET status = 'open', approved_by = ? WHERE id = ?`).run(req.user.id, req.t.id);
    return { ok: true };
  });
  app.post('/api/tournaments/:id/reject', { preHandler: [auth, adminOnly, withT(['proposed'])] }, async (req) => {
    db.prepare(`UPDATE tournaments SET status = 'rejected' WHERE id = ?`).run(req.t.id);
    return { ok: true };
  });

  // ---------- players ----------
  function hasRoom(t) { return !t.max_players || joinedCount(t.id) < t.max_players; }

  app.post('/api/tournaments/:id/join', { preHandler: [auth, withT(['open'])] }, async (req, reply) => {
    const row = players(req.t.id).find((p) => p.user_id === req.user.id);
    if (row?.status === 'joined') return { ok: true };
    if (!req.t.signup_open && !row) return fail(reply, 403, 'This tournament is invite only.');
    if (!hasRoom(req.t)) return fail(reply, 409, 'The tournament is full.');
    setPlayer.run(req.t.id, req.user.id, 'joined', null, now());
    return { ok: true };
  });

  app.post('/api/tournaments/:id/leave', { preHandler: [auth, withT(['open', 'proposed'])] }, async (req) => {
    setPlayer.run(req.t.id, req.user.id, 'declined', null, now());
    return { ok: true };
  });

  app.post('/api/tournaments/:id/invite', { preHandler: [auth, withT(['proposed', 'open'])] }, async (req, reply) => {
    if (!isOrganiser(req.t, req.user)) return fail(reply, 403, 'Only the organiser can invite players.');
    const existing = new Set(players(req.t.id).filter((p) => p.status !== 'declined').map((p) => p.user_id));
    const ids = validUserIds(req.body?.userIds).filter((id) => !existing.has(id));
    for (const uid of ids) setPlayer.run(req.t.id, uid, 'invited', req.user.id, now());
    return { invited: ids.length };
  });

  // ---------- format ----------
  // Before the start: change the best-of per stage. After the start: change one round, as long as it has no results yet.
  app.post('/api/tournaments/:id/format', { preHandler: [auth, withT(['proposed', 'open', 'live'])] }, async (req, reply) => {
    if (!isOrganiser(req.t, req.user)) return fail(reply, 403, 'Only the organiser can change the format.');
    if (req.t.status !== 'live') {
      const stages = rules.cleanStages(req.body?.stages);
      if (!stages) return fail(reply, 400, 'Each stage must be best of 3, 5 or 7.');
      db.prepare('UPDATE tournaments SET stage_best_of = ? WHERE id = ?').run(JSON.stringify(stages), req.t.id);
      return { ok: true };
    }
    const r = Number(req.body?.round), bestOf = Number(req.body?.bestOf);
    const rounds = JSON.parse(req.t.bracket), perRound = JSON.parse(req.t.round_best_of);
    if (!rounds[r]) return fail(reply, 400, 'Unknown round.');
    if (!rules.BEST_OF.includes(bestOf)) return fail(reply, 400, 'Best of 3, 5 or 7 only.');
    if (rounds[r].some((m) => m.w && !m.bye)) return fail(reply, 409, 'This round already has results, so its format is fixed.');
    perRound[r] = bestOf;
    db.prepare('UPDATE tournaments SET round_best_of = ? WHERE id = ?').run(JSON.stringify(perRound), req.t.id);
    return { ok: true };
  });

  // ---------- start, cancel, results ----------
  app.post('/api/tournaments/:id/start', { preHandler: [auth, withT(['open'])] }, async (req, reply) => {
    if (!isOrganiser(req.t, req.user)) return fail(reply, 403, 'Only the organiser can start the tournament.');
    const ids = players(req.t.id).filter((p) => p.status === 'joined').map((p) => p.user_id);
    if (ids.length < 3) return fail(reply, 409, 'At least 3 players need to have joined.');
    const st = standings();
    const seeds = ids.sort((x, y) => st.players.get(y).r - st.players.get(x).r);
    const rounds = rules.buildBracket(seeds);
    const perRound = rules.roundBestOf(rounds.length, JSON.parse(req.t.stage_best_of));
    db.prepare(`UPDATE tournaments SET status = 'live', seeds = ?, bracket = ?, round_best_of = ? WHERE id = ?`)
      .run(JSON.stringify(seeds), JSON.stringify(rounds), JSON.stringify(perRound), req.t.id);
    return { ok: true };
  });

  app.post('/api/tournaments/:id/cancel', { preHandler: [auth, withT(['proposed', 'open', 'live'])] }, async (req, reply) => {
    if (!isOrganiser(req.t, req.user)) return fail(reply, 403, 'Only the organiser can cancel the tournament.');
    db.prepare(`UPDATE tournaments SET status = 'cancelled' WHERE id = ?`).run(req.t.id);
    return { ok: true };
  });

  app.post('/api/tournaments/:id/results', { preHandler: [auth, withT(['live'])] }, async (req, reply) => {
    const t = req.t, rounds = JSON.parse(t.bracket), perRound = JSON.parse(t.round_best_of);
    const r = Number(req.body?.round), k = Number(req.body?.slot), sets = req.body?.sets;
    const bm = rounds[r]?.[k];
    if (!bm) return fail(reply, 400, 'Unknown bracket match.');
    if (!bm.a || !bm.b) return fail(reply, 409, 'Both players are not known yet.');
    if (bm.w) return fail(reply, 409, 'This result is already in.');
    if (![bm.a, bm.b].includes(req.user.id) && !isOrganiser(t, req.user)) return fail(reply, 403, 'Only the two players or the organiser can enter this result.');
    const bestOf = perRound[r];
    const err = rules.checkMatch(sets, bestOf);
    if (err) return fail(reply, 400, err);
    const [a, b] = rules.tally(sets), winner = a > b ? bm.a : bm.b, ts = now();
    tx(() => {
      const mid = Number(db.prepare(`INSERT INTO matches (reporter_id, opponent_id, best_of, sets, winner_id, status, created_at, confirmed_at, tournament_id)
                                     VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`).run(bm.a, bm.b, bestOf, JSON.stringify(sets), winner, ts, ts, t.id).lastInsertRowid);
      bm.w = winner; bm.matchId = mid;
      rules.advance(rounds, r, k);
      const done = rules.isFinished(rounds);
      db.prepare('UPDATE tournaments SET bracket = ?, status = ?, finished_at = ? WHERE id = ?').run(JSON.stringify(rounds), done ? 'done' : 'live', done ? ts : null, t.id);
    });
    invalidate();
    return { ok: true, finished: rules.isFinished(rounds), winner };
  });
};
