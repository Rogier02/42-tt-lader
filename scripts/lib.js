// Shared helpers for the test/live scripts.
//
// Layout on disk:
//   <repo>/                 the test copy you work in (git branch "dev"), runs with `npm run dev`
//   <repo>-live/            the live copy, created by `npm run setup:live`
//     .env                  live settings and 42 credentials (never in git)
//     data/ladder.db        the live database
//     backups/              database copies, made before every release and once a day
//     releases/<name>/      one folder per release, exported from git branch "main"
//     CURRENT               the name of the release that live runs
//     logs/live.log         server output
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const LIVE = path.resolve(process.env.LIVE_DIR || path.join(REPO, '..', `${path.basename(REPO)}-live`));
const P = {
  repo: REPO,
  live: LIVE,
  env: path.join(LIVE, '.env'),
  data: path.join(LIVE, 'data'),
  db: path.join(LIVE, 'data', 'ladder.db'),
  backups: path.join(LIVE, 'backups'),
  releases: path.join(LIVE, 'releases'),
  current: path.join(LIVE, 'CURRENT'),
  logs: path.join(LIVE, 'logs'),
  pid: path.join(LIVE, 'live.pid'),
};

const color = (n) => (s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const c = { ok: color(32), warn: color(33), err: color(31), bold: color(1), dim: color(2) };
const step = (msg) => console.log(`${c.bold('→')} ${msg}`);
const ok = (msg) => console.log(`${c.ok('✓')} ${msg}`);
const warn = (msg) => console.log(`${c.warn('!')} ${msg}`);
function die(msg) { console.error(`\n${c.err('✗')} ${msg}\n`); process.exit(1); }

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function readCurrent() { try { return fs.readFileSync(P.current, 'utf8').trim() || null; } catch { return null; } }
function writeCurrent(name) {
  const tmp = `${P.current}.tmp`;
  fs.writeFileSync(tmp, `${name}\n`);
  fs.renameSync(tmp, P.current); // atomic, so the supervisor never reads half a name
}
function releases() {
  if (!fs.existsSync(P.releases)) return [];
  return fs.readdirSync(P.releases).filter((n) => fs.existsSync(path.join(P.releases, n, 'RELEASE.json'))).sort();
}
function releaseInfo(name) {
  try { return JSON.parse(fs.readFileSync(path.join(P.releases, name, 'RELEASE.json'), 'utf8')); } catch { return {}; }
}

// A consistent copy of the live database, safe to take while the server is running.
function backupDb(label) {
  if (!fs.existsSync(P.db)) return null;
  fs.mkdirSync(P.backups, { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const out = path.join(P.backups, `ladder-${stamp()}-${label}.db`);
  const db = new DatabaseSync(P.db);
  try { db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`); } finally { db.close(); }
  prune(P.backups, 30);
  return out;
}

// Keeps the newest `keep` entries of a folder (by name, which starts with a timestamp).
function prune(dir, keep, protect = []) {
  const names = fs.readdirSync(dir).sort();
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    if (protect.includes(n)) continue;
    fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  }
}

function checkNode() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) die(`Node.js 22.13 or newer is needed (you have ${process.versions.node}). Install the current LTS from nodejs.org.`);
}

function liveRunning() {
  try { const pid = Number(fs.readFileSync(P.pid, 'utf8')); process.kill(pid, 0); return pid; } catch { return null; }
}

module.exports = { P, c, step, ok, warn, die, git, stamp, readCurrent, writeCurrent, releases, releaseInfo, backupDb, prune, checkNode, liveRunning };
