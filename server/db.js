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
  return db;
}

module.exports = { open };
