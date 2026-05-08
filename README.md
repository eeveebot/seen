# seen

> Tracks when users were last seen in chat channels.

## Overview

The **seen** module is a chat activity tracker for the eevee ecosystem. It passively observes all messages across connected channels and records each user's last activity — when they spoke and what they said. Users can then query this history to find out when someone was last active, who's been around recently, or who's been lurking.

Seen uses a SQLite database keyed by `(nick, platform, network, instance, channel)`, making it fully multi-platform aware. It works across IRC, Discord, and any connector the eevee router supports. On IRC, responses are colorized using semantic colors (cyan for nicks, green for timestamps, yellow for actions, blue for info).

The module registers a broadcast with the router to receive all messages, then upserts each event into the database. Commands are registered via NATS and routed through the standard eevee command pipeline with built-in rate limiting.

## Features

- **Passive tracking** — Records every user message across all platforms, networks, and channels automatically
- **Multi-platform** — Stores activity keyed by platform, network, instance, and channel
- **IRC colorization** — Semantic color coding for nicknames, timestamps, and actions on IRC platforms
- **Three query commands** — `seen`, `since`, `lurkers`, and `lurkers-report` for different views of activity data
- **Rate limited** — All commands respect configurable rate limits via libeevee defaults
- **Graceful shutdown** — Closes the SQLite database cleanly on termination
- **Migration support** — Includes a script to migrate from the old single-platform schema

## Install

This module is part of the eevee ecosystem and is not published independently.

```bash
# From the eevee project root
npm install
```

To build the seen module specifically:

```bash
cd seen
npm run build
```

## Configuration

Seen reads its configuration from the standard eevee module config via `loadModuleConfig`. The following options are available:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `ratelimit` | `RateLimitConfig` | `defaultRateLimit` | Rate limit settings for all seen commands |
| `dbPath` | `string` | *(auto)* | Override the database file path (default: `$MODULE_DATA/seen.db`) |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MODULE_DATA` | Yes | Directory where `seen.db` is stored. Created automatically if it doesn't exist. |

Other standard eevee environment variables (`NATS_URL`, etc.) are also required — see the main eevee documentation.

## Usage / Commands

### `seen <username>`

Show when a user was last seen and what they last said.

**Example:**

```
> seen alice
alice: [alice] [2026-05-07 14:32] [haha nice]
```

If the user has never been seen:

```
> seen bob
bob: I haven't seen bob yet
```

### `since <minutes>`

Show all users seen in the last X minutes. Maximum lookback is 1440 minutes (24 hours).

**Example:**

```
> since 60
alice: In the last 60 minutes, I've seen: alice, charlie, dave
```

If no one has been seen:

```
> since 5
alice: I haven't seen anyone yet
```

### `lurkers [days] [--limit N]`

Show users currently in the channel who haven't been seen in the specified number of days. This cross-references the seen database with the live channel user list (queried from the IRC connector) to find lurkers who are present but inactive.

| Parameter | Default | Max | Description |
|-----------|---------|-----|-------------|
| `days` | 30 | 365 | How far back to look for last activity |
| `--limit N` / `-l N` | 10 | 50 | Maximum number of results to return |

**Examples:**

```
> lurkers                      # Top 10 lurkers from the last 30 days
> lurkers 60                   # Top 10 lurkers from the last 60 days
> lurkers 30 --limit 5         # Top 5 lurkers from the last 30 days
> lurkers --limit 20           # Top 20 lurkers from the last 30 days
```

**Example output:**

```
alice: Top 10 lurkers not seen in the last 30 days (currently in channel): bob (45d), eve (never), frank (67d)
```

Users who are in the channel but have no record at all are shown as `(never)`.

### `lurkers-report [days]`

Comprehensive lurkers report — **admin only**. Unlike `lurkers`, this command shows *all* channel users (active, inactive, and never seen) and delivers the full report via private message, keeping the channel clean.

| Parameter | Default | Max | Description |
|-----------|---------|-----|-------------|
| `days` | 30 | 365 | How far back to look for last activity |

**Requirements:**
- You must be a channel admin (have `+o` mode) to run this command.
- The report is sent via private message — only you see it.

**Examples:**

```
> lurkers-report                 # Full report with 30-day window
> lurkers-report 7              # Full report with 7-day window
```

**Example output (via private message):**

```
=== Lurkers Report for #channel (30 day window) ===
Active users (seen within 30 days): alice (today), bob (5d ago), carol (today)
Inactive users (not seen in 30 days): dave (45d ago), eve (62d ago)
Never seen: frank, greg
Total: 7 users (3 active, 2 inactive, 2 never seen)
```

The channel receives a brief confirmation: `alice: Lurkers report sent via private message.`

## Architecture

```
┌─────────────┐   broadcast.register   ┌──────────┐
│  seen module ├───────────────────────►│  router  │
│  (startup)   │                       │          │
└──────┬───────┘                       └────┬─────┘
       │                                     │
       │  broadcast.message.<uuid>           │  command.execute.<uuid>
       │  (all chat messages)                │  (command invocations)
       ◄─────────────────────────────────────┤
       │                                     │
       ▼                                     │
┌──────────────┐                             │
│  SQLite DB   │                             │
│  (seen_users)│                             │
└──────────────┘                             │
                                             │
       ◄─────────────────────────────────────┘
       │
       │  queryChannelUsers()  (lurkers only)
       ├──────────────────────────────────────► IRC connector
       ◄──────────────────────────────────────┘
```

### Data Flow

1. **Startup** — The module creates a NATS connection, initializes the SQLite database, and registers a broadcast with the router to receive all chat messages.
2. **Message tracking** — Every broadcast message triggers an upsert into the `seen_users` table, recording the nick, timestamp, message text, platform, network, instance, and channel.
3. **Command handling** — Commands (`seen`, `since`, `lurkers`) are registered with the router. When invoked, they query the database and send a formatted response back to the channel.
4. **Lurkers** — The `lurkers` command additionally queries the IRC connector via `queryChannelUsers()` to get the current channel membership, then cross-references with the seen database.

### Database Schema

```sql
CREATE TABLE seen_users (
  nick     TEXT,
  date     TEXT,        -- ISO 8601 timestamp
  text     TEXT,        -- last message content
  platform TEXT,        -- e.g. "irc", "discord"
  network  TEXT,        -- e.g. "libera"
  instance TEXT,        -- e.g. "default"
  channel  TEXT,        -- e.g. "#general"
  PRIMARY KEY (nick, platform, network, instance, channel)
);
```

### Colorization

On IRC platforms, responses are colorized using a semantic color map defined in `src/utils/colorize.mts`:

| Semantic type | IRC color | Used for |
|--------------|-----------|----------|
| `user` | cyan | Nicknames |
| `date` | green | Timestamps, numeric values |
| `action` | yellow | Last message content |
| `info` | blue | Informational text |
| `warning` | olive | Error/usage messages |

Non-IRC platforms receive plain-text responses without color codes.

## Development

```bash
# Clone the repo and install
git clone <repo-url>
cd eevee
npm install

# Build the seen module
cd seen
npm run build

# Watch mode (build + run with hot reload)
npm run dev

# Lint
npm test
```

### Migration from Old Schema

If upgrading from a previous version of eeveebot that used the single-platform `seen` table, use the migration script:

```bash
node --loader ts-node/esm src/migrations/migrate-from-old-eeveebot.mts \
  ./old-seen.db ./seen.db irc libera default "#general"
```

Parameters:

| Position | Default | Description |
|----------|---------|-------------|
| `old-db-path` | *(required)* | Path to the old database |
| `new-db-path` | *(required)* | Path for the new database |
| `platform` | `irc` | Platform identifier |
| `network` | `unknown` | Network identifier |
| `instance` | `unknown` | Instance identifier |
| `channel` | `unknown` | Channel identifier |

## Contributing

Contributions are welcome! Bug reports and pull requests can be filed at the module's repository.

## License

[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) — see [LICENSE](./LICENSE) for the full text.
