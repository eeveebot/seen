'use strict';

// Seen module
// Tracks when users were last seen and provides commands to check

import fs from 'node:fs';
import yaml from 'js-yaml';
import { NatsClient, log } from '@eeveebot/libeevee';
import Database from 'better-sqlite3';

// Record module startup time for uptime tracking
const moduleStartTime = Date.now();

const seenCommandUUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const seenCommandDisplayName = 'seen';

const sinceCommandUUID = 'f0e9d8c7-b6a5-4321-fedc-ba9876543210';
const sinceCommandDisplayName = 'since';

// Rate limit configuration interface
interface RateLimitConfig {
  mode: 'enqueue' | 'drop';
  level: 'channel' | 'user' | 'global';
  limit: number;
  interval: string; // e.g., "30s", "1m", "5m"
}

// Seen module configuration interface
interface SeenConfig {
  ratelimit?: RateLimitConfig;
  dbPath?: string;
}

const natsClients: InstanceType<typeof NatsClient>[] = [];
const natsSubscriptions: Array<Promise<string | boolean>> = [];

// Database instance
let db: Database.Database | null = null;

/**
 * Load seen configuration from YAML file
 * @returns SeenConfig parsed from YAML file
 */
function loadSeenConfig(): SeenConfig {
  // Get the config file path from environment variable
  const configPath = process.env.MODULE_CONFIG_PATH;
  if (!configPath) {
    log.warn('MODULE_CONFIG_PATH not set, using default config', {
      producer: 'seen',
    });
    return {};
  }

  try {
    // Read the YAML file
    const configFile = fs.readFileSync(configPath, 'utf8');

    // Parse the YAML content
    const config = yaml.load(configFile) as SeenConfig;

    log.info('Loaded seen configuration', {
      producer: 'seen',
      configPath,
    });

    return config;
  } catch (error) {
    log.error('Failed to load seen configuration, using defaults', {
      producer: 'seen',
      configPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

//
// Do whatever teardown is necessary before calling common handler
process.on('SIGINT', () => {
  if (db) {
    db.close();
  }
  natsClients.forEach((natsClient) => {
    void natsClient.drain();
  });
});

process.on('SIGTERM', () => {
  if (db) {
    db.close();
  }
  natsClients.forEach((natsClient) => {
    void natsClient.drain();
  });
});

//
// Setup NATS connection

// Get host and token
const natsHost = process.env.NATS_HOST || false;
if (!natsHost) {
  const msg = 'environment variable NATS_HOST is not set.';
  throw new Error(msg);
}

const natsToken = process.env.NATS_TOKEN || false;
if (!natsToken) {
  const msg = 'environment variable NATS_TOKEN is not set.';
  throw new Error(msg);
}

const nats = new NatsClient({
  natsHost: natsHost as string,
  natsToken: natsToken as string,
});
natsClients.push(nats);
await nats.connect();

// Load configuration at startup
const seenConfig = loadSeenConfig();

// Initialize database
function initDatabase(): void {
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
        nick TEXT PRIMARY KEY,
        date TEXT,
        text TEXT
      );
    `);

    // Create table for since tracking
    db.exec(`
      CREATE TABLE IF NOT EXISTS since_users (
        nick TEXT PRIMARY KEY,
        date_seen INTEGER
      );
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

// Initialize database at startup
initDatabase();

// Prepared statements for database operations
const findUserStmt = db!.prepare(`
  SELECT * FROM seen_users WHERE nick = @nick
`);

const updateUserStmt = db!.prepare(`
  INSERT INTO seen_users (nick, date, text)
  VALUES (@nick, @date, @text)
  ON CONFLICT(nick) DO UPDATE SET
    date = excluded.date,
    text = excluded.text
`);

const findUsersSinceStmt = db!.prepare(`
  SELECT nick FROM since_users WHERE date_seen >= @sinceTime
`);

const updateSinceUserStmt = db!.prepare(`
  INSERT INTO since_users (nick, date_seen)
  VALUES (@nick, @dateSeen)
  ON CONFLICT(nick) DO UPDATE SET
    date_seen = excluded.date_seen
`);

// Function to register the seen command with the router
async function registerSeenCommand(): Promise<void> {
  // Default rate limit configuration
  const defaultRateLimit = {
    mode: 'drop',
    level: 'user',
    limit: 5,
    interval: '1m',
  };

  // Use configured rate limit or default
  const rateLimitConfig = seenConfig.ratelimit || defaultRateLimit;

  const commandRegistration = {
    type: 'command.register',
    commandUUID: seenCommandUUID,
    commandDisplayName: seenCommandDisplayName,
    platform: '.*', // Match all platforms
    network: '.*', // Match all networks
    instance: '.*', // Match all instances
    channel: '.*', // Match all channels
    user: '.*', // Match all users
    regex: '^seen\\s+', // Match seen followed by whitespace
    platformPrefixAllowed: true,
    ratelimit: rateLimitConfig,
  };

  try {
    await nats.publish('command.register', JSON.stringify(commandRegistration));
    log.info('Registered seen command with router', {
      producer: 'seen',
      ratelimit: rateLimitConfig,
    });
  } catch (error) {
    log.error('Failed to register seen command', {
      producer: 'seen',
      error: error,
    });
  }
}

// Function to register the since command with the router
async function registerSinceCommand(): Promise<void> {
  // Default rate limit configuration
  const defaultRateLimit = {
    mode: 'drop',
    level: 'user',
    limit: 5,
    interval: '1m',
  };

  // Use configured rate limit or default
  const rateLimitConfig = seenConfig.ratelimit || defaultRateLimit;

  const commandRegistration = {
    type: 'command.register',
    commandUUID: sinceCommandUUID,
    commandDisplayName: sinceCommandDisplayName,
    platform: '.*', // Match all platforms
    network: '.*', // Match all networks
    instance: '.*', // Match all instances
    channel: '.*', // Match all channels
    user: '.*', // Match all users
    regex: '^since\\s+', // Match since followed by whitespace
    platformPrefixAllowed: true,
    ratelimit: rateLimitConfig,
  };

  try {
    await nats.publish('command.register', JSON.stringify(commandRegistration));
    log.info('Registered since command with router', {
      producer: 'seen',
      ratelimit: rateLimitConfig,
    });
  } catch (error) {
    log.error('Failed to register since command', {
      producer: 'seen',
      error: error,
    });
  }
}

// Register commands at startup
await registerSeenCommand();
await registerSinceCommand();

// Subscribe to seen command execution messages
const seenCommandSub = nats.subscribe(
  `command.execute.${seenCommandUUID}`,
  (subject, message) => {
    try {
      const data = JSON.parse(message.string());
      log.info('Received command.execute for seen', {
        producer: 'seen',
        platform: data.platform,
        instance: data.instance,
        channel: data.channel,
        user: data.user,
        originalText: data.originalText,
      });

      // Parse the command: seen <username>
      const parts = data.text.trim().split(/\s+/);
      if (parts.length < 1) {
        const errorMsg = {
          channel: data.channel,
          network: data.network,
          instance: data.instance,
          platform: data.platform,
          text: `${data.user}: Usage: seen <username>`,
          trace: data.trace,
          type: 'message.outgoing',
        };

        const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
        void nats.publish(outgoingTopic, JSON.stringify(errorMsg));
        return;
      }

      const targetUser = parts[0].toLowerCase();

      // Find user in database
      const userData = findUserStmt.get({ nick: targetUser }) as
        | { date: string; text: string }
        | undefined;

      if (!userData) {
        const response = {
          channel: data.channel,
          network: data.network,
          instance: data.instance,
          platform: data.platform,
          text: `${data.user}: I haven't seen ${targetUser} yet`,
          trace: data.trace,
          type: 'message.outgoing',
        };

        const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
        void nats.publish(outgoingTopic, JSON.stringify(response));
        return;
      }

      // Format the date
      const date = new Date(userData.date);
      const displayDate = date.toISOString().substring(0, 10);
      const displayTime = date.toISOString().substring(11, 16);

      const response = {
        channel: data.channel,
        network: data.network,
        instance: data.instance,
        platform: data.platform,
        text: `${data.user}: [${targetUser}] [${displayDate} ${displayTime}] [${userData.text}]`,
        trace: data.trace,
        type: 'message.outgoing',
      };

      const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
      void nats.publish(outgoingTopic, JSON.stringify(response));
    } catch (error) {
      log.error('Failed to process seen command', {
        producer: 'seen',
        error: error,
      });
    }
  }
);
natsSubscriptions.push(seenCommandSub);

// Subscribe to since command execution messages
const sinceCommandSub = nats.subscribe(
  `command.execute.${sinceCommandUUID}`,
  (subject, message) => {
    try {
      const data = JSON.parse(message.string());
      log.info('Received command.execute for since', {
        producer: 'seen',
        platform: data.platform,
        instance: data.instance,
        channel: data.channel,
        user: data.user,
        originalText: data.originalText,
      });

      // Parse the command: since <minutes>
      const parts = data.text.trim().split(/\s+/);
      if (parts.length < 1) {
        const errorMsg = {
          channel: data.channel,
          network: data.network,
          instance: data.instance,
          platform: data.platform,
          text: `${data.user}: Usage: since <minutes>`,
          trace: data.trace,
          type: 'message.outgoing',
        };

        const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
        void nats.publish(outgoingTopic, JSON.stringify(errorMsg));
        return;
      }

      const minutes = parseInt(parts[0]);
      if (isNaN(minutes)) {
        const errorMsg = {
          channel: data.channel,
          network: data.network,
          instance: data.instance,
          platform: data.platform,
          text: `${data.user}: Please provide a valid number of minutes`,
          trace: data.trace,
          type: 'message.outgoing',
        };

        const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
        void nats.publish(outgoingTopic, JSON.stringify(errorMsg));
        return;
      }

      // Cap at 1440 minutes (24 hours)
      const lookbackMinutes = Math.min(minutes, 1440);
      const sinceTime = Date.now() - lookbackMinutes * 60000;

      // Find users seen since the specified time
      const users = findUsersSinceStmt.all({ sinceTime }) as Array<{ nick: string }>;

      let responseText = '';
      if (users.length === 0) {
        responseText = `${data.user}: I haven't seen anyone yet`;
      } else {
        const userList = users.map(u => u.nick).join(', ');
        responseText = `${data.user}: In the last ${lookbackMinutes} minutes, I've seen: ${userList}`;
      }

      const response = {
        channel: data.channel,
        network: data.network,
        instance: data.instance,
        platform: data.platform,
        text: responseText,
        trace: data.trace,
        type: 'message.outgoing',
      };

      const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
      void nats.publish(outgoingTopic, JSON.stringify(response));
    } catch (error) {
      log.error('Failed to process since command', {
        producer: 'seen',
        error: error,
      });
    }
  }
);
natsSubscriptions.push(sinceCommandSub);

// Subscribe to incoming messages to track user activity
const incomingMessageSub = nats.subscribe(
  'chat.message.incoming.*.*.*',
  (subject, message) => {
    try {
      const data = JSON.parse(message.string());
      log.debug('Received incoming message for seen tracking', {
        producer: 'seen',
        platform: data.platform,
        instance: data.instance,
        channel: data.channel,
        user: data.user,
      });

      // Update seen database
      const seenData = {
        nick: data.user.toLowerCase(),
        date: new Date().toISOString(),
        text: data.text,
      };
      updateUserStmt.run(seenData);

      // Update since database
      const sinceData = {
        nick: data.user.toLowerCase(),
        dateSeen: Date.now(),
      };
      updateSinceUserStmt.run(sinceData);
    } catch (error) {
      log.error('Failed to process incoming message for seen tracking', {
        producer: 'seen',
        error: error,
      });
    }
  }
);
natsSubscriptions.push(incomingMessageSub);

// Subscribe to control messages for re-registering commands
const controlSubRegisterCommandSeen = nats.subscribe(
  `control.registerCommands.${seenCommandDisplayName}`,
  () => {
    log.info(
      `Received control.registerCommands.${seenCommandDisplayName} control message`,
      {
        producer: 'seen',
      }
    );
    void registerSeenCommand();
  }
);
natsSubscriptions.push(controlSubRegisterCommandSeen);

const controlSubRegisterCommandSince = nats.subscribe(
  `control.registerCommands.${sinceCommandDisplayName}`,
  () => {
    log.info(
      `Received control.registerCommands.${sinceCommandDisplayName} control message`,
      {
        producer: 'seen',
      }
    );
    void registerSinceCommand();
  }
);
natsSubscriptions.push(controlSubRegisterCommandSince);

const controlSubRegisterCommandAll = nats.subscribe(
  'control.registerCommands',
  () => {
    log.info('Received control.registerCommands control message', {
      producer: 'seen',
    });
    void registerSeenCommand();
    void registerSinceCommand();
  }
);
natsSubscriptions.push(controlSubRegisterCommandAll);

// Subscribe to stats.uptime messages and respond with module uptime
const statsUptimeSub = nats.subscribe('stats.uptime', (subject, message) => {
  try {
    const data = JSON.parse(message.string());
    log.info('Received stats.uptime request', {
      producer: 'seen',
      replyChannel: data.replyChannel,
    });

    // Calculate uptime in milliseconds
    const uptime = Date.now() - moduleStartTime;

    // Send uptime back via the ephemeral reply channel
    const uptimeResponse = {
      module: 'seen',
      uptime: uptime,
      uptimeFormatted: `${Math.floor(uptime / 86400000)}d ${Math.floor((uptime % 86400000) / 3600000)}h ${Math.floor((uptime % 3600000) / 60000)}m ${Math.floor((uptime % 60000) / 1000)}s`,
    };

    if (data.replyChannel) {
      void nats.publish(data.replyChannel, JSON.stringify(uptimeResponse));
    }
  } catch (error) {
    log.error('Failed to process stats.uptime request', {
      producer: 'seen',
      error: error,
    });
  }
});
natsSubscriptions.push(statsUptimeSub);

// Help information for seen commands
const seenHelp = [
  {
    command: 'seen',
    descr: 'Show when a user was last seen',
    params: [
      {
        param: 'user',
        required: true,
        descr: 'The user to look for',
      },
    ],
  },
  {
    command: 'since',
    descr: 'Show users seen in the last X minutes',
    params: [
      {
        param: 'minutes',
        required: true,
        descr: 'The amount of time to look back (max 1440 minutes)',
      },
    ],
  },
];

// Function to publish help information
async function publishHelp(): Promise<void> {
  const helpUpdate = {
    from: 'seen',
    help: seenHelp,
  };

  try {
    await nats.publish('help.update', JSON.stringify(helpUpdate));
    log.info('Published seen help information', {
      producer: 'seen',
    });
  } catch (error) {
    log.error('Failed to publish seen help information', {
      producer: 'seen',
      error: error,
    });
  }
}

// Publish help information at startup
await publishHelp();

// Subscribe to help update requests
const helpUpdateRequestSub = nats.subscribe('help.updateRequest', () => {
  log.info('Received help.updateRequest message', {
    producer: 'seen',
  });
  void publishHelp();
});
natsSubscriptions.push(helpUpdateRequestSub);