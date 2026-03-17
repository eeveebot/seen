#!/usr/bin/env node

/**
 * Migration script for seen database
 * Transforms old schema to new schema with multi-platform support
 */

import fs from 'node:fs';
import Database from 'better-sqlite3';
import { log } from '@eeveebot/libeevee';

interface OldSeenRecord {
  nick: string;
  date: string;
  text: string;
}

interface NewSeenRecord {
  nick: string;
  date: string;
  text: string;
  platform: string;
  network: string;
  instance: string;
  channel: string;
}

/**
 * Migrates seen database from old schema to new schema
 * @param oldDbPath Path to the old database file
 * @param newDbPath Path to the new database file
 * @param platform Platform identifier (default: 'irc')
 * @param network Network identifier (default: 'unknown')
 * @param instance Instance identifier (default: 'default')
 * @param channel Channel identifier (default: '#general')
 */
async function migrateSeenDatabase(
  oldDbPath: string,
  newDbPath: string,
  platform = 'irc',
  network = 'unknown',
  instance = 'unknown',
  channel = 'unknown'
): Promise<void> {
  try {
    // Check if old database exists
    if (!fs.existsSync(oldDbPath)) {
      throw new Error(`Old database file not found: ${oldDbPath}`);
    }

    // Open databases
    const oldDb = new Database(oldDbPath, { readonly: true });
    const newDb = new Database(newDbPath);

    // Create new schema
    newDb.exec(`
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
    const oldStmt = oldDb.prepare('SELECT nick, date, text FROM seen');
    const newStmt = newDb.prepare(`
      INSERT INTO seen_users (nick, date, text, platform, network, instance, channel)
      VALUES (@nick, @date, @text, @platform, @network, @instance, @channel)
      ON CONFLICT(nick, platform, network, instance, channel) DO UPDATE SET
        date = excluded.date,
        text = excluded.text
    `);

    // Begin transaction
    const transaction = newDb.transaction((records: NewSeenRecord[]) => {
      for (const record of records) {
        newStmt.run(record);
      }
    });

    // Migrate data
    const oldRecords = oldStmt.all() as OldSeenRecord[];
    const newRecords: NewSeenRecord[] = oldRecords.map(record => ({
      nick: record.nick,
      date: record.date,
      text: record.text,
      platform,
      network,
      instance,
      channel
    }));

    // Execute transaction
    transaction(newRecords);

    // Close databases
    oldDb.close();
    newDb.close();

    log.info('Successfully migrated seen database', {
      producer: 'seen-migration',
      oldRecordCount: oldRecords.length,
      newRecordCount: newRecords.length
    });
  } catch (error) {
    log.error('Failed to migrate seen database', {
      producer: 'seen-migration',
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

// Command line interface
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log('Usage: migrate-seen-db.mts <old-db-path> <new-db-path> [platform] [network] [instance] [channel]');
    console.log('Example: migrate-seen-db.mts ./old-seen.db ./new-seen.db irc libera default #general');
    process.exit(1);
  }

  const oldDbPath = args[0];
  const newDbPath = args[1];
  const platform = args[2] || 'irc';
  const network = args[3] || 'unknown';
  const instance = args[4] || 'unknown';
  const channel = args[5] || 'unknown';

  try {
    await migrateSeenDatabase(oldDbPath, newDbPath, platform, network, instance, channel);
    console.log('Migration completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

// Execute if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}

export { migrateSeenDatabase };
