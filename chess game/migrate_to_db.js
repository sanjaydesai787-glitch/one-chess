import Database from './database.js';
import fs from 'fs';
import path from 'path';

const db = new Database();

try {
  await db.init();
  console.log('Database initialized for migration');
} catch (e) {
  console.error('Failed to init database:', e);
  process.exit(1);
}

const RESULTS_PATH = path.join(process.cwd(), 'results.json');
const PLAYERS_PATH = path.join(process.cwd(), 'players.json');
const RATINGS_PATH = path.join(process.cwd(), 'ratings.json');

const summary = { games: 0, players: 0, ratings: 0 };

// Migrate results/games
if (fs.existsSync(RESULTS_PATH)) {
  try {
    const raw = fs.readFileSync(RESULTS_PATH, 'utf8');
    const arr = JSON.parse(raw || '[]');
    for (const r of arr) {
      const roomId = r.roomId || r.room_id || null;
      const white = r.white || r.white_player || null;
      const black = r.black || r.black_player || null;
      const result = r.result || null;
      const reason = r.reason || null;
      const fen = r.fen_final || r.fen || null;
      const move_count = r.move_count || null;
      const finishedAt = r.finishedAt || r.finished_at || null;
      try {
        await db.run(
          `INSERT OR IGNORE INTO games (room_id, white_player, black_player, result, reason, fen_final, move_count, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [roomId, white, black, result, reason, fen, move_count, finishedAt]
        );
        summary.games += 1;
      } catch (e) {
        console.error('Failed to insert game', e, r);
      }
    }
  } catch (e) {
    console.error('Failed to read results.json', e);
  }
} else {
  console.log('No results.json found, skipping games migration');
}

// Migrate players
if (fs.existsSync(PLAYERS_PATH)) {
  try {
    const raw = fs.readFileSync(PLAYERS_PATH, 'utf8');
    const list = JSON.parse(raw || '[]');
    for (const name of list) {
      try {
        await db.run(`INSERT OR IGNORE INTO players (name) VALUES (?)`, [name]);
        summary.players += 1;
      } catch (e) {
        console.error('Failed to insert player', e, name);
      }
    }
  } catch (e) {
    console.error('Failed to read players.json', e);
  }
} else {
  console.log('No players.json found, skipping players migration');
}

// Migrate ratings
if (fs.existsSync(RATINGS_PATH)) {
  try {
    const raw = fs.readFileSync(RATINGS_PATH, 'utf8');
    const obj = JSON.parse(raw || '{}');
    const now = new Date().toISOString();
    for (const [player, rating] of Object.entries(obj)) {
      try {
        await db.run(
          `INSERT INTO ratings (player_name, elo_rating, total_games, wins, losses, draws, updated_at) VALUES (?, ?, 0, 0, 0, 0, ?)
           ON CONFLICT(player_name) DO UPDATE SET elo_rating=excluded.elo_rating, updated_at=excluded.updated_at`,
          [player, rating, now]
        );
        summary.ratings += 1;
      } catch (e) {
        console.error('Failed to insert rating', e, player, rating);
      }
    }
  } catch (e) {
    console.error('Failed to read ratings.json', e);
  }
} else {
  console.log('No ratings.json found, skipping ratings migration');
}

try {
  await db.close();
  console.log('Database closed after migration');
} catch (e) {
  console.error('Failed to close database', e);
}

console.log('Migration complete', summary);
process.exit(0);
