#!/usr/bin/env node

/**
 * Migration Script: Combine since_users into seen_users
 * 
 * This script combines the since_users table into the seen_users table
 * and adds platform, network, instance, and channel columns to track
 * where users were seen.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { exit } from 'node:process';

async function runMigration(dbPath: string): Promise<void> {
  console.log(`Running migration on database: ${dbPath}`);

  // Check if database exists
  if (!existsSync(dbPath)) {
    console.error(`Database file not found: ${dbPath}`);
    exit(1);
  }

  // Open database
  const db = new Database(dbPath);
  
  try {
    // Begin transaction
    db.exec('BEGIN TRANSACTION;');
    
    // Step 1: Add new columns to seen_users table
    console.log('Adding new columns to seen_users table...');
    db.exec(`
      ALTER TABLE seen_users 
      ADD COLUMN platform TEXT;
    `);
    
    db.exec(`
      ALTER TABLE seen_users 
      ADD COLUMN network TEXT;
    `);
    
    db.exec(`
      ALTER TABLE seen_users 
      ADD COLUMN instance TEXT;
    `);
    
    db.exec(`
      ALTER TABLE seen_users 
      ADD COLUMN channel TEXT;
    `);
    
    // Step 2: Copy data from since_users to seen_users
    console.log('Migrating data from since_users to seen_users...');
    
    // Check if since_users table exists before attempting to migrate data
    const sinceTableExists = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='since_users';
    `).get();
    
    if (sinceTableExists) {
      // Transfer all data from since_users to seen_users
      // Since we don't have the platform/network/instance/channel data in since_users,
      // we'll use placeholder values that can be updated when users are next seen
      const rowCount = db.prepare(`
        SELECT COUNT(*) as count FROM since_users;
      `).get() as { count: number };
      
      console.log(`Found ${rowCount.count} records in since_users to migrate`);
      
      db.exec(`
        INSERT INTO seen_users (nick, date, text, platform, network, instance, channel)
        SELECT nick, date, text, 'irc', 'unknown', 'unknown', 'unknown'
        FROM since_users
        WHERE nick IS NOT NULL;
      `);
      
      console.log('Data migration completed');
    } else {
      console.log('since_users table not found, skipping data migration');
    }
    console.log('Creating indexes...');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_seen_users_platform 
      ON seen_users(platform);
    `);
    
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_seen_users_network 
      ON seen_users(network);
    `);
    
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_seen_users_instance 
      ON seen_users(instance);
    `);
    
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_seen_users_channel 
      ON seen_users(channel);
    `);
    
    // Step 4: Drop the old since_users table since we've migrated all data
    if (sinceTableExists) {
      console.log('Dropping old since_users table...');
      db.exec('DROP TABLE IF EXISTS since_users;');
    }
    
    // Commit transaction
    db.exec('COMMIT;');
    
    console.log('Migration completed successfully!');
  } catch (error) {
    // Rollback transaction on error
    db.exec('ROLLBACK;');
    console.error('Migration failed:', error);
    exit(1);
  } finally {
    db.close();
  }
}

// Main execution
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log('Usage:');
    console.log('  001-combine-tables.mts <db-path>');
    console.log('');
    console.log('Examples:');
    console.log('  001-combine-tables.mts ./seen.db');
    exit(1);
  }
  
  const dbPath = args[0];
  
  await runMigration(dbPath);
}

// Run the migration
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}