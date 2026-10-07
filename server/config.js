const path = require('node:path');

const list = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);

function loadConfig(env = process.env) {
  const authMode = env.FT_CLIENT_ID && env.FT_CLIENT_SECRET ? '42' : 'dev';
  const port = Number(env.PORT || 3000);
  const cfg = {
    port,
    host: env.HOST || '127.0.0.1',
    baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    dbFile: env.DB_FILE || path.join(__dirname, '..', 'data', 'ladder.db'),
    authMode,
    ftClientId: env.FT_CLIENT_ID,
    ftClientSecret: env.FT_CLIENT_SECRET,
    cookieSecret: env.COOKIE_SECRET,
    allowedCampusIds: list(env.ALLOWED_CAMPUS_IDS).map(Number),
    adminLogins: list(env.ADMIN_LOGINS),
    seasonName: env.SEASON_NAME || 'Autumn 2026',
    seasonStart: env.SEASON_START ? Date.parse(env.SEASON_START) : 0,
    autoConfirmHours: Number(env.AUTO_CONFIRM_HOURS || 24),
  };
  if (!cfg.cookieSecret) {
    if (authMode === '42') throw new Error('COOKIE_SECRET must be set when 42 sign-in is enabled.');
    cfg.cookieSecret = 'dev-only-insecure-secret-change-me';
  }
  return cfg;
}

module.exports = { loadConfig };
