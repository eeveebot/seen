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
let findUserInChannelStmt: Database.Statement | null = null;
let findDepartureStmt: Database.Statement | null = null;
let findSeenUsersByNickStmt: Database.Statement | null = null;
let updateDepartureStmt: Database.Statement | null = null;

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

    db.exec(`
      CREATE TABLE IF NOT EXISTS user_departures (
        nick TEXT,
        platform TEXT,
        network TEXT,
        instance TEXT,
        channel TEXT,
        last_message TEXT,
        last_message_date TEXT,
        departure_date TEXT,
        departure_type TEXT,
        departure_reason TEXT,
        kicked_by TEXT,
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

    findUserInChannelStmt = db.prepare(`
      SELECT * FROM seen_users
      WHERE nick = @nick AND platform = @platform AND network = @network AND instance = @instance AND channel = @channel
      LIMIT 1
    `);

    findDepartureStmt = db.prepare(`
      SELECT * FROM user_departures
      WHERE nick = @nick AND platform = @platform AND network = @network AND instance = @instance
      ORDER BY departure_date DESC
      LIMIT 1
    `);

    findSeenUsersByNickStmt = db.prepare(`
      SELECT * FROM seen_users
      WHERE nick = @nick AND platform = @platform AND network = @network AND instance = @instance
    `);

    updateDepartureStmt = db.prepare(`
      INSERT INTO user_departures (nick, platform, network, instance, channel, last_message, last_message_date, departure_date, departure_type, departure_reason, kicked_by)
      VALUES (@nick, @platform, @network, @instance, @channel, @lastMessage, @lastMessageDate, @departureDate, @departureType, @departureReason, @kickedBy)
      ON CONFLICT(nick, platform, network, instance, channel) DO UPDATE SET
        last_message = excluded.last_message,
        last_message_date = excluded.last_message_date,
        departure_date = excluded.departure_date,
        departure_type = excluded.departure_type,
        departure_reason = excluded.departure_reason,
        kicked_by = excluded.kicked_by
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

/**
 * Find a seen_users record for a specific nick in a specific channel.
 * Used by handleDeparture to check if a user has spoken in a channel before recording a departure.
 */
export function findUserInChannel(nick: string, platform: string, network: string, instance: string, channel: string): { nick: string; date: string; text: string; platform: string; network: string; instance: string; channel: string } | undefined {
  if (!findUserInChannelStmt) throw new Error('Database not initialized');
  return findUserInChannelStmt.get({ nick, platform, network, instance, channel }) as { nick: string; date: string; text: string; platform: string; network: string; instance: string; channel: string } | undefined;
}

/**
 * Find the most recent departure record for a nick across all channels.
 * Used by the lastwords command to show a user's last departure.
 */
export function findDeparture(nick: string, platform: string, network: string, instance: string): { nick: string; platform: string; network: string; instance: string; channel: string; last_message: string; last_message_date: string; departure_date: string; departure_type: string; departure_reason: string; kicked_by: string | null } | undefined {
  if (!findDepartureStmt) throw new Error('Database not initialized');
  return findDepartureStmt.get({ nick, platform, network, instance }) as { nick: string; platform: string; network: string; instance: string; channel: string; last_message: string; last_message_date: string; departure_date: string; departure_type: string; departure_reason: string; kicked_by: string | null } | undefined;
}

/**
 * Find all seen_users rows for a nick across all channels.
 * Used by handleDeparture for quit events (channel is null) to record
 * a departure for each channel where the user was previously seen.
 */
export function findSeenUsersByNick(nick: string, platform: string, network: string, instance: string): Array<{ nick: string; date: string; text: string; platform: string; network: string; instance: string; channel: string }> {
  if (!findSeenUsersByNickStmt) throw new Error('Database not initialized');
  return findSeenUsersByNickStmt.all({ nick, platform, network, instance }) as Array<{ nick: string; date: string; text: string; platform: string; network: string; instance: string; channel: string }>;
}

/**
 * Update or insert a departure record.
 */
export function updateDeparture(data: {
  nick: string;
  platform: string;
  network: string;
  instance: string;
  channel: string;
  lastMessage: string;
  lastMessageDate: string;
  departureDate: string;
  departureType: string;
  departureReason: string;
  kickedBy: string | null;
}): void {
  if (!updateDepartureStmt) throw new Error('Database not initialized');
  updateDepartureStmt.run({
    nick: data.nick,
    platform: data.platform,
    network: data.network,
    instance: data.instance,
    channel: data.channel,
    lastMessage: data.lastMessage,
    lastMessageDate: data.lastMessageDate,
    departureDate: data.departureDate,
    departureType: data.departureType,
    departureReason: data.departureReason,
    kickedBy: data.kickedBy,
  });
}
