// Until coalitions come from the 42 API, players without one get a random coalition,
// always picking among the smallest ones so the teams stay balanced.
function assignMissing(db, names) {
  if (!names.length) return 0;
  const counts = new Map(names.map((n) => [n, 0]));
  for (const r of db.prepare('SELECT coalition, COUNT(*) AS n FROM users WHERE coalition IS NOT NULL GROUP BY coalition').all())
    if (counts.has(r.coalition)) counts.set(r.coalition, r.n);
  const missing = db.prepare('SELECT id FROM users WHERE coalition IS NULL ORDER BY id').all();
  const set = db.prepare('UPDATE users SET coalition = ? WHERE id = ?');
  for (const { id } of missing) {
    const min = Math.min(...counts.values());
    const smallest = names.filter((n) => counts.get(n) === min);
    const pick = smallest[Math.floor(Math.random() * smallest.length)];
    set.run(pick, id);
    counts.set(pick, counts.get(pick) + 1);
  }
  return missing.length;
}

module.exports = { assignMissing };
