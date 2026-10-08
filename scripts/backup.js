// npm run backup:live — makes a copy of the live database right now (safe while live is running).
const path = require('node:path');
const { ok, die, backupDb } = require('./lib');
const f = backupDb('manual');
if (!f) die('There is no live database yet.');
ok(`Backed up to ${path.relative(process.cwd(), f)}`);
