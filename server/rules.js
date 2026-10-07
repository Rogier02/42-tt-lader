// Pure game logic: Glicko-2, set/match validation, brackets.
// No database access here, so it is easy to test and reuse.

const SCALE = 173.7178;
const TAU = 0.5;
const MIN_RD = 45;
const START = { r: 1500, rd: 350, vol: 0.06 };

const g = (phi) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expected = (mu, muj, phij) => 1 / (1 + Math.exp(-g(phij) * (mu - muj)));

// One Glicko-2 update of player p after a single game against o (s = 1 win, 0 loss).
function glicko(p, o, s) {
  const mu = (p.r - 1500) / SCALE, phi = p.rd / SCALE;
  const muj = (o.r - 1500) / SCALE, phij = o.rd / SCALE;
  const gj = g(phij), e = expected(mu, muj, phij);
  const v = 1 / (gj * gj * e * (1 - e));
  const delta = v * gj * (s - e);
  const a = Math.log(p.vol * p.vol), d2 = delta * delta, p2 = phi * phi;
  const f = (x) => {
    const ex = Math.exp(x);
    return (ex * (d2 - p2 - v - ex)) / (2 * Math.pow(p2 + v + ex, 2)) - (x - a) / (TAU * TAU);
  };
  let A = a, B;
  if (d2 > p2 + v) B = Math.log(d2 - p2 - v);
  else { let k = 1; while (f(a - k * TAU) < 0) k++; B = a - k * TAU; }
  let fA = f(A), fB = f(B), n = 0;
  while (Math.abs(B - A) > 1e-6 && n++ < 100) {
    const C = A + ((A - B) * fA) / (fB - fA), fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else fA /= 2;
    B = C; fB = fC;
  }
  const vol = Math.exp(A / 2);
  const phiStar = Math.sqrt(p2 + vol * vol);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  return { r: (mu + phiNew * phiNew * gj * (s - e)) * SCALE + 1500, rd: Math.max(phiNew * SCALE, MIN_RD), vol };
}

// ITTF: a game goes to 11, and from 10-10 must be won by exactly 2.
function validSet(x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x === y) return false;
  const hi = Math.max(x, y), lo = Math.min(x, y);
  if (hi < 11) return false;
  return hi === 11 ? lo <= 9 : hi - lo === 2;
}

// Returns an error string, or null when `sets` is a complete, valid best-of-N match.
function checkMatch(sets, bestOf) {
  if (![3, 5, 7].includes(bestOf)) return 'Best of 3, 5 or 7 only.';
  if (!Array.isArray(sets) || sets.length === 0) return 'Enter at least one set.';
  const need = Math.ceil(bestOf / 2);
  let a = 0, b = 0;
  for (let i = 0; i < sets.length; i++) {
    const s = sets[i];
    if (!Array.isArray(s) || s.length !== 2) return `Set ${i + 1} is malformed.`;
    if (a === need || b === need) return 'Extra sets after the match was already decided.';
    if (!validSet(s[0], s[1])) return `Set ${i + 1}: ${s[0]}–${s[1]} isn't a valid set.`;
    s[0] > s[1] ? a++ : b++;
  }
  if (a !== need && b !== need) return 'The match is not finished yet.';
  return null;
}

const tally = (sets) => sets.reduce(([a, b], s) => (s[0] > s[1] ? [a + 1, b] : [a, b + 1]), [0, 0]);

// Standard bracket order so seeds 1 and 2 can only meet in the final.
function seedOrder(n) {
  let a = [1, 2];
  while (a.length < n) { const L = a.length * 2 + 1; a = a.flatMap((s) => [s, L - s]); }
  return a;
}

// seeds: player ids, strongest first. Returns rounds[r][k] = {a, b, w, bye, matchId}.
function buildBracket(seeds) {
  const size = 2 ** Math.ceil(Math.log2(seeds.length));
  const order = seedOrder(size), nRounds = Math.log2(size);
  const rounds = [Array.from({ length: size / 2 }, (_, k) => ({
    a: seeds[order[2 * k] - 1] ?? null, b: seeds[order[2 * k + 1] - 1] ?? null, w: null, bye: false, matchId: null,
  }))];
  for (let r = 1; r < nRounds; r++)
    rounds.push(Array.from({ length: size / 2 ** (r + 1) }, () => ({ a: null, b: null, w: null, bye: false, matchId: null })));
  rounds[0].forEach((m, k) => { if (!m.b) { m.w = m.a; m.bye = true; advance(rounds, 0, k); } });
  return rounds;
}

function advance(rounds, r, k) {
  const m = rounds[r][k];
  if (r + 1 < rounds.length) rounds[r + 1][k >> 1][k % 2 ? 'b' : 'a'] = m.w;
}

const isFinished = (rounds) => !!rounds[rounds.length - 1][0].w;

module.exports = { START, glicko, expected, validSet, checkMatch, tally, buildBracket, advance, isFinished, SCALE };
