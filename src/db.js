// src/db.js
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT } from './config.js';

export function openDb(file = path.join(ROOT, 'data', 'radio.sqlite')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS plays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      source_url TEXT,
      played_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,          -- 'user' | 'dj'
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,          -- 'skip' | 'finish' | 'request'（F12 行为信号）
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      pct REAL,                    -- 切歌/听完时的播放进度 0~1（request 为 NULL）
      at INTEGER NOT NULL
    );
  `);

  const insPlay = db.prepare(
    'INSERT INTO plays (title, artist, source_url, played_at) VALUES (?, ?, ?, ?)');
  const selPlays = db.prepare(
    'SELECT title, artist, source_url AS sourceUrl, played_at AS playedAt FROM plays ORDER BY id DESC LIMIT ?');
  const selWithin = db.prepare(
    'SELECT 1 FROM plays WHERE title = ? AND artist = ? AND played_at >= ? LIMIT 1');
  const selArtists = db.prepare(
    'SELECT artist FROM plays ORDER BY id DESC LIMIT ?');
  const insMsg = db.prepare(
    'INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)');
  const selMsgs = db.prepare(
    'SELECT role, content, created_at AS createdAt FROM messages ORDER BY id DESC LIMIT ?');
  const insSignal = db.prepare(
    'INSERT INTO signals (type, title, artist, pct, at) VALUES (?, ?, ?, ?, ?)');
  const selSignals = db.prepare(
    'SELECT type, title, artist, pct, at FROM signals WHERE at >= ? ORDER BY id ASC');

  return {
    addPlay({ title, artist, sourceUrl = '' }) {
      insPlay.run(title, artist, sourceUrl, Date.now());
    },
    recentPlays(limit = 20) { return selPlays.all(limit); },
    playedWithin(title, artist, ms) {
      return !!selWithin.get(title, artist, Date.now() - ms);
    },
    recentArtists(n = 5) { return selArtists.all(n).map(r => r.artist); },
    addMessage(role, content) { insMsg.run(role, content, Date.now()); },
    recentMessages(limit = 8) { return selMsgs.all(limit).reverse(); },
    // F12 行为信号（被动采集）：切歌=负（pct 越小越强）、听完=正、点歌=强正
    addSignal({ type, title, artist, pct = null }) {
      insSignal.run(type, title, artist, pct, Date.now());
    },
    signalsSince(since) { return selSignals.all(since); },
    close() { db.close(); },
  };
}
