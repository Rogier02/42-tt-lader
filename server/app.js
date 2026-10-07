const path = require('node:path');
const crypto = require('node:crypto');
const Fastify = require('fastify');
const rules = require('./rules');
const { compute } = require('./standings');

const SESSION_DAYS = 30;
const FT = 'https://api.intra.42.fr';

function buildApp(config, db) {
  const app = Fastify({ logger: config.logger ?? true, trustProxy: true });
  app.register(require('@fastify/cookie'), { secret: config.cookieSecret });
  app.register(require('@fastify/static'), { root: path.join(__dirname, '..', 'public') });

  const secure = config.baseUrl.startsWith('https://');
  const now = () => Date.now();
  const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const fail = (reply, code, message) => reply.code(code).send({ error: message });

  // ---------- standings cache ----------
  let cache = null;
  const invalidate = () => { cache = null; };
  function standings() {
    autoConfirm();
    if (!cache) cache = compute(db, config.seasonStart);
    return cache;
  }
  function autoConfirm() {
    const ms = config.autoConfirmHours * 3600e3;
    const r = db.prepare(`UPDATE matches SET status = 'confirmed', confirmed_at = created_at + ?
                          WHERE status = 'pending' AND created_at + ? <= ?`).run(ms, ms, now());
    if (r.changes) invalidate();
  }
  const timer = setInterval(autoConfirm, 5 * 60e3);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));

  // ---------- sessions ----------
  function startSession(reply, userId) {
    const id = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, now() + SESSION_DAYS * 864e5);
    reply.setCookie('sid', id, { path: '/', httpOnly: true, sameSite: 'lax', secure, signed: true, maxAge: SESSION_DAYS * 86400 });
  }
  function currentUser(req) {
    const raw = req.cookies.sid;
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

  // ---------- auth: 42 intra ----------
  app.get('/auth/42', async (req, reply) => {
    if (config.authMode !== '42') return fail(reply, 404, '42 sign-in is not configured.');
    const state = crypto.randomBytes(16).toString('hex');
    reply.setCookie('oauth_state', state, { path: '/auth', httpOnly: true, sameSite: 'lax', secure, maxAge: 600 });
    const q = new URLSearchParams({ client_id: config.ftClientId, redirect_uri: `${config.baseUrl}/auth/42/callback`, response_type: 'code', scope: 'public', state });
    return reply.redirect(`${FT}/oauth/authorize?${q}`);
  });

  app.get('/auth/42/callback', async (req, reply) => {
    if (config.authMode !== '42') return fail(reply, 404, '42 sign-in is not configured.');
    const { code, state } = req.query;
    if (!code || !state || state !== req.cookies.oauth_state) return reply.redirect('/?login=failed');
    reply.clearCookie('oauth_state', { path: '/auth' });
    try {
      const tokenRes = await fetch(`${FT}/oauth/token`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'authorization_code', client_id: config.ftClientId, client_secret: config.ftClientSecret, code, redirect_uri: `${config.baseUrl}/auth/42/callback`, state }),
      });
      if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
      const { access_token } = await tokenRes.json();
      const meRes = await fetch(`${FT}/v2/me`, { headers: { authorization: `Bearer ${access_token}` } });
      if (!meRes.ok) throw new Error(`profile fetch failed: ${meRes.status}`);
      const me = await meRes.json();
      if (config.allowedCampusIds.length) {
        const campuses = (me.campus || []).map((c) => c.id);
        if (!campuses.some((id) => config.allowedCampusIds.includes(id))) return reply.redirect('/?login=campus');
      }
      const name = me.usual_full_name || me.displayname || me.login;
      const image = me.image?.versions?.small || me.image?.link || null;
      const existing = db.prepare('SELECT id FROM users WHERE intra_id = ?').get(me.id);
      let userId;
      if (existing) {
        db.prepare('UPDATE users SET login = ?, name = ?, image_url = ? WHERE id = ?').run(me.login, name, image, existing.id);
        userId = existing.id;
      } else {
        userId = Number(db.prepare('INSERT INTO users (intra_id, login, name, image_url, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(me.id, me.login, name, image, config.adminLogins.includes(me.login) ? 1 : 0, now()).lastInsertRowid);
      }
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
    return db.prepare('SELECT id, login, name FROM users ORDER BY name').all();
  });
  app.post('/auth/dev-login', async (req, reply) => {
    if (config.authMode !== 'dev') return fail(reply, 404, 'Not available.');
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(req.body?.userId));
    if (!user) return fail(reply, 400, 'Unknown user.');
    startSession(reply, user.id);
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    const raw = req.cookies.sid;
    if (raw) { const { valid, value } = req.unsignCookie(raw); if (valid) db.prepare('DELETE FROM sessions WHERE id = ?').run(value); }
    reply.clearCookie('sid', { path: '/' });
    return { ok: true };
  });

  app.get('/api/config', async () => ({ authMode: config.authMode, season: config.seasonName }));

  // ---------- state ----------
  app.get('/api/state', { preHandler: auth }, async (req) => {
    const st = standings(), me = req.user.id;
    const rows = db.prepare(`SELECT * FROM matches WHERE status = 'confirmed'
                             OR (status IN ('pending','disputed') AND (reporter_id = ? OR opponent_id = ?))`).all(me, me);
    const matches = rows.map((m) => {
      const x = st.meta.get(m.id) || {};
      return { id: m.id, a: m.reporter_id, b: m.opponent_id, bo: m.best_of, sets: JSON.parse(m.sets), w: m.winner_id, status: m.status,
        t: m.confirmed_at || m.created_at, created: m.created_at, tourn: m.tournament_id, delta: x.delta, pts: x.pts, upset: !!x.upset };
    });
    const setsById = new Map(rows.map((m) => [m.id, JSON.parse(m.sets)]));
    const tournaments = db.prepare('SELECT * FROM tournaments ORDER BY created_at DESC').all().map((t) => {
      const rounds = JSON.parse(t.bracket);
      for (const rd of rounds) for (const bm of rd) if (bm.matchId) bm.sets = setsById.get(bm.matchId);
      return { id: t.id, name: t.name, seeds: JSON.parse(t.seeds), rounds, bo: t.best_of, created: t.created_at, createdBy: t.created_by,
        status: t.finished_at ? 'done' : 'live', champion: t.finished_at ? rounds[rounds.length - 1][0].w : null, awards: st.awards.get(t.id) || [] };
    });
    return { me, isAdmin: !!req.user.is_admin, authMode: config.authMode, season: config.seasonName,
      autoConfirmHours: config.autoConfirmHours, players: [...st.players.values()], matches, tournaments };
  });

  // ---------- matches ----------
  app.post('/api/matches', { preHandler: auth }, async (req, reply) => {
    const { opponentId, bestOf, sets } = req.body || {};
    const opp = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(opponentId));
    if (!opp) return fail(reply, 400, 'Choose an opponent.');
    if (opp.id === req.user.id) return fail(reply, 400, "You can't play yourself.");
    const err = rules.checkMatch(sets, Number(bestOf));
    if (err) return fail(reply, 400, err);
    const [a, b] = rules.tally(sets);
    const winner = a > b ? req.user.id : opp.id;
    const id = Number(db.prepare(`INSERT INTO matches (reporter_id, opponent_id, best_of, sets, winner_id, status, created_at)
                                  VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(req.user.id, opp.id, Number(bestOf), JSON.stringify(sets), winner, now()).lastInsertRowid);
    return { id };
  });

  function changeStatus(req, reply, { from, to, who }) {
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(Number(req.params.id));
    if (!m) return fail(reply, 404, 'Match not found.');
    if (m.status !== from) return fail(reply, 409, `This result is already ${m.status}.`);
    if (m[who] !== req.user.id) return fail(reply, 403, 'This result is not yours to change.');
    db.prepare('UPDATE matches SET status = ?, confirmed_at = ? WHERE id = ?').run(to, to === 'confirmed' ? now() : null, m.id);
    invalidate();
    const st = standings();
    return { ok: true, delta: st.meta.get(m.id)?.delta?.[req.user.id] ?? null, pts: st.meta.get(m.id)?.pts?.[req.user.id] ?? null };
  }
  app.post('/api/matches/:id/confirm', { preHandler: auth }, async (req, reply) => changeStatus(req, reply, { from: 'pending', to: 'confirmed', who: 'opponent_id' }));
  app.post('/api/matches/:id/dispute', { preHandler: auth }, async (req, reply) => changeStatus(req, reply, { from: 'pending', to: 'disputed', who: 'opponent_id' }));
  app.post('/api/matches/:id/withdraw', { preHandler: auth }, async (req, reply) => changeStatus(req, reply, { from: 'pending', to: 'withdrawn', who: 'reporter_id' }));

  // ---------- tournaments ----------
  app.post('/api/tournaments', { preHandler: auth }, async (req, reply) => {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    const ids = [...new Set((req.body?.playerIds || []).map(Number))];
    if (!name) return fail(reply, 400, 'Give the tournament a name.');
    if (ids.length < 3 || ids.length > 64) return fail(reply, 400, 'Pick between 3 and 64 players.');
    const st = standings();
    if (ids.some((id) => !st.players.has(id))) return fail(reply, 400, 'Unknown player in the list.');
    const seeds = ids.sort((x, y) => st.players.get(y).r - st.players.get(x).r);
    const id = Number(db.prepare('INSERT INTO tournaments (name, created_by, created_at, best_of, seeds, bracket) VALUES (?, ?, ?, 3, ?, ?)')
      .run(name, req.user.id, now(), JSON.stringify(seeds), JSON.stringify(rules.buildBracket(seeds))).lastInsertRowid);
    return { id };
  });

  app.post('/api/tournaments/:id/results', { preHandler: auth }, async (req, reply) => {
    const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(Number(req.params.id));
    if (!t) return fail(reply, 404, 'Tournament not found.');
    const rounds = JSON.parse(t.bracket);
    const r = Number(req.body?.round), k = Number(req.body?.slot), sets = req.body?.sets;
    const bm = rounds[r]?.[k];
    if (!bm) return fail(reply, 400, 'Unknown bracket match.');
    if (!bm.a || !bm.b) return fail(reply, 409, 'Both players are not known yet.');
    if (bm.w) return fail(reply, 409, 'This result is already in.');
    const allowed = [bm.a, bm.b, t.created_by].includes(req.user.id) || req.user.is_admin;
    if (!allowed) return fail(reply, 403, 'Only the two players or the organiser can enter this result.');
    const err = rules.checkMatch(sets, t.best_of);
    if (err) return fail(reply, 400, err);
    const [a, b] = rules.tally(sets), winner = a > b ? bm.a : bm.b, ts = now();
    tx(() => {
      const mid = Number(db.prepare(`INSERT INTO matches (reporter_id, opponent_id, best_of, sets, winner_id, status, created_at, confirmed_at, tournament_id)
                                     VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`).run(bm.a, bm.b, t.best_of, JSON.stringify(sets), winner, ts, ts, t.id).lastInsertRowid);
      bm.w = winner; bm.matchId = mid;
      rules.advance(rounds, r, k);
      db.prepare('UPDATE tournaments SET bracket = ?, finished_at = ? WHERE id = ?').run(JSON.stringify(rounds), rules.isFinished(rounds) ? ts : null, t.id);
    });
    invalidate();
    return { ok: true, finished: rules.isFinished(rounds), winner };
  });

  return app;
}

module.exports = { buildApp };
