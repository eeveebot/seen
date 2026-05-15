'use strict';

import fs from 'node:fs';
import { log } from '@eeveebot/libeevee';
import Database from 'better-sqlite3';

// Database instance (singleton)
let db: Database.Database | null = null;

// Prepared statements
let findUserStmt: Database.Statement | null = null;
let updateSeenUserStmt: Database.Statement | null = null;
let findUsersSinceStmt: Database.Statement | null = null;

/**
 * Initialize the seen database. Must be called once at startup.
 */
export function initDatabase(): void {
  try {
    const moduleDataPath = process.env.MODULE_DATA;
    if (!moduleDataPath) {
      throw new Error('MODULE_DATA environment variable not set');
    }

    // Ensure the directory exists
    if (!fs.existsSync(moduleDataPath)) {
      fs.mkdirSync(moduleDataPath, { recursive: true });
    }

    const dbPath = `${moduleDataPath}/seen.db`;
    db = new Database(dbPath);

    // Create tables if they don't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS seen_users (
        nick TEXT,
        date TEXT,
        text TEXT,
        platform TEXT,
        network TEXT,
        instance TEXT,
        channel TEXT,
        PRIMARY KEY (nick, platform, network, instance, channel)
      );
    `);

    // Prepare statements
    findUserStmt = db.prepare(`
      SELECT * FROM seen_users WHERE nick = @nick
      ORDER BY date DESC
      LIMIT 1
    `);

    updateSeenUserStmt = db.prepare(`
      INSERT INTO seen_users (nick, date, text, platform, network, instance, channel)
      VALUES (@nick, @date, @text, @platform, @network, @instance, @channel)
      ON CONFLICT(nick, platform, network, instance, channel) DO UPDATE SET
        date = excluded.date,
        text = excluded.text
    `);

    findUsersSinceStmt = db.prepare(`
      SELECT DISTINCT nick FROM seen_users WHERE date >= @sinceTime
    `);

    log.info('Initialized seen database', {
      producer: 'seen',
      dbPath,
    });
  } catch (error) {
    log.error('Failed to initialize seen database', {
      producer: 'seen',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Close the database connection. Called during graceful shutdown.
 */
export function closeDatabase(): void {
  if (db) db.close();
}

/**
 * Get the raw database instance for ad-hoc queries (lurkers, lurkers-report).
 */
export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}

/**
 * Find the most recent seen record for a user.
 */
export function findUser(nick: string): { date: string; text: string } | undefined {
  if (!findUserStmt) throw new Error('Database not initialized');
  return findUserStmt.get({ nick }) as { date: string; text: string } | undefined;
}

/**
 * Update or insert a seen record for a user.
 */
export function updateSeenUser(data: {
  nick: string;
  date: string;
  text: string;
  platform: string;
  network: string;
  instance: string;
  channel: string;
}): void {
  if (!updateSeenUserStmt) throw new Error('Database not initialized');
  updateSeenUserStmt.run(data);
}

/**
 * Find all distinct nicks seen since a given ISO timestamp.
 */
export function findUsersSince(sinceTime: string): Array<{ nick: string }> {
  if (!findUsersSinceStmt) throw new Error('Database not initialized');
  return findUsersSinceStmt.all({ sinceTime }) as Array<{ nick: string }>;
}
