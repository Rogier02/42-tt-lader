// npm run release
// Promotes what you've committed on branch "dev" to live:
//   tests pass → branch "main" moves up to "dev" → both pushed to GitHub → live database backed up →
//   the code of "main" is installed as a new release next to the old one → live switches over.
// Only committed code goes live. Uncommitted changes stay in your test copy.
const fs = require('node:fs');
const path = require('node:path');
const { execSync, spawnSync } = require('node:child_process');
const { P, c, step, ok, warn, die, git, stamp, readCurrent, writeCurrent, prune, backupDb, checkNode, liveRunning } = require('./lib');

checkNode();
if (!fs.existsSync(P.env)) die(`The live copy isn't set up yet. Run ${c.bold('npm run setup:live')} first.`);

// 1. Branch and working tree
let branch;
try { branch = git('rev-parse', '--abbrev-ref', 'HEAD'); } catch { die('This folder is not a git repository.'); }
if (branch !== 'dev') {
  die(`Releases are made from branch "dev", and you're on "${branch}".
  First time? Create it from your current work:  ${c.bold('git checkout -b dev')}
  Otherwise switch to it:                         ${c.bold('git checkout dev')}`);
}
const dirty = git('status', '--porcelain').split('\n').filter((l) => l && !l.startsWith('??'));
if (dirty.length) die(`You have uncommitted changes:\n${dirty.map((l) => '    ' + l).join('\n')}\n  Commit them (or stash them) first, so live gets exactly what you tested.`);

// 2. Tests
step('Running tests');
const t = spawnSync('npm', ['test', '--silent'], { cwd: P.repo, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: process.platform === 'win32' });
const summary = (t.stdout || '').split('\n').filter((l) => /^# (pass|fail)/.test(l)).join(', ');
if (t.status !== 0) { console.log(t.stdout.split('\n').filter((l) => /^not ok|^#/.test(l)).join('\n')); die('Tests failed. Nothing was released.'); }
ok(`Tests pass (${summary.replace(/# /g, '')})`);

// 3. Move main up to dev (fast-forward only: main never gets ahead of dev)
let hasMain = true;
try { git('rev-parse', '--verify', 'main'); } catch { hasMain = false; }
if (hasMain) {
  try { git('merge-base', '--is-ancestor', 'main', 'dev'); }
  catch { die(`Branch "main" has commits that "dev" doesn't. Bring them into dev first:  ${c.bold('git merge main')}`); }
}
git('branch', '-f', 'main', 'dev');
const sha = git('rev-parse', '--short', 'main');
const subject = git('log', '-1', '--format=%s', 'main');
ok(`main is now at ${sha}: ${subject}`);

// 4. Push to GitHub (a failure here doesn't stop the release)
let hasRemote = false;
try { hasRemote = git('remote').split('\n').includes('origin'); } catch {}
if (hasRemote) {
  step('Pushing main and dev to GitHub');
  const p = spawnSync('git', ['push', 'origin', 'main', 'dev'], { cwd: P.repo, encoding: 'utf8' });
  if (p.status === 0) ok('Pushed'); else warn(`Couldn't push to GitHub (${(p.stderr || '').trim().split('\n').pop()}). The release continues; push later with: git push origin main dev`);
}

// 5. Back up the live database
const backup = backupDb(`before-${sha}`);
if (backup) ok(`Database backed up to backups/${path.basename(backup)}`);

// 6. Install the new release next to the old one
const name = `${stamp()}-${sha}`;
const dir = path.join(P.releases, name);
fs.mkdirSync(dir, { recursive: true });
step(`Installing release ${name}`);
try {
  execSync(`git archive --format=tar main | tar -x -C "${dir}"`, { cwd: P.repo, stdio: ['ignore', 'ignore', 'inherit'] });
  const i = spawnSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
  if (i.status !== 0) throw new Error('npm ci failed');
  const check = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', "require('./server/config');require('./server/db');require('./server/app')"], { cwd: dir, encoding: 'utf8' });
  if (check.status !== 0) throw new Error(`the new code doesn't load:\n${check.stderr}`);
} catch (e) {
  fs.rmSync(dir, { recursive: true, force: true });
  die(`Installing the release failed: ${e.message}\n  Live still runs the previous version.`);
}
fs.writeFileSync(path.join(dir, 'RELEASE.json'), JSON.stringify({ name, commit: sha, subject, releasedAt: new Date().toISOString(), previous: readCurrent() }, null, 2));

// 7. Switch live over and tidy up old releases
const previous = readCurrent();
writeCurrent(name);
prune(P.releases, 5, [name, previous].filter(Boolean));
ok(`Live now points at ${name}`);

const pid = liveRunning();
console.log(pid
  ? `\n${c.ok('Done.')} Live restarts on the new version within a few seconds.\n`
  : `\n${c.ok('Done.')} Live isn't running. Start it with ${c.bold('npm run live')}.\n`);
console.log(c.dim(`If something's wrong: npm run rollback  (switches back to ${previous || 'nothing, this was the first release'})\n`));
