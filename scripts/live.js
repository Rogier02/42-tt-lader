// npm run live
// Runs the live copy and keeps it running: restarts it after a crash, switches to a new release as soon
// as `npm run release` (or `npm run rollback`) points CURRENT somewhere else, and backs up the database daily.
// Stop it with Ctrl+C.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { P, c, die, readCurrent, backupDb, checkNode, liveRunning } = require('./lib');

checkNode();
if (!fs.existsSync(P.env)) die(`The live copy isn't set up yet. Run ${c.bold('npm run setup:live')} first.`);
if (!readCurrent()) die(`There's no release yet. Run ${c.bold('npm run release')} first.`);
const other = liveRunning();
if (other && other !== process.pid) die(`Live is already running (process ${other}). Stop that one first.`);

fs.mkdirSync(P.logs, { recursive: true });
fs.writeFileSync(P.pid, String(process.pid));
const log = fs.createWriteStream(path.join(P.logs, 'live.log'), { flags: 'a' });
const say = (msg) => { const line = `[${new Date().toLocaleString('en-GB')}] ${msg}`; console.log(c.dim(line)); log.write(line + '\n'); };

let child = null, running = null, stopping = false, crashes = 0, startedAt = 0;

function start() {
  running = readCurrent();
  const dir = path.join(P.releases, running);
  if (!fs.existsSync(dir)) { say(`Release ${running} is missing. Waiting for a new release.`); child = null; return; }
  say(`Starting release ${running}`);
  startedAt = Date.now();
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', `--env-file=${P.env}`, 'server/index.js'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  child = proc;
  for (const s of [proc.stdout, proc.stderr]) s.on('data', (d) => { process.stdout.write(d); log.write(d); });
  proc.on('exit', (code, signal) => {
    if (child === proc) child = null;
    if (stopping || proc.switching) return;
    crashes = Date.now() - startedAt > 60e3 ? 1 : crashes + 1;
    const wait = Math.min(30, [2, 5, 10, 30][crashes - 1] || 30);
    say(`Live stopped unexpectedly (${signal || 'exit ' + code}). Restarting in ${wait}s.`);
    setTimeout(() => { if (!stopping && !child) start(); }, wait * 1000);
  });
}

function stopChild() {
  return new Promise((resolve) => {
    if (!child) return resolve();
    const ch = child;
    ch.once('exit', resolve);
    ch.kill('SIGTERM');
    setTimeout(() => { try { ch.kill('SIGKILL'); } catch {} }, 5000);
  });
}

// Switch release when CURRENT changes.
setInterval(async () => {
  const next = readCurrent();
  if (!next || next === running || stopping) return;
  say(`New release ${next}, switching over`);
  if (child) { child.switching = true; await stopChild(); }
  start();
}, 2000).unref?.();

// Daily backup (and one at start).
const backup = () => { try { const f = backupDb('daily'); if (f) say(`Database backed up to backups/${path.basename(f)}`); } catch (e) { say(`Backup failed: ${e.message}`); } };
backup();
setInterval(backup, 24 * 3600e3);

async function shutdown() {
  if (stopping) return;
  stopping = true;
  say('Stopping live');
  await stopChild();
  try { if (Number(fs.readFileSync(P.pid, 'utf8')) === process.pid) fs.rmSync(P.pid); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
