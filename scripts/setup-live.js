// npm run setup:live
// Creates the live folder next to this repo and writes its settings, including your 42 app credentials.
// Run it again any time to change a setting (for example when your 42 app secret is renewed).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { P, c, ok, die, checkNode } = require('./lib');

function parseEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

(async () => {
  checkNode();
  const old = parseEnv(P.env);
  // Lines are queued as they arrive, so answers can be typed or piped in.
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const lines = [], waiting = [];
  let ended = false;
  rl.on('line', (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)));
  rl.on('close', () => { ended = true; while (waiting.length) waiting.shift()(null); });
  const nextLine = () => (lines.length ? Promise.resolve(lines.shift()) : ended ? Promise.resolve(null) : new Promise((r) => waiting.push(r)));
  const ask = async (q, def = '', { required = false, check } = {}) => {
    for (;;) {
      process.stdout.write(`${q}${def ? c.dim(` [${def.length > 24 ? def.slice(0, 6) + '…' : def}]`) : ''}: `);
      const line = await nextLine();
      if (line === null) die('Setup was interrupted before all questions were answered. Nothing was saved.');
      if (!process.stdin.isTTY) process.stdout.write('\n');
      const a = line.trim() || def;
      if (required && !a) { console.log(c.warn('  This one is needed.')); continue; }
      const err = check && a ? check(a) : null;
      if (err) { console.log(c.warn(`  ${err}`)); continue; }
      return a;
    }
  };

  console.log(`\n${c.bold('Live copy setup')}\nLive folder: ${P.live}\n`);
  const port = await ask('Port for the live copy', old.PORT || '3001', { check: (v) => (/^\d{2,5}$/.test(v) ? null : 'Use a number like 3001.') });
  const baseUrl = `http://localhost:${port}`;
  console.log(`\nRegister an app on 42 intra (profile.intra.42.fr → Settings → API → Register a new app).
Use this redirect URI, exactly:  ${c.bold(`${baseUrl}/auth/42/callback`)}
Scope: public. Then copy the UID and SECRET shown on the app page.\n`);
  const id = await ask('42 app UID', old.FT_CLIENT_ID, { required: true });
  const secret = await ask('42 app SECRET', old.FT_CLIENT_SECRET, { required: true });
  const admins = await ask('Your 42 login (becomes admin; separate several with commas)', old.ADMIN_LOGINS, { required: true, check: (v) => (/^[a-z0-9_,\s-]+$/i.test(v) ? null : 'Logins are letters, digits, - and _.') });
  const season = await ask('Name of the first season', old.SEASON_NAME || 'Autumn 2026', { required: true });
  const seasonStart = await ask('First season starts (YYYY-MM-DD)', old.SEASON_START || new Date().toISOString().slice(0, 10), { check: (v) => (Number.isNaN(Date.parse(v)) ? 'Use a date like 2026-09-01.' : null) });
  const campus = await ask('Only allow these 42 campus ids (optional; shown in the live log at each sign-in)', old.ALLOWED_CAMPUS_IDS || '');
  rl.close();

  fs.mkdirSync(P.data, { recursive: true });
  fs.mkdirSync(P.releases, { recursive: true });
  fs.mkdirSync(P.backups, { recursive: true });
  fs.mkdirSync(P.logs, { recursive: true });

  const env = `# Live settings for 42 Table Tennis Ladder. Written by \`npm run setup:live\`; safe to edit by hand.
# Keep this file private: it holds your 42 app secret. Restart live after changing it.
APP_ENV=live
PORT=${port}
HOST=127.0.0.1
BASE_URL=${baseUrl}
DB_FILE=${P.db}
SESSION_COOKIE=ttl_live_sid
COOKIE_SECRET=${old.COOKIE_SECRET || crypto.randomBytes(32).toString('hex')}
LOG_LEVEL=warn
TZ=${old.TZ || 'Europe/Amsterdam'}

FT_CLIENT_ID=${id}
FT_CLIENT_SECRET=${secret}
ADMIN_LOGINS=${admins.replace(/\s+/g, '')}
ALLOWED_CAMPUS_IDS=${campus.replace(/\s+/g, '')}

# Only used to create the first season. After that, admins manage seasons in the app.
SEASON_NAME=${season}
SEASON_START=${seasonStart}

REQUIRE_TOURNAMENT_APPROVAL=${old.REQUIRE_TOURNAMENT_APPROVAL || 'true'}
CHALLENGERS=${old.CHALLENGERS || 'true'}
AUTO_CONFIRM_HOURS=${old.AUTO_CONFIRM_HOURS || '24'}
COALITIONS=${old.COALITIONS || 'Vela,Cetus,Pyxis'}
`;
  fs.writeFileSync(P.env, env, { mode: 0o600 });
  fs.chmodSync(P.env, 0o600);

  ok(`Saved ${path.relative(process.cwd(), P.env) || P.env}`);
  console.log(`\nNext:\n  1. ${c.bold('npm run release')}   tests the code on branch "dev" and makes it the live version\n  2. ${c.bold('npm run live')}      starts live at ${baseUrl} (keep that terminal open)\n  3. Open ${baseUrl}, sign in with 42. You're the admin.\n`);
})().catch((e) => die(e.message));
