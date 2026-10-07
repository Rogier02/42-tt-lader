const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../server/db');
const { buildApp } = require('../server/app');
const { loadConfig } = require('../server/config');

async function setup() {
  const db = open(':memory:');
  const ins = db.prepare('INSERT INTO users (login, name, created_at) VALUES (?, ?, 0)');
  for (const l of ['alice', 'bob', 'carol', 'dave']) ins.run(l, l[0].toUpperCase() + l.slice(1));
  const app = buildApp({ ...loadConfig({}), logger: false }, db);
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
