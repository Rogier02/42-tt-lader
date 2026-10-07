const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../server/db');
const { buildApp } = require('../server/app');
const { loadConfig } = require('../server/config');

async function setup(extra = {}) {
  const db = open(':memory:');
  const ins = db.prepare('INSERT INTO users (login, name, created_at) VALUES (?, ?, 0)');
  for (const l of ['alice', 'bob', 'carol', 'dave']) ins.run(l, l[0].toUpperCase() + l.slice(1));
  const app = buildApp({ ...loadConfig({}), logger: false, matchupsEnabled: false, ...extra }, db);
  const login = async (userId) => {
    const r = await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { userId } });
    return r.headers['set-cookie'].split(';')[0];
  };
  const call = (cookie, method, url, payload) => app.inject({ method, url, payload, headers: { cookie } }).then((r) => ({ code: r.statusCode, body: r.json() }));
  return { app, db, login, call };
}

test('log, confirm and rate a match', async () => {
  const { login, call } = await setup();
  const alice = await login(1), bob = await login(2);
  assert.equal((await call('', 'GET', '/api/state')).code, 401);
  const r = await call(alice, 'POST', '/api/matches', { opponentId: 2, bestOf: 3, sets: [[11, 7], [9, 11], [11, 6]] });
  assert.equal(r.code, 200);
  assert.equal((await call(alice, 'POST', `/api/matches/${r.body.id}/confirm`, {})).code, 403, 'reporter cannot confirm own result');
  const c = await call(bob, 'POST', `/api/matches/${r.body.id}/confirm`, {});
  assert.equal(c.code, 200);
  assert.ok(c.body.delta < 0, 'bob lost rating');
  const st = (await call(alice, 'GET', '/api/state')).body;
  const a = st.players.find((p) => p.id === 1);
  assert.equal(a.w, 1); assert.equal(a.pts, 3); assert.ok(a.r > 1500);
});

test('rejects invalid scores and self-play', async () => {
  const { login, call } = await setup();
  const alice = await login(1);
  assert.equal((await call(alice, 'POST', '/api/matches', { opponentId: 1, bestOf: 3, sets: [[11, 1], [11, 1]] })).code, 400);
  assert.equal((await call(alice, 'POST', '/api/matches', { opponentId: 2, bestOf: 3, sets: [[11, 10], [11, 1]] })).code, 400);
  assert.equal((await call(alice, 'POST', '/api/matches', { opponentId: 2, bestOf: 3, sets: [[11, 1]] })).code, 400);
});

test('pending results confirm themselves after the deadline', async () => {
  const { db, login, call } = await setup();
  const alice = await login(1);
  const r = await call(alice, 'POST', '/api/matches', { opponentId: 2, bestOf: 3, sets: [[11, 7], [11, 6]] });
  db.prepare('UPDATE matches SET created_at = created_at - ? WHERE id = ?').run(25 * 3600e3, r.body.id);
  const st = (await call(alice, 'GET', '/api/state')).body;
  assert.equal(st.matches.find((m) => m.id === r.body.id).status, 'confirmed');
});

async function tournamentSetup() {
  const env = await setup();
  env.db.prepare('UPDATE users SET is_admin = 1 WHERE id = 1').run();
  env.alice = await env.login(1); env.bob = await env.login(2); env.carol = await env.login(3); env.dave = await env.login(4);
  env.state = async (who = env.alice) => (await env.call(who, 'GET', '/api/state')).body;
  return env;
}
const soon = () => Date.now() + 86400e3;
const stages = { early: 3, qf: 3, sf: 5, final: 7 };

test('tournaments need admin approval, then run to a champion with per-round formats', async () => {
  const { call, alice, bob, carol, dave, state } = await tournamentSetup();
  const t = await call(bob, 'POST', '/api/tournaments', { name: 'Test Cup', startsAt: soon(), stages, playing: true, inviteIds: [3] });
  assert.equal(t.code, 200); assert.equal(t.body.status, 'proposed');
  assert.ok(!(await state(dave)).tournaments.some((x) => x.id === t.body.id), 'hidden from others until approved');
  assert.equal((await call(bob, 'POST', `/api/tournaments/${t.body.id}/approve`, {})).code, 403);
  assert.equal((await call(alice, 'POST', `/api/tournaments/${t.body.id}/approve`, {})).code, 200);

  assert.equal((await call(carol, 'POST', `/api/tournaments/${t.body.id}/join`, {})).code, 200, 'invited player accepts');
  assert.equal((await call(bob, 'POST', `/api/tournaments/${t.body.id}/start`, {})).code, 409, 'only 2 joined');
  assert.equal((await call(dave, 'POST', `/api/tournaments/${t.body.id}/join`, {})).code, 200, 'open sign-up');
  assert.equal((await call(dave, 'POST', `/api/tournaments/${t.body.id}/start`, {})).code, 403, 'only the organiser starts');
  assert.equal((await call(bob, 'POST', `/api/tournaments/${t.body.id}/start`, {})).code, 200);

  let tour = (await state()).tournaments.find((x) => x.id === t.body.id);
  assert.deepEqual(tour.roundBestOf, [5, 7], '3 players: semifinal round Bo5, final Bo7');
  const semi = tour.rounds[0].findIndex((m) => !m.bye);
  assert.equal((await call(bob, 'POST', `/api/tournaments/${t.body.id}/results`, { round: 0, slot: semi, sets: [[11, 3], [11, 3]] })).code, 400, 'Bo5 needs 3 sets');
  assert.equal((await call(bob, 'POST', `/api/tournaments/${t.body.id}/format`, { round: 1, bestOf: 5 })).code, 200, 'final not played yet');
  assert.equal((await call(bob, 'POST', `/api/tournaments/${t.body.id}/results`, { round: 0, slot: semi, sets: [[11, 3], [11, 3], [11, 3]] })).code, 200);
  assert.equal((await call(bob, 'POST', `/api/tournaments/${t.body.id}/format`, { round: 0, bestOf: 3 })).code, 409, 'played round is locked');
  const fin = await call(bob, 'POST', `/api/tournaments/${t.body.id}/results`, { round: 1, slot: 0, sets: [[11, 3], [8, 11], [11, 9], [11, 4]] });
  assert.equal(fin.body.finished, true);
  tour = (await state()).tournaments.find((x) => x.id === t.body.id);
  assert.equal(tour.status, 'done');
  assert.equal(tour.awards.find((x) => x.why === 'Champion').id, tour.champion);
});

test('invite-only tournaments and max players', async () => {
  const { call, alice, bob, carol, dave } = await tournamentSetup();
  const t = await call(alice, 'POST', '/api/tournaments', { name: 'Small', startsAt: soon(), stages, signupOpen: false, maxPlayers: 3, playing: true, inviteIds: [2, 3, 4] });
  assert.equal(t.body.status, 'open', 'admins publish directly');
  const id = t.body.id;
  const other = await call(alice, 'POST', '/api/tournaments', { name: 'Closed', startsAt: soon(), stages, signupOpen: false });
  assert.equal((await call(dave, 'POST', `/api/tournaments/${other.body.id}/join`, {})).code, 403, 'not invited');
  assert.equal((await call(bob, 'POST', `/api/tournaments/${id}/join`, {})).code, 200);
  assert.equal((await call(carol, 'POST', `/api/tournaments/${id}/join`, {})).code, 200);
  assert.equal((await call(dave, 'POST', `/api/tournaments/${id}/join`, {})).code, 409, 'full');
});

test('challenges: accept, then playing the match closes it; best of 7 allowed', async () => {
  const { call, alice, bob, state } = await tournamentSetup();
  const c = await call(alice, 'POST', '/api/challenges', { opponentId: 2, bestOf: 7, message: 'Lunch?' });
  assert.equal(c.code, 200);
  assert.equal((await call(alice, 'POST', '/api/challenges', { opponentId: 2, bestOf: 5 })).code, 409, 'one open challenge per pair');
  assert.equal((await call(alice, 'POST', `/api/challenges/${c.body.id}/accept`, {})).code, 403, 'only the challenged player accepts');
  assert.equal((await call(bob, 'POST', `/api/challenges/${c.body.id}/accept`, {})).code, 200);
  const m = await call(bob, 'POST', '/api/matches', { opponentId: 1, bestOf: 7, sets: [[11, 1], [11, 2], [11, 3], [5, 11], [11, 4]] });
  assert.equal(m.code, 200);
  assert.equal((await state()).challenges.length, 0, 'challenge marked as played');
});

test('cross-site POSTs are blocked', async () => {
  const { app, login } = await setup();
  const alice = await login(1);
  const r = await app.inject({ method: 'POST', url: '/api/matches', payload: {}, headers: { cookie: alice, origin: 'https://evil.example' } });
  assert.equal(r.statusCode, 403);
});

test('upgrades a version 1 database without losing tournaments', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ttl-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, intra_id INTEGER UNIQUE, login TEXT NOT NULL UNIQUE, name TEXT NOT NULL, image_url TEXT, is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE tournaments (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_by INTEGER NOT NULL, created_at INTEGER NOT NULL, best_of INTEGER NOT NULL DEFAULT 3, seeds TEXT NOT NULL, bracket TEXT NOT NULL, finished_at INTEGER);
    INSERT INTO users (login, name, created_at) VALUES ('a','A',0),('b','B',0),('c','C',0);
    INSERT INTO tournaments (name, created_by, created_at, seeds, bracket) VALUES ('Old Cup', 1, 0, '[1,2,3]', '[[{"a":1,"b":null,"w":1,"bye":true},{"a":2,"b":3,"w":null}],[{"a":1,"b":null,"w":null}]]');`);
  old.close();
  const db = open(file);
  const t = db.prepare('SELECT * FROM tournaments').get();
  assert.equal(t.status, 'live');
  assert.equal(t.round_best_of, '[3,3]');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tournament_players').get().n, 3);
});

test('coalition race: only cross-coalition wins score, with a weekly cap per pair', async () => {
  const { db, login, call } = await setup();
  db.prepare(`UPDATE users SET coalition = CASE id WHEN 1 THEN 'Vela' WHEN 2 THEN 'Cetus' WHEN 3 THEN 'Vela' ELSE 'Pyxis' END`).run();
  const alice = await login(1), bob = await login(2), carol = await login(3);
  const win = [[11, 1], [11, 2]];
  for (let i = 0; i < 4; i++) {
    const m = await call(alice, 'POST', '/api/matches', { opponentId: 2, bestOf: 3, sets: win });
    await call(bob, 'POST', `/api/matches/${m.body.id}/confirm`, {});
  }
  const m = await call(alice, 'POST', '/api/matches', { opponentId: 3, bestOf: 3, sets: win });
  await call(carol, 'POST', `/api/matches/${m.body.id}/confirm`, {});
  const st = (await call(alice, 'GET', '/api/state')).body;
  const vela = st.coalitions.find((c) => c.name === 'Vela'), cetus = st.coalitions.find((c) => c.name === 'Cetus');
  assert.equal(vela.points, 3 + 3 + 3 + 1, '4th win vs the same player in a week scores 1');
  assert.equal(vela.wins, 4); assert.equal(cetus.losses, 4); assert.equal(cetus.points, 0, 'losing costs nothing');
  assert.deepEqual(vela.vs.Cetus, { w: 4, l: 0 });
  assert.equal(vela.contributors[1], 10);
});

test('ending a season freezes the winner and resets season points', async () => {
  const { db, login, call } = await setup();
  db.prepare(`UPDATE users SET coalition = CASE id WHEN 1 THEN 'Vela' WHEN 2 THEN 'Cetus' ELSE 'Pyxis' END, is_admin = (id = 1)`).run();
  const alice = await login(1), bob = await login(2);
  const m = await call(alice, 'POST', '/api/matches', { opponentId: 2, bestOf: 3, sets: [[11, 1], [11, 2]] });
  await call(bob, 'POST', `/api/matches/${m.body.id}/confirm`, {});
  assert.equal((await call(bob, 'POST', '/api/seasons/end', { nextName: 'Next' })).code, 403, 'admins only');
  assert.equal((await call(alice, 'POST', '/api/seasons/current', { prize: 'Paddles' })).code, 200);
  const end = await call(alice, 'POST', '/api/seasons/end', { nextName: 'Winter 2027' });
  assert.equal(end.body.winner, 'Vela');
  const st = (await call(alice, 'GET', '/api/state')).body;
  assert.equal(st.season, 'Winter 2027');
  assert.equal(st.seasons[0].prize, 'Paddles');
  assert.equal(st.seasons[0].results.winner, 'Vela');
  assert.equal(st.seasons[0].results.mvp.id, 1);
  assert.equal(st.players.find((p) => p.id === 1).pts, 0, 'season points reset');
  assert.ok(st.players.find((p) => p.id === 1).r > 1500, 'rating carries over');
  assert.equal(st.coalitions.find((c) => c.name === 'Vela').points, 0);
});

test('tournament players each earn +1 for their coalition, plus placement points', async () => {
  const { db, login, call } = await setup();
  db.prepare(`UPDATE users SET coalition = CASE id WHEN 1 THEN 'Vela' WHEN 2 THEN 'Cetus' ELSE 'Pyxis' END, is_admin = (id = 1)`).run();
  const alice = await login(1);
  const t = await call(alice, 'POST', '/api/tournaments', { name: 'Cup', startsAt: Date.now() + 864e5, stages: { early: 3, qf: 3, sf: 3, final: 3 }, playing: true, inviteIds: [] });
  for (const id of [2, 3]) await call(await login(id), 'POST', `/api/tournaments/${t.body.id}/join`, {});
  await call(alice, 'POST', `/api/tournaments/${t.body.id}/start`, {});
  // Make the matches same-coalition-free scoring simple: only placement and participation points matter here.
  let tour = (await call(alice, 'GET', '/api/state')).body.tournaments[0];
  const semi = tour.rounds[0].findIndex((m) => !m.bye);
  await call(alice, 'POST', `/api/tournaments/${t.body.id}/results`, { round: 0, slot: semi, sets: [[11, 3], [11, 3]] });
  await call(alice, 'POST', `/api/tournaments/${t.body.id}/results`, { round: 1, slot: 0, sets: [[11, 3], [11, 3]] });
  const st = (await call(alice, 'GET', '/api/state')).body;
  tour = st.tournaments[0];
  const champ = st.players.find((p) => p.id === tour.champion).coalition;
  const c = st.coalitions.find((x) => x.name === champ);
  const matchPts = st.matches.filter((m) => m.tourn === tour.id && m.coalition === champ).reduce((s, m) => s + m.coalPts, 0);
  assert.equal(c.points, matchPts + 1 + 10, 'champion: match points + 1 for playing + 10 for winning');
  const total = st.coalitions.reduce((s, x) => s + x.points, 0) - st.matches.reduce((s, m) => s + m.coalPts, 0);
  assert.equal(total, 3 + 10 + 6 + 3, '3 players x 1, champion 10, runner-up 6, beaten semifinalist 3');
});

test('a challenger approaches: everyone gets a weekly matchup, it counts triple, finishers get a bonus round', async () => {
  const { db, login, call } = await setup({ matchupsEnabled: true });
  db.prepare(`UPDATE users SET coalition = CASE id WHEN 1 THEN 'Vela' WHEN 2 THEN 'Cetus' WHEN 3 THEN 'Pyxis' ELSE 'Vela' END`).run();
  const tokens = {}; for (const id of [1, 2, 3, 4]) tokens[id] = await login(id);
  let st = (await call(tokens[1], 'GET', '/api/state')).body;
  const weekly = st.matchups.filter((m) => m.kind === 'weekly');
  for (const id of [1, 2, 3, 4]) assert.ok(weekly.some((m) => m.a === id || m.b === id), `player ${id} has a challenger`);
  assert.equal((await call(tokens[1], 'GET', '/api/state')).body.matchups.length, weekly.length, 'draw happens once a week');

  // Play both weekly matchups; the reporter wins each.
  for (const m of weekly.slice(0, 2)) {
    const r = await call(tokens[m.a], 'POST', '/api/matches', { opponentId: m.b, bestOf: 3, sets: [[11, 5], [11, 5]] });
    assert.equal(r.body.challenger, true);
    await call(tokens[m.b], 'POST', `/api/matches/${r.body.id}/confirm`, {});
  }
  st = (await call(tokens[1], 'GET', '/api/state')).body;
  const done = st.matches.filter((m) => m.matchup);
  for (const m of done) {
    const loser = m.w === m.a ? m.b : m.a;
    assert.ok(m.pts[m.w] >= 9, 'winner: 3x season points');
    assert.equal(m.pts[loser], 3, 'loser: 3x the point for playing');
    if (m.coalPts) assert.ok(m.coalPts >= 9, 'coalition points tripled');
  }
  assert.ok(done.every((m) => st.players.find((p) => p.id === m.w).r < 1700), 'rating is not multiplied');
  const bonus = st.matchups.filter((m) => m.kind === 'bonus');
  assert.ok(bonus.length >= 1, 'players who finished get a bonus challenger');
});

test('pairing puts everyone in a pair, even with an odd number of players', () => {
  const { pair } = require('../server/matchups');
  const ids = [1, 2, 3, 4, 5], ratings = new Map(ids.map((id) => [id, 1500 + id * 40]));
  const pairs = pair(ids, ratings, new Map(), new Set());
  for (const id of ids) assert.ok(pairs.some((p) => p.includes(id)), `${id} paired`);
  assert.equal(pairs.length, 3);
});

test('pairing keeps players inside the rating band when it can', () => {
  const { pair, MATCHUPS } = require('../server/matchups');
  const ratings = new Map([[1, 1300], [2, 1350], [3, 1500], [4, 1520], [5, 1800], [6, 1850], [7, 1600], [8, 1650]]);
  for (let i = 0; i < 50; i++) {
    for (const [a, b] of pair([...ratings.keys()], ratings, new Map(), new Set()))
      assert.ok(Math.abs(ratings.get(a) - ratings.get(b)) <= MATCHUPS.ratingBand, `${a} vs ${b} outside the band`);
  }
});

test('bonus rounds never repeat a pair from the same week', () => {
  const { pair } = require('../server/matchups');
  const ratings = new Map([[1, 1500], [2, 1500]]);
  assert.deepEqual(pair([1, 2], ratings, new Map(), new Set(), Math.random, { forbid: new Set(['1-2']), everyone: false }), []);
});
