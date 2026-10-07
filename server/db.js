// SQLite via Node's built-in driver (Node 22.13+), so there is nothing native to compile.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY,
      intra_id   INTEGER UNIQUE,            -- null for dev-mode users
      login      TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      image_url  TEXT,
      is_admin   INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    -- The match log is the source of truth. Ratings and points are recomputed from it.
    CREATE TABLE IF NOT EXISTS matches (
      id            INTEGER PRIMARY KEY,
      reporter_id   INTEGER NOT NULL REFERENCES users(id),
      opponent_id   INTEGER NOT NULL REFERENCES users(id),
      best_of       INTEGER NOT NULL,
      sets          TEXT NOT NULL,           -- JSON [[reporterScore, opponentScore], ...]
      winner_id     INTEGER NOT NULL REFERENCES users(id),
      status        TEXT NOT NULL CHECK (status IN ('pending','confirmed','disputed','withdrawn')),
      created_at    INTEGER NOT NULL,
      confirmed_at  INTEGER,
      tournament_id INTEGER REFERENCES tournaments(id)
    );
    CREATE INDEX IF NOT EXISTS matches_status ON matches(status, confirmed_at);

    CREATE TABLE IF NOT EXISTS tournaments (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      best_of    INTEGER NOT NULL DEFAULT 3,
      seeds      TEXT NOT NULL,              -- JSON [userId, ...] strongest first
      bracket    TEXT NOT NULL,              -- JSON rounds, see rules.buildBracket
      finished_at INTEGER
    );
  `);
  migrate(db);
  return db;
}

// Schema changes after the first version. PRAGMA user_version records which have run.
function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version < 2) {
    db.exec('BEGIN');
    try {
      db.exec(`
        ALTER TABLE users ADD COLUMN coalition TEXT;
        ALTER TABLE users ADD COLUMN coalition_color TEXT;

        -- status: proposed (waiting for approval) > open (sign-ups) > live (bracket) > done; or rejected / cancelled
        ALTER TABLE tournaments ADD COLUMN status TEXT NOT NULL DEFAULT 'live';
        ALTER TABLE tournaments ADD COLUMN description TEXT NOT NULL DEFAULT '';
        ALTER TABLE tournaments ADD COLUMN location TEXT NOT NULL DEFAULT '';
        ALTER TABLE tournaments ADD COLUMN starts_at INTEGER;
        ALTER TABLE tournaments ADD COLUMN stage_best_of TEXT;   -- JSON {early, qf, sf, final}
        ALTER TABLE tournaments ADD COLUMN round_best_of TEXT;   -- JSON [bestOf per round], set when the bracket starts
        ALTER TABLE tournaments ADD COLUMN max_players INTEGER;
        ALTER TABLE tournaments ADD COLUMN signup_open INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE tournaments ADD COLUMN approved_by INTEGER REFERENCES users(id);

        CREATE TABLE tournament_players (
          tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
          user_id       INTEGER NOT NULL REFERENCES users(id),
          status        TEXT NOT NULL CHECK (status IN ('invited','joined','declined')),
          invited_by    INTEGER REFERENCES users(id),
          created_at    INTEGER NOT NULL,
          PRIMARY KEY (tournament_id, user_id)
        );

        CREATE TABLE challenges (
          id           INTEGER PRIMARY KEY,
          from_id      INTEGER NOT NULL REFERENCES users(id),
          to_id        INTEGER NOT NULL REFERENCES users(id),
          best_of      INTEGER NOT NULL,
          message      TEXT NOT NULL DEFAULT '',
          status       TEXT NOT NULL CHECK (status IN ('open','accepted','declined','cancelled','played')),
          created_at   INTEGER NOT NULL,
          responded_at INTEGER
        );
      `);
      // Bring tournaments from version 1 forward.
      const upd = db.prepare(`UPDATE tournaments SET status = ?, starts_at = created_at, stage_best_of = ?, round_best_of = ? WHERE id = ?`);
      const join = db.prepare(`INSERT OR IGNORE INTO tournament_players (tournament_id, user_id, status, invited_by, created_at) VALUES (?, ?, 'joined', NULL, ?)`);
      for (const t of db.prepare('SELECT * FROM tournaments').all()) {
        const rounds = JSON.parse(t.bracket), bo = t.best_of;
        upd.run(t.finished_at ? 'done' : 'live', JSON.stringify({ early: bo, qf: bo, sf: bo, final: bo }), JSON.stringify(rounds.map(() => bo)), t.id);
        for (const uid of JSON.parse(t.seeds)) join.run(t.id, uid, t.created_at);
      }
      db.exec('PRAGMA user_version = 2');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  if (version < 3) {
    db.exec(`
      BEGIN;
      -- One row per season. The current season has ends_at = NULL.
      -- When a season ends, its final standings are frozen in results (JSON).
      CREATE TABLE seasons (
        id          INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        starts_at   INTEGER NOT NULL,
        ends_at     INTEGER,
        planned_end INTEGER,
        prize       TEXT NOT NULL DEFAULT '',
        results     TEXT
      );
      PRAGMA user_version = 3;
      COMMIT;
    `);
  }
  if (version < 4) {
    db.exec(`
      BEGIN;
      -- "A challenger approaches": matchups the app hands out every week.
      -- A matchup is completed when a confirmed match points to it (matches.matchup_id).
      CREATE TABLE matchups (
        id         INTEGER PRIMARY KEY,
        week       TEXT NOT NULL,            -- start of the week it belongs to, e.g. 2026-10-05
        kind       TEXT NOT NULL CHECK (kind IN ('weekly','bonus')),
        a_id       INTEGER NOT NULL REFERENCES users(id),
        b_id       INTEGER NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX matchups_week ON matchups(week);
      ALTER TABLE matches ADD COLUMN matchup_id INTEGER REFERENCES matchups(id);
      ALTER TABLE users ADD COLUMN matchups_opt_out INTEGER NOT NULL DEFAULT 0;
      PRAGMA user_version = 4;
      COMMIT;
    `);
  }
}

module.exports = { open };
