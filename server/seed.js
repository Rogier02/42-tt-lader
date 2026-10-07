// Demo data for dev mode only. Never runs when 42 sign-in is configured.
const rules = require('./rules');
const { compute } = require('./standings');

const NAMES = [['Sanne de Vries','sdevries'],['Mehmet Yilmaz','myilmaz'],['Lotte Bakker','lbakker'],['Daan Visser','dvisser'],
  ['Priya Raman','praman'],['Jonas Kuipers','jkuipers'],['Fatima El Amrani','felamran'],['Tom Hendriks','thendrik'],
  ['Wei Chen','wchen'],['Noor Jansen','njansen'],['Lucas Smit','lsmit'],['Eva Mulder','emulder'],['Bram de Boer','bdeboer'],['Iris Peters','ipeters']];

function rng(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function simSets(sa, sb, bo, R) {
  const need = Math.ceil(bo / 2), pa = 1 / (1 + Math.exp(-(sa - sb) * 3)), out = [];
  let wa = 0, wb = 0;
  while (wa < need && wb < need) {
    const aw = R() < pa; let hi, lo;
    if (R() < 0.15) { const k = Math.floor(R() * 3); hi = 12 + k; lo = 10 + k; } else { hi = 11; lo = 2 + Math.floor(R() * 8); }
    out.push(aw ? [hi, lo] : [lo, hi]); aw ? wa++ : wb++;
  }
  return out;
}

function seedDemo(db) {
  const R = rng(42), now = Date.now(), DAY = 864e5, strength = new Map();
  const insUser = db.prepare('INSERT INTO users (login, name, created_at) VALUES (?, ?, ?)');
  const insMatch = db.prepare(`INSERT INTO matches (reporter_id, opponent_id, best_of, sets, winner_id, status, created_at, confirmed_at, tournament_id)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const ids = NAMES.map(([name, login]) => { const id = Number(insUser.run(login, name, now - 40 * DAY).lastInsertRowid); strength.set(id, R()); return id; });
  const add = (a, b, bo, sets, status, t, tid = null) => {
    const [x, y] = rules.tally(sets);
    return Number(insMatch.run(a, b, bo, JSON.stringify(sets), x > y ? a : b, status, t, status === 'confirmed' ? t : null, tid).lastInsertRowid);
  };

  const N = 72;
  for (let i = 0; i < N; i++) {
    const a = ids[Math.floor(R() * ids.length)]; let b; do { b = ids[Math.floor(R() * ids.length)]; } while (b === a);
    const bo = R() < 0.7 ? 5 : 3;
    add(a, b, bo, simSets(strength.get(a), strength.get(b), bo, R), 'confirmed', Math.round(now - (35 - (i * 31) / N) * DAY));
  }

  // A knockout that is still running: quarterfinals done, one semifinal played.
  const st = compute(db, 0);
  const seeds = [...ids].sort((x, y) => strength.get(y) - strength.get(x)).slice(0, 7).sort((x, y) => st.players.get(y).r - st.players.get(x).r);
  const rounds = rules.buildBracket(seeds), t0 = now - 2 * DAY;
  const tid = Number(db.prepare('INSERT INTO tournaments (name, created_by, created_at, best_of, seeds, bracket) VALUES (?, ?, ?, 3, ?, ?)')
    .run('Friday Night Knockout', seeds[0], t0, JSON.stringify(seeds), JSON.stringify(rounds)).lastInsertRowid);
  let h = 0;
  const play = (r, k) => {
    const bm = rounds[r][k], sets = simSets(strength.get(bm.a), strength.get(bm.b), 3, R);
    bm.matchId = add(bm.a, bm.b, 3, sets, 'confirmed', t0 + (h++) * 36e5, tid);
    const [x, y] = rules.tally(sets); bm.w = x > y ? bm.a : bm.b; rules.advance(rounds, r, k);
  };
  rounds[0].forEach((bm, k) => { if (!bm.bye) play(0, k); });
  play(1, 0);
  db.prepare('UPDATE tournaments SET bracket = ? WHERE id = ?').run(JSON.stringify(rounds), tid);

  // Every player has one result waiting for them and one waiting on someone else.
  ids.forEach((id, i) => {
    const from = ids[(i + 1) % ids.length];
    add(from, id, 5, simSets(0.5, 0.5, 5, R), 'pending', now - (2 + i) * 36e5);
  });
}

module.exports = { seedDemo };
