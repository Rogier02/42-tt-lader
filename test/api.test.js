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

test('tournament runs to a champion and awards points', async () => {
  const { login, call } = await setup();
  const alice = await login(1), dave = await login(4);
  const t = await call(alice, 'POST', '/api/tournaments', { name: 'Test Cup', playerIds: [1, 2, 3] });
  assert.equal(t.code, 200);
  let st = (await call(alice, 'GET', '/api/state')).body;
  let rounds = st.tournaments[0].rounds;
  const semi = rounds[0].findIndex((m) => !m.bye);
  assert.equal((await call(dave, 'POST', `/api/tournaments/${t.body.id}/results`, { round: 0, slot: semi, sets: [[11, 3], [11, 3]] })).code, 403);
  assert.equal((await call(alice, 'POST', `/api/tournaments/${t.body.id}/results`, { round: 0, slot: semi, sets: [[11, 3], [11, 3]] })).code, 200);
  const fin = await call(alice, 'POST', `/api/tournaments/${t.body.id}/results`, { round: 1, slot: 0, sets: [[11, 3], [8, 11], [11, 9]] });
  assert.equal(fin.body.finished, true);
  st = (await call(alice, 'GET', '/api/state')).body;
  const tour = st.tournaments[0];
  assert.equal(tour.status, 'done');
  assert.equal(tour.awards.find((x) => x.why === 'Champion').id, tour.champion);
});

test('cross-site POSTs are blocked', async () => {
  const { app, login } = await setup();
  const alice = await login(1);
  const r = await app.inject({ method: 'POST', url: '/api/matches', payload: {}, headers: { cookie: alice, origin: 'https://evil.example' } });
  assert.equal(r.statusCode, 403);
});
