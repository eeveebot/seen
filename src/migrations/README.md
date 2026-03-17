# Database Migrations

This directory contains scripts for migrating the seen module database schema.

## Migration 001: Combine since_users into seen_users

This migration combines the `since_users` table into the `seen_users` table and adds columns to track platform, network, instance, and channel information.

### Changes Made

1. Added new columns to `seen_users` table:
   - `platform` (TEXT)
   - `network` (TEXT)
   - `instance` (TEXT)
   - `channel` (TEXT)

2. Updated primary key to be composite:
   - `(nick, platform, network, instance, channel)`

3. Removed the separate `since_users` table

4. Updated indexes for better performance

### Automatic Migration

Migrations now run automatically when the module starts up. The module will detect if the database schema needs to be updated and apply the necessary changes automatically.

### Manual Migration (Optional)

If you prefer to run the migration manually, you can use the script:

```bash
node 001-combine-tables.mts /path/to/seen.db
```

### Important Notes

- The automatic migration will preserve all existing data
- Platform/network/instance/channel information for existing records will be set to 'unknown' initially
- This information will be populated as users are seen after the migration
- No restart is needed after automatic migration