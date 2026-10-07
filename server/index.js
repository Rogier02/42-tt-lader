const { loadConfig } = require('./config');
const { open } = require('./db');
const { buildApp } = require('./app');
const { seedDemo } = require('./seed');
const { assignMissing } = require('./coalitions');

const config = loadConfig();
const db = open(config.dbFile);

if (config.authMode === 'dev' && db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  seedDemo(db, config);
  console.log('Dev mode: empty database, filled it with demo players and matches.');
}

const assigned = assignMissing(db, config.coalitions);
if (assigned) console.log(`Gave ${assigned} player(s) a random coalition.`);

const app = buildApp(config, db);
app.listen({ port: config.port, host: config.host }).then(() => {
  console.log(`42 Table Tennis Ladder running at ${config.baseUrl} (sign-in: ${config.authMode === '42' ? '42 intra' : 'dev mode, simulated'})`);
}).catch((err) => { console.error(err); process.exit(1); });
