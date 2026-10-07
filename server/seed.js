// Demo data for dev mode only. Never runs when 42 sign-in is configured.
const rules = require('./rules');

const NAMES = [['Sanne de Vries','sdevries'],['Mehmet Yilmaz','myilmaz'],['Lotte Bakker','lbakker'],['Daan Visser','dvisser'],
  ['Priya Raman','praman'],['Jonas Kuipers','jkuipers'],['Fatima El Amrani','felamran'],['Tom Hendriks','thendrik'],
  ['Wei Chen','wchen'],['Noor Jansen','njansen'],['Lucas Smit','lsmit'],['Eva Mulder','emulder'],['Bram de Boer','bdeboer'],['Iris Peters','ipeters']];
const COALITION_COLORS = { Vela: '#3f6fd8', Pyxis: '#c4862f', Cetus: '#1d9a8a' };
const QUICK = { early: 3, qf: 3, sf: 3, final: 3 };
const STANDARD = { early: 3, qf: 3, sf: 5, final: 5 };
const CHAMPIONSHIP = { early: 5, qf: 5, sf: 5, final: 7 };

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

function seedDemo(db, config = {}) {
  const R = rng(42), now = Date.now(), DAY = 864e5, HOUR = 36e5, strength = new Map();
  const coalitions = config.coalitions?.length ? config.coalitions : ['Vela', 'Pyxis', 'Cetus'];
  const insUser = db.prepare('INSERT INTO users (login, name, coalition, coalition_color, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const insMatch = db.prepare(`INSERT INTO matches (reporter_id, opponent_id, best_of, sets, winner_id, status, created_at, confirmed_at, tournament_id)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const admins = config.adminLogins?.length ? config.adminLogins : [NAMES[0][1]];
  const ids = NAMES.map(([name, login], i) => {
    const c = coalitions[i % coalitions.length];
    const id = Number(insUser.run(login, name, c, COALITION_COLORS[c] || null, admins.includes(login) ? 1 : 0, now - 60 * DAY).lastInsertRowid);
    strength.set(id, R());
    return id;
  });
  const add = (a, b, bo, sets, status, t, tid = null) => {
    const [x, y] = rules.tally(sets);
    return Number(insMatch.run(a, b, bo, JSON.stringify(sets), x > y ? a : b, status, t, status === 'confirmed' ? t : null, tid).lastInsertRowid);
  };
  const pick = () => ids[Math.floor(R() * ids.length)];

  // Friendly matches over the last five weeks.
  const N = 72;
  for (let i = 0; i < N; i++) {
    const a = pick(); let b; do { b = pick(); } while (b === a);
    const bo = R() < 0.6 ? 5 : R() < 0.85 ? 3 : 7;
    add(a, b, bo, simSets(strength.get(a), strength.get(b), bo, R), 'confirmed', Math.round(now - (35 - (i * 31) / N) * DAY));
  }

  const insT = db.prepare(`INSERT INTO tournaments (name, description, location, starts_at, status, created_by, created_at, best_of, stage_best_of,
                           round_best_of, max_players, signup_open, approved_by, seeds, bracket, finished_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const setP = db.prepare('INSERT INTO tournament_players (tournament_id, user_id, status, invited_by, created_at) VALUES (?, ?, ?, ?, ?)');

  // Creates a tournament. For live/done ones it simulates `playRounds` results.
  function tournament({ name, description = '', startsAt, status, by, stages, max = null, signup = true, joined = [], invited = [], play = 0, extraSemi = false }) {
    let seeds = [], rounds = [], perRound = [], finishedAt = null;
    if (status === 'live' || status === 'done') {
      seeds = [...joined].sort((x, y) => strength.get(y) - strength.get(x));
      rounds = rules.buildBracket(seeds);
      perRound = rules.roundBestOf(rounds.length, stages);
    }
    const tid = Number(insT.run(name, description, 'Campus table', startsAt, status, by, startsAt - 7 * DAY, stages.early, JSON.stringify(stages),
      JSON.stringify(perRound), max, signup ? 1 : 0, status === 'proposed' ? null : ids[0], JSON.stringify(seeds), '[]', null).lastInsertRowid);
    for (const u of joined) setP.run(tid, u, 'joined', null, startsAt - 6 * DAY);
    for (const u of invited) setP.run(tid, u, 'invited', by, startsAt - 5 * DAY);
    let h = 0;
    const playMatch = (r, k) => {
      const bm = rounds[r][k], sets = simSets(strength.get(bm.a), strength.get(bm.b), perRound[r], R);
      bm.matchId = add(bm.a, bm.b, perRound[r], sets, 'confirmed', startsAt + (h++) * 0.5 * HOUR, tid);
      const [x, y] = rules.tally(sets); bm.w = x > y ? bm.a : bm.b; rules.advance(rounds, r, k);
    };
    const roundsToPlay = status === 'done' ? rounds.length : play;
    for (let r = 0; r < roundsToPlay; r++) rounds[r].forEach((bm, k) => { if (!bm.bye) playMatch(r, k); });
    if (extraSemi) playMatch(roundsToPlay, 0);
    if (status === 'done') finishedAt = startsAt + h * 0.5 * HOUR;
    db.prepare('UPDATE tournaments SET bracket = ?, finished_at = ? WHERE id = ?').run(JSON.stringify(rounds), finishedAt, tid);
    return tid;
  }

  const at = (days, hour, min = 0) => { const d = new Date(now + days * DAY); d.setHours(hour, min, 0, 0); return d.getTime(); };
  tournament({ name: 'September Opener', description: 'First knockout of the season.', startsAt: at(-29, 18), status: 'done', by: ids[0], stages: QUICK, joined: ids.slice(0, 8) });
  tournament({ name: 'Lunch Break Cup #1', startsAt: at(-20, 12, 30), status: 'done', by: ids[4], stages: QUICK, joined: ids.slice(5, 10) });
  tournament({ name: 'Coalition Night', description: 'Two players from every coalition.', startsAt: at(-13, 19), status: 'done', by: ids[0], stages: STANDARD, joined: [ids[0], ids[1], ids[2], ids[3], ids[4], ids[5]] });
  tournament({ name: 'Friday Night Knockout', description: 'Seven of the strongest players on campus.', startsAt: at(-2, 18), status: 'live', by: ids[2], stages: STANDARD,
    joined: [...ids].sort((x, y) => strength.get(y) - strength.get(x)).slice(0, 7), play: 1, extraSemi: true });
  tournament({ name: 'Lunch Break Cup #2', description: 'Quick best-of-3 games. Done before lunch is over.', startsAt: at(2, 12, 30), status: 'open', by: ids[4], stages: QUICK, max: 8,
    joined: [ids[4], ids[6], ids[8], ids[10], ids[12]] });
  tournament({ name: 'Coalition Clash', description: 'Vela, Pyxis and Cetus each send their best. Bragging rights for a month.', startsAt: at(9, 18), status: 'open', by: ids[0], stages: CHAMPIONSHIP,
    signup: false, joined: [ids[0], ids[1], ids[2]], invited: [ids[3], ids[4], ids[5], ids[6], ids[7], ids[8]] });
  tournament({ name: 'Best of 7 Masters', description: 'Long matches for people who want them. Starts early so the table is free by lunch.', startsAt: at(16, 9), status: 'proposed', by: ids[7], stages: { early: 5, qf: 5, sf: 7, final: 7 },
    max: 8, joined: [ids[7]] });
  tournament({ name: 'Halloween Smash', description: 'Costumes encouraged, paddles mandatory.', startsAt: at(24, 17), status: 'open', by: ids[9], stages: STANDARD, max: 16, joined: [ids[9], ids[11], ids[13]] });

  // Every player has one result waiting for them and one waiting on someone else.
  ids.forEach((id, i) => add(ids[(i + 1) % ids.length], id, 5, simSets(0.5, 0.5, 5, R), 'pending', now - (2 + i) * HOUR));

  // A few challenges.
  const insC = db.prepare(`INSERT INTO challenges (from_id, to_id, best_of, message, status, created_at, responded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  ids.forEach((id, i) => {
    insC.run(ids[(i + 3) % ids.length], id, 5, ['Rematch?', 'Lunch tomorrow?', 'You still owe me a game.', ''][i % 4], 'open', now - (5 + i) * HOUR, null);
  });
  insC.run(ids[0], ids[6], 7, 'Best of 7 after the evaluation rush.', 'accepted', now - DAY, now - 20 * HOUR);
}

module.exports = { seedDemo };
