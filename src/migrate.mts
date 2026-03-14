#!/usr/bin/env node

/**
 * Seen Database Migration Utility
 *
 * This script migrates seen data from the old SQLite database format
 * to the new database schema used by the modern seen module.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { exit } from 'node:process';

interface OldSeenRecord {
  nick: string;
  date: string;
  text: string;
}

interface NewSeenRecord {
  nick: string;
  date: string;
  text: string;
}

async function migrateDatabase(
  oldDbPath: string,
  newDbPath: string
): Promise<void> {
  console.log(`Migrating seen database from ${oldDbPath} to ${newDbPath}`);

  // Check if old database exists
  if (!existsSync(oldDbPath)) {
    console.error(`Old database file not found: ${oldDbPath}`);
    exit(1);
  }

  // Open both databases
  const oldDb = new Database(oldDbPath, { readonly: true });
  const newDb = new Database(newDbPath);

  try {
    // Create the new table schema
    newDb.exec(`
      CREATE TABLE IF NOT EXISTS seen_users (
        nick TEXT PRIMARY KEY,
        date TEXT,
        text TEXT
      );
    `);

    // Prepare insert statement for new database
    const insertStmt = newDb.prepare(`
      INSERT OR REPLACE INTO seen_users 
      (nick, date, text)
      VALUES (@nick, @date, @text)
    `);

    // Read all records from old database
    const selectStmt = oldDb.prepare('SELECT * FROM seen');
    const oldRecords = selectStmt.all() as OldSeenRecord[];

    console.log(`Found ${oldRecords.length} records to migrate`);

    // Begin transaction for better performance
    const insertTransaction = newDb.transaction((records: NewSeenRecord[]) => {
      for (const record of records) {
        insertStmt.run(record);
      }
    });

    // Transform and insert records (convert timestamp to ISO date string)
    const newRecords: NewSeenRecord[] = oldRecords.map((record) => {
      // Convert old timestamp format (milliseconds with .0 suffix) to ISO date string
      let isoDate = record.date;
      try {
        // Remove .0 suffix and parse as integer
        const timestampStr = record.date.replace('.0', '');
        const timestamp = parseInt(timestampStr, 10);
        if (!isNaN(timestamp)) {
          isoDate = new Date(timestamp).toISOString();
        }
      } catch (error) {
        console.warn(`Failed to convert timestamp for user ${record.nick}: ${record.date}`, error);
      }
      
      return {
        nick: record.nick,
        date: isoDate,
        text: record.text,
      };
    });

    // Insert all records in a transaction
    insertTransaction(newRecords);

    console.log(`Successfully migrated ${newRecords.length} records`);
  } catch (error) {
    console.error('Migration failed:', error);
    exit(1);
  } finally {
    oldDb.close();
    newDb.close();
  }
}

// Main execution
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log('Usage:');
    console.log('  migrate.mts <old-db-path> <new-db-path>');
    console.log('');
    console.log('Examples:');
    console.log('  migrate.mts ../old-eevee-bot/db/seen.sqlite ./seen.db');
    exit(1);
  }

  const oldDbPath = args[0];
  const newDbPath = args[1];

  await migrateDatabase(oldDbPath, newDbPath);

  console.log('Migration completed successfully!');
}

// Run the migration
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}