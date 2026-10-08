// npm run rollback              switch live back to the release before the current one
// npm run rollback -- --list    show the releases on disk
// npm run rollback -- <name>    switch live to a specific release
// The database is not rolled back: it keeps everything played since. Backups are in <live>/backups.
const { P, c, ok, die, readCurrent, writeCurrent, releases, releaseInfo, liveRunning } = require('./lib');

const all = releases();
const current = readCurrent();
const arg = process.argv[2];
if (!all.length) die('There are no releases yet.');

if (arg === '--list') {
  console.log(`\nReleases in ${P.releases}:\n`);
  for (const n of [...all].reverse()) {
    const i = releaseInfo(n);
    console.log(`${n === current ? c.ok('● live ') : '       '} ${n}  ${c.dim(i.subject || '')}`);
  }
  console.log('');
  process.exit(0);
}

let target = arg;
if (!target) {
  const idx = all.indexOf(current);
  target = idx > 0 ? all[idx - 1] : null;
  if (!target) die(`There's no earlier release to go back to. See them with ${c.bold('npm run rollback -- --list')}.`);
}
if (!all.includes(target)) die(`There's no release called "${target}". See them with ${c.bold('npm run rollback -- --list')}.`);
if (target === current) die(`Live already runs ${target}.`);

writeCurrent(target);
ok(`Live now points at ${target} (${releaseInfo(target).subject || ''})`);
console.log(liveRunning() ? 'Live switches over within a few seconds.' : `Live isn't running. Start it with ${c.bold('npm run live')}.`);
console.log(c.dim(`The database was not changed. Your code on "dev" and "main" wasn't changed either: fix the problem on dev and release again.\n`));
