const path = require('node:path');
const crypto = require('node:crypto');
const Fastify = require('fastify');
const { compute, COALITION_POINTS, LENGTH_WEIGHT } = require('./standings');
const matchups = require('./matchups');
const { assignMissing } = require('./coalitions');
const { ensureSeason, currentSeason, seasonRoutes } = require('./routes/seasons');

const SESSION_DAYS = 30;
const FT = 'https://api.intra.42.fr';

function buildApp(config, db) {
  const app = Fastify({ logger: config.logger ?? { level: config.logLevel }, trustProxy: true });
  const SID = config.cookieName, STATE = `${config.cookieName}_state`;
  app.register(require('@fastify/cookie'), { secret: config.cookieSecret });
  app.register(require('@fastify/static'), { root: path.join(__dirname, '..', 'public') });

  ensureSeason(db, config);
  const secure = config.baseUrl.startsWith('https://');
  const now = () => Date.now();
  const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const fail = (reply, code, message) => reply.code(code).send({ error: message });

  // ---------- standings cache ----------
  let cache = null;
  const invalidate = () => { cache = null; };
  function autoConfirm() {
    const ms = config.autoConfirmHours * 3600e3;
    const r = db.prepare(`UPDATE matches SET status = 'confirmed', confirmed_at = COALESCE(issued_at, created_at) + ?
                          WHERE status = 'pending' AND COALESCE(issued_at, created_at) + ? <= ?`).run(ms, ms, now());
    if (r.changes) invalidate();
  }
  function standings() {
    autoConfirm();
    if (!cache) cache = compute(db, currentSeason(db).starts_at, config.coalitions);
    // Weekly challenger draw and bonus rounds. Cheap when there's nothing to do.
    if (config.matchupsEnabled && matchups.tick(db, new Map([...cache.players.values()].map((p) => [p.id, p.r])))) cache = compute(db, currentSeason(db).starts_at, config.coalitions);
    return cache;
  }
  const timer = setInterval(autoConfirm, 5 * 60e3);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));

  // ---------- sessions ----------
  function startSession(reply, userId) {
    const id = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, now() + SESSION_DAYS * 864e5);
    reply.setCookie(SID, id, { path: '/', httpOnly: true, sameSite: 'lax', secure, signed: true, maxAge: SESSION_DAYS * 86400 });
  }
  function currentUser(req) {
    const raw = req.cookies[SID];
    if (!raw) return null;
    const { valid, value } = req.unsignCookie(raw);
    if (!valid) return null;
    return db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                       WHERE s.id = ? AND s.expires_at > ?`).get(value, now()) ?? null;
  }

  // Basic CSRF protection: state-changing requests must come from our own origin.
  const ownOrigin = new URL(config.baseUrl).origin;
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'POST' && req.headers.origin && req.headers.origin !== ownOrigin) return fail(reply, 403, 'Cross-site request blocked.');
  });

  const auth = async (req, reply) => {
    req.user = currentUser(req);
    if (!req.user) return fail(reply, 401, 'Sign in first.');
  };

  const ctx = { db, config, now, tx, fail, auth, standings, invalidate };

  // ---------- auth: 42 intra ----------
  app.get('/auth/42', async (req, reply) => {
    if (config.authMode !== '42') return fail(reply, 404, '42 sign-in is not configured.');
    const state = crypto.randomBytes(16).toString('hex');
    reply.setCookie(STATE, state, { path: '/auth', httpOnly: true, sameSite: 'lax', secure, maxAge: 600 });
    const q = new URLSearchParams({ client_id: config.ftClientId, redirect_uri: `${config.baseUrl}/auth/42/callback`, response_type: 'code', scope: 'public', state });
    return reply.redirect(`${FT}/oauth/authorize?${q}`);
  });

  app.get('/auth/42/callback', async (req, reply) => {
    if (config.authMode !== '42') return fail(reply, 404, '42 sign-in is not configured.');
    const { code, state } = req.query;
    if (!code || !state || state !== req.cookies[STATE]) return reply.redirect('/?login=failed');
    reply.clearCookie(STATE, { path: '/auth' });
    try {
      const tokenRes = await fetch(`${FT}/oauth/token`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'authorization_code', client_id: config.ftClientId, client_secret: config.ftClientSecret, code, redirect_uri: `${config.baseUrl}/auth/42/callback`, state }),
      });
      if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
      const { access_token } = await tokenRes.json();
      const get = async (p) => { const r = await fetch(`${FT}${p}`, { headers: { authorization: `Bearer ${access_token}` } }); if (!r.ok) throw new Error(`${p} failed: ${r.status}`); return r.json(); };
      const me = await get('/v2/me');
      const campusList = (me.campus || []).map((c) => `${c.name} (${c.id})`).join(', ') || 'none';
      console.log(`42 sign-in: ${me.login}, campus: ${campusList}`);
      if (config.allowedCampusIds.length) {
        const campuses = (me.campus || []).map((c) => c.id);
        if (!campuses.some((id) => config.allowedCampusIds.includes(id))) return reply.redirect('/?login=campus');
      }
      // Coalition (Vela, Pyxis, Cetus…). A failure here should not block sign-in.
      let coalition = null, color = null;
      try {
        const list = await get(`/v2/users/${me.id}/coalitions`);
        const known = list.find((c) => config.coalitions.some((n) => n.toLowerCase() === String(c.name).toLowerCase())) || list[0];
        if (known) { coalition = known.name; color = known.color || null; }
      } catch (e) { req.log.warn(e, 'could not load coalition'); }

      const name = me.usual_full_name || me.displayname || me.login;
      const image = me.image?.versions?.small || me.image?.link || null;
      const isAdmin = config.adminLogins.includes(me.login) ? 1 : 0;
      const existing = db.prepare('SELECT id FROM users WHERE intra_id = ?').get(me.id);
      let userId;
      if (existing) {
        db.prepare('UPDATE users SET login = ?, name = ?, image_url = ?, coalition = ?, coalition_color = ?, is_admin = MAX(is_admin, ?) WHERE id = ?')
          .run(me.login, name, image, coalition, color, isAdmin, existing.id);
        userId = existing.id;
      } else {
        userId = Number(db.prepare('INSERT INTO users (intra_id, login, name, image_url, coalition, coalition_color, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(me.id, me.login, name, image, coalition, color, isAdmin, now()).lastInsertRowid);
      }
      if (!coalition) assignMissing(db, config.coalitions);
      invalidate();
      startSession(reply, userId);
      return reply.redirect('/');
    } catch (err) {
      req.log.error(err);
      return reply.redirect('/?login=failed');
    }
  });

  // ---------- auth: dev mode (no 42 credentials needed) ----------
  app.get('/api/dev-users', async (req, reply) => {
    if (config.authMode !== 'dev') return fail(reply, 404, 'Not available.');
    return db.prepare('SELECT id, login, name, is_admin AS isAdmin FROM users ORDER BY is_admin DESC, name').all();
  });
  app.post('/auth/dev-login', async (req, reply) => {
    if (config.authMode !== 'dev') return fail(reply, 404, 'Not available.');
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(req.body?.userId));
    if (!user) return fail(reply, 400, 'Unknown user.');
    startSession(reply, user.id);
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    const raw = req.cookies[SID];
    if (raw) { const { valid, value } = req.unsignCookie(raw); if (valid) db.prepare('DELETE FROM sessions WHERE id = ?').run(value); }
    reply.clearCookie(SID, { path: '/' });
    return { ok: true };
  });

  app.get('/api/config', async () => ({ authMode: config.authMode, appEnv: config.appEnv }));

  // ---------- state: everything the page needs in one call ----------
  app.get('/api/state', { preHandler: auth }, async (req) => {
    const st = standings(), me = req.user, isAdmin = !!me.is_admin;
    const rows = db.prepare(`SELECT * FROM matches WHERE status = 'confirmed'
                             OR (status IN ('pending','disputed') AND (reporter_id = ? OR opponent_id = ?))`).all(me.id, me.id);
    const matches = rows.map((m) => {
      const x = st.meta.get(m.id) || {};
      return { id: m.id, a: m.reporter_id, b: m.opponent_id, bo: m.best_of, sets: JSON.parse(m.sets), w: m.winner_id, status: m.status,
        t: m.created_at, created: m.created_at, issued: m.issued_at || m.created_at,
        disputeReason: m.dispute_reason || '', disputedAt: m.disputed_at, edits: m.edits || 0, tourn: m.tournament_id, before: x.before, delta: x.delta, pts: x.pts, upset: !!x.upset, coalPts: x.coalPts || 0, coalition: x.coalition || null, matchup: m.matchup_id || null };
    });
    const setsById = new Map(rows.map((m) => [m.id, JSON.parse(m.sets)]));

    const people = new Map();
    for (const p of db.prepare('SELECT tournament_id, user_id, status, invited_by FROM tournament_players').all()) {
      if (!people.has(p.tournament_id)) people.set(p.tournament_id, []);
      people.get(p.tournament_id).push({ id: p.user_id, status: p.status, invitedBy: p.invited_by });
    }
    const tournaments = db.prepare(`SELECT * FROM tournaments WHERE status IN ('open','live','done')
                                    OR (status = 'proposed' AND (created_by = ? OR ?))
                                    OR (status = 'rejected' AND created_by = ?)
                                    ORDER BY starts_at`).all(me.id, isAdmin ? 1 : 0, me.id).map((t) => {
      const rounds = JSON.parse(t.bracket);
      for (const rd of rounds) for (const bm of rd) if (bm.matchId) bm.sets = setsById.get(bm.matchId);
      return { id: t.id, name: t.name, description: t.description, location: t.location, startsAt: t.starts_at, status: t.status,
        createdBy: t.created_by, created: t.created_at, maxPlayers: t.max_players, signupOpen: !!t.signup_open,
        stages: JSON.parse(t.stage_best_of || 'null'), roundBestOf: JSON.parse(t.round_best_of || '[]'),
        seeds: JSON.parse(t.seeds), rounds, players: people.get(t.id) || [],
        champion: t.status === 'done' ? rounds[rounds.length - 1][0].w : null, awards: st.awards.get(t.id) || [] };
    });

    const challenges = db.prepare(`SELECT * FROM challenges WHERE status IN ('open','accepted') AND (from_id = ? OR to_id = ?) ORDER BY created_at DESC`)
      .all(me.id, me.id).map((c) => ({ id: c.id, from: c.from_id, to: c.to_id, bo: c.best_of, message: c.message, status: c.status, created: c.created_at }));

    const coal = new Map(db.prepare('SELECT id, coalition FROM users').all().map((u) => [u.id, u.coalition]));
    const players = [...st.players.values()].map((p) => ({ ...p, coalition: coal.get(p.id) || null }));

    const cur = currentSeason(db);
    const seasons = db.prepare('SELECT * FROM seasons WHERE ends_at IS NOT NULL ORDER BY starts_at DESC').all()
      .map((s) => ({ id: s.id, name: s.name, startsAt: s.starts_at, endsAt: s.ends_at, prize: s.prize, results: JSON.parse(s.results || 'null') }));
    return { me: me.id, isAdmin, authMode: config.authMode, appEnv: config.appEnv, season: cur.name, seasonStart: cur.starts_at,
      currentSeason: { id: cur.id, name: cur.name, startsAt: cur.starts_at, plannedEnd: cur.planned_end, prize: cur.prize }, seasons,
      autoConfirmHours: config.autoConfirmHours, requireApproval: config.requireApproval, coalitions: st.coalitions, coalitionRules: COALITION_POINTS, lengthWeight: LENGTH_WEIGHT,
      players, matches, tournaments, challenges, ...matchupState(me) };
  });

  // ---------- challenger matchups ----------
  function matchupState(me) {
    const week = matchups.weekStart(now());
    const rows = db.prepare(`SELECT m.*, (SELECT x.id FROM matches x WHERE x.matchup_id = m.id AND x.status = 'confirmed' LIMIT 1) AS done_match,
                             (SELECT x.id FROM matches x WHERE x.matchup_id = m.id AND x.status = 'pending' LIMIT 1) AS pending_match
                             FROM matchups m WHERE m.created_at >= ? ORDER BY m.created_at`).all(week);
    const list = rows.map((m) => ({ id: m.id, kind: m.kind, a: m.a_id, b: m.b_id, expiresAt: m.expires_at,
      status: m.done_match ? 'done' : m.pending_match ? 'pending' : m.expires_at <= now() ? 'expired' : 'open', matchId: m.done_match || m.pending_match || null }));
    return { matchups: list, matchupRules: matchups.MATCHUPS, matchupsOptOut: !!me.matchups_opt_out, nextDraw: week + 7 * 864e5 };
  }
  app.post('/api/me/matchups', { preHandler: auth }, async (req) => {
    db.prepare('UPDATE users SET matchups_opt_out = ? WHERE id = ?').run(req.body?.enabled === false ? 1 : 0, req.user.id);
    return { ok: true };
  });

  require('./routes/matches')(app, ctx);
  require('./routes/tournaments')(app, ctx);
  seasonRoutes(app, ctx);
  return app;
}

module.exports = { buildApp };
