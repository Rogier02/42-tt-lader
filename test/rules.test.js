const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../server/rules');

test('valid table tennis sets', () => {
  assert.ok(rules.validSet(11, 9));
  assert.ok(rules.validSet(12, 10));
  assert.ok(rules.validSet(9, 11));
  assert.ok(!rules.validSet(11, 10));
  assert.ok(!rules.validSet(13, 10));
  assert.ok(!rules.validSet(10, 8));
});

test('match must be complete with no extra sets', () => {
  assert.equal(rules.checkMatch([[11, 5], [11, 7]], 3), null);
  assert.match(rules.checkMatch([[11, 5]], 3), /not finished/);
  assert.match(rules.checkMatch([[11, 5], [11, 7], [11, 3]], 3), /Extra sets/);
  assert.match(rules.checkMatch([[11, 10], [11, 7]], 3), /isn't a valid set/);
});

test('glicko: winner gains, loser drops, upsets move more', () => {
  const a = { r: 1500, rd: 100, vol: 0.06 }, b = { r: 1500, rd: 100, vol: 0.06 };
  assert.ok(rules.glicko(a, b, 1).r > 1500);
  assert.ok(rules.glicko(a, b, 0).r < 1500);
  const strong = { r: 1800, rd: 80, vol: 0.06 };
  const upset = rules.glicko(a, strong, 1).r - 1500, expectedWin = rules.glicko(strong, a, 1).r - 1800;
  assert.ok(upset > expectedWin);
});

test('bracket: 7 players, top seed gets the bye, seeds 1 and 2 on opposite halves', () => {
  const rounds = rules.buildBracket([1, 2, 3, 4, 5, 6, 7]);
  assert.equal(rounds.length, 3);
  assert.deepEqual(rounds[0][0], { a: 1, b: null, w: 1, bye: true, matchId: null });
  assert.equal(rounds[1][0].a, 1);
  const top = rounds[0].slice(0, 2).flatMap((m) => [m.a, m.b]);
  assert.ok(top.includes(1) && !top.includes(2));
});

test('coalition points: upset tiers and diminishing returns per pair', () => {
  const { coalitionWinPoints: pts } = require('../server/standings');
  assert.equal(pts(0, 1), 3);
  assert.equal(pts(-200, 1), 3, 'beating a weaker player is a normal win');
  assert.equal(pts(50, 1), 5);
  assert.equal(pts(99, 3), 5);
  assert.equal(pts(100, 1), 9);
  assert.equal(pts(300, 4), 1, 'after 3 matches vs the same player in a week, any win scores 1');
});

test('longer matches move ratings more', async () => {
  const { open } = require('../server/db');
  const { compute } = require('../server/standings');
  const gain = (bo, sets) => {
    const db = open(':memory:');
    db.prepare("INSERT INTO users (login, name, created_at) VALUES ('a','A',0),('b','B',0)").run();
    db.prepare(`INSERT INTO matches (reporter_id, opponent_id, best_of, sets, winner_id, status, created_at, confirmed_at) VALUES (1, 2, ?, ?, 1, 'confirmed', 1, 1)`).run(bo, JSON.stringify(sets));
    const m = [...compute(db, 0).meta.values()][0];
    assert.equal(m.before[1], 1500);
    return m.delta[1];
  };
  const g3 = gain(3, [[11, 5], [11, 5]]), g5 = gain(5, [[11, 5], [11, 5], [11, 5]]), g7 = gain(7, [[11, 5], [11, 5], [11, 5], [11, 5]]);
  assert.ok(g3 < g5 && g5 < g7, `${g3} < ${g5} < ${g7}`);
  assert.ok(Math.abs(g7 / g5 - 1.25) < 1e-9 && Math.abs(g3 / g5 - 0.75) < 1e-9);
});
