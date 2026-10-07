const { loadConfig } = require('./config');
const { open } = require('./db');
const { buildApp } = require('./app');
const { seedDemo } = require('./seed');

const config = loadConfig();
const db = open(config.dbFile);

if (config.authMode === 'dev' && db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  seedDemo(db);
  console.log('Dev mode: empty database, filled it with demo players and matches.');
}

const app = buildApp(config, db);
app.listen({ port: config.port, host: config.host }).then(() => {
  console.log(`42 Table Tennis Ladder running at ${config.baseUrl} (sign-in: ${config.authMode === '42' ? '42 intra' : 'dev mode, simulated'})`);
}).catch((err) => { console.error(err); process.exit(1); });
