'use strict';

// Seen module
// Tracks when users were last seen and provides commands to check

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import { NatsClient, log } from '@eeveebot/libeevee';
import Database from 'better-sqlite3';
import { colorizeSeen } from './utils/colorize.mjs';

// Record module startup time for uptime tracking
const moduleStartTime = Date.now();

const seenCommandUUID = '6ea5d8c9-17e7-4348-b205-43d88ddfe0bf';
const seenCommandDisplayName = 'seen';

const sinceCommandUUID = 'eec16230-25ac-4c6b-84fd-feacf7753c7d';
const sinceCommandDisplayName = 'since';

const lurkersCommandUUID = '19cc2f13-e899-404c-b02e-0bbd9148ba73';
const lurkersCommandDisplayName = 'lurkers';

const seenBroadcastUUID = 'd3a0ee0a-32e3-4613-bcdd-736c52e38e81';
const seenBroadcastDisplayName = 'seen';

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
  ORDER BY date DESC
  LIMIT 1
`);

const updateSeenUserStmt = db!.prepare(`
  INSERT INTO seen_users (nick, date, text, platform, network, instance, channel)
  VALUES (@nick, @date, @text, @platform, @network, @instance, @channel)
  ON CONFLICT(nick, platform, network, instance, channel) DO UPDATE SET
    date = excluded.date,
    text = excluded.text
`);

const findUsersSinceStmt = db!.prepare(`
  SELECT DISTINCT nick FROM seen_users WHERE date >= @sinceTime
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
    nick: '.*', // Match all nicks
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
    nick: '.*', // Match all nicks
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

// Function to register the lurkers command with the router
async function registerLurkersCommand(): Promise<void> {
  // Default rate limit configuration
  const defaultRateLimit = {
    mode: 'drop',
    level: 'user',
    limit: 10,
    interval: '1m',
  };

  // Use configured rate limit or default
  const rateLimitConfig = seenConfig.ratelimit || defaultRateLimit;

  const commandRegistration = {
    type: 'command.register',
    commandUUID: lurkersCommandUUID,
    commandDisplayName: lurkersCommandDisplayName,
    platform: '.*', // Match all platforms
    network: '.*', // Match all networks
    instance: '.*', // Match all instances
    channel: '.*', // Match all channels
    user: '.*', // Match all users
    nick: '.*', // Match all nicks
    regex: '^lurkers\\s*', // Match lurkers command
    platformPrefixAllowed: true,
    ratelimit: rateLimitConfig,
  };

  try {
    await nats.publish('command.register', JSON.stringify(commandRegistration));
    log.info('Registered lurkers command with router', {
      producer: 'seen',
      ratelimit: rateLimitConfig,
    });
  } catch (error) {
    log.error('Failed to register lurkers command', {
      producer: 'seen',
      error: error,
    });
  }
}

// Function to register the seen broadcast with the router
async function registerSeenBroadcast(): Promise<void> {
  const broadcastRegistration = {
    type: 'broadcast.register',
    broadcastUUID: seenBroadcastUUID,
    broadcastDisplayName: seenBroadcastDisplayName,
    platform: '.*', // Match all platforms
    network: '.*', // Match all networks
    instance: '.*', // Match all instances
    channel: '.*', // Match all channels
    user: '.*', // Match all users
    nick: '.*', // Match all nicks
    messageFilterRegex: '.*', // Match all messages
    ttl: 120000, // 2 minutes TTL
  };

  try {
    await nats.publish(
      'broadcast.register',
      JSON.stringify(broadcastRegistration)
    );
    log.info('Registered seen broadcast with router', {
      producer: 'seen',
    });
  } catch (error) {
    log.error('Failed to register seen broadcast', {
      producer: 'seen',
      error: error,
    });
  }
}

// Register broadcast at startup
await registerSeenBroadcast();

// Register commands at startup
await registerSeenCommand();
await registerSinceCommand();
await registerLurkersCommand();

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
        const userText = colorizeSeen(data.user, data.platform, 'user');
        const usageText = colorizeSeen(
          'Usage: seen <username>',
          data.platform,
          'warning'
        );
        const errorMsg = {
          channel: data.channel,
          network: data.network,
          instance: data.instance,
          platform: data.platform,
          text: `${userText}: ${usageText}`,
          trace: data.trace,
          type: 'message.outgoing',
        };

        const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
        void nats.publish(outgoingTopic, JSON.stringify(errorMsg));
        return;
      }

      const targetUser = parts[0].toLowerCase();

      // Find user in database
      log.debug('Searching for user in database', {
        producer: 'seen',
        targetUser,
      });
      const userData = findUserStmt.get({ nick: targetUser }) as
        | { date: string; text: string }
        | undefined;
      log.debug('Database query result', {
        producer: 'seen',
        userData,
      });

      if (!userData) {
        const userText = colorizeSeen(data.user, data.platform, 'user');
        const targetUserText = colorizeSeen(
          targetUser,
          data.platform,
          'warning'
        );
        const responseText = colorizeSeen(
          `I haven't seen ${targetUserText} yet`,
          data.platform,
          'info'
        );

        const response = {
          channel: data.channel,
          network: data.network,
          instance: data.instance,
          platform: data.platform,
          text: `${userText}: ${responseText}`,
          trace: data.trace,
          type: 'message.outgoing',
        };

        const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
        void nats.publish(outgoingTopic, JSON.stringify(response));
        return;
      }

      // Format the date
      log.debug('Formatting date', {
        producer: 'seen',
        dateValue: userData.date,
      });

      let date: Date;
      try {
        date = new Date(userData.date);
        if (isNaN(date.getTime())) {
          throw new Error('Invalid date');
        }
      } catch {
        log.warn('Invalid date format in database, using current date', {
          producer: 'seen',
          storedDate: userData.date,
        });
        date = new Date();
      }

      const displayDate = date.toISOString().substring(0, 10);
      const displayTime = date.toISOString().substring(11, 16);

      // Colorize different parts of the response
      const userText = colorizeSeen(data.user, data.platform, 'user');
      const targetUserText = colorizeSeen(targetUser, data.platform, 'user');
      const dateTimeText = colorizeSeen(
        `${displayDate} ${displayTime}`,
        data.platform,
        'date'
      );
      const actionText = colorizeSeen(userData.text, data.platform, 'action');

      const response = {
        channel: data.channel,
        network: data.network,
        instance: data.instance,
        platform: data.platform,
        text: `${userText}: [${targetUserText}] [${dateTimeText}] [${actionText}]`,
        trace: data.trace,
        type: 'message.outgoing',
      };

      const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
      void nats.publish(outgoingTopic, JSON.stringify(response));
    } catch (error) {
      log.error('Failed to process seen command', {
        producer: 'seen',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
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
        const userText = colorizeSeen(data.user, data.platform, 'user');
        const usageText = colorizeSeen(
          'Usage: since <minutes>',
          data.platform,
          'warning'
        );
        const errorMsg = {
          channel: data.channel,
          network: data.network,
          instance: data.instance,
          platform: data.platform,
          text: `${userText}: ${usageText}`,
          trace: data.trace,
          type: 'message.outgoing',
        };

        const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
        void nats.publish(outgoingTopic, JSON.stringify(errorMsg));
        return;
      }

      const minutes = parseInt(parts[0]);
      if (isNaN(minutes)) {
        const userText = colorizeSeen(data.user, data.platform, 'user');
        const errorText = colorizeSeen(
          'Please provide a valid number of minutes',
          data.platform,
          'warning'
        );
        const errorMsg = {
          channel: data.channel,
          network: data.network,
          instance: data.instance,
          platform: data.platform,
          text: `${userText}: ${errorText}`,
          trace: data.trace,
          type: 'message.outgoing',
        };

        const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
        void nats.publish(outgoingTopic, JSON.stringify(errorMsg));
        return;
      }

      // Cap at 1440 minutes (24 hours)
      const lookbackMinutes = Math.min(minutes, 1440);
      const sinceTime = new Date(
        Date.now() - lookbackMinutes * 60000
      ).toISOString();

      // Find users seen since the specified time
      const users = findUsersSinceStmt.all({ sinceTime }) as Array<{
        nick: string;
      }>;

      // Colorize the response
      const userText = colorizeSeen(data.user, data.platform, 'user');
      let responseText = '';

      if (users.length === 0) {
        const infoText = colorizeSeen(
          "I haven't seen anyone yet",
          data.platform,
          'info'
        );
        responseText = `${userText}: ${infoText}`;
      } else {
        const minutesText = colorizeSeen(
          lookbackMinutes.toString(),
          data.platform,
          'date'
        );
        const userList = users
          .map((u) => colorizeSeen(u.nick, data.platform, 'user'))
          .join(', ');
        const infoText = colorizeSeen(
          `In the last ${minutesText} minutes, I've seen:`,
          data.platform,
          'info'
        );
        responseText = `${userText}: ${infoText} ${userList}`;
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

// Global map to store pending user list requests for lurkers command
const pendingUserRequests = new Map<
  string,
  {
    resolve: (
      users: Array<{
        nick: string;
        ident: string;
        hostname: string;
        modes: string[];
      }>
    ) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }
>();

// Helper function to get users in a channel by querying the IRC connector
async function getUsersInChannel(
  platform: string,
  instance: string,
  channel: string,
  nats: InstanceType<typeof NatsClient>
): Promise<
  Array<{ nick: string; ident: string; hostname: string; modes: string[] }>
> {
  return new Promise((resolve, reject) => {
    // Generate a unique reply channel
    const replyChannel = `seen.userlist.reply.${randomUUID()}`;

    // Set up timeout
    const timeout = setTimeout(() => {
      // Clean up the pending request
      pendingUserRequests.delete(replyChannel);

      reject(new Error('Timeout waiting for user list'));
    }, 5000); // 5 second timeout

    // Store the promise resolver
    pendingUserRequests.set(replyChannel, { resolve, reject, timeout });

    // Subscribe to the reply channel
    void nats
      .subscribe(replyChannel, (subject, message) => {
        try {
          // Clean up the pending request
          const request = pendingUserRequests.get(replyChannel);
          if (request) {
            clearTimeout(request.timeout);
            pendingUserRequests.delete(replyChannel);
          }

          // Parse the response
          const response = JSON.parse(message.string());

          // Check if there was an error
          if (response.error) {
            reject(new Error(response.error));
            return;
          }

          // Return full user objects with hostmask information
          resolve(response.users);
        } catch (error) {
          log.error('Failed to process user list response', {
            producer: 'seen',
            error: error instanceof Error ? error.message : String(error),
          });
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })
      .catch((error) => {
        log.error('Failed to subscribe to user list reply channel', {
          producer: 'seen',
          error: error instanceof Error ? error.message : String(error),
        });
        reject(error instanceof Error ? error : new Error(String(error)));
      });

    // Send the control command to the IRC connector
    const controlMessage = {
      action: 'list-users-in-channel',
      data: {
        channel: channel,
        replyChannel: replyChannel,
      },
    };

    const controlTopic = `control.chatConnectors.${platform}.${instance}`;
    void nats.publish(controlTopic, JSON.stringify(controlMessage));
  });
}

// Subscribe to lurkers command execution messages
const lurkersCommandSub = nats.subscribe(
  `command.execute.${lurkersCommandUUID}`,
  async (subject, message) => {
    try {
      const data = JSON.parse(message.string());
      log.info('Received command.execute for lurkers', {
        producer: 'seen',
        platform: data.platform,
        instance: data.instance,
        channel: data.channel,
        user: data.user,
        originalText: data.originalText,
      });

      // Parse the command: lurkers [days] [--limit N]
      const args = data.text.trim();
      let days = 30; // Default to 30 days
      let limit = 10; // Default limit

      // Extract days parameter (first numeric value)
      const daysMatch = args.match(/^(\d+)/);
      if (daysMatch) {
        const daysParam = parseInt(daysMatch[1]);
        days = isNaN(daysParam) ? 30 : Math.max(1, Math.min(daysParam, 5000)); // Clamp between 1-5000
      }

      // Extract limit parameter (--limit N or -l N)
      const limitMatch = args.match(/(?:--limit|-l)\s+(\d+)/);
      if (limitMatch) {
        const limitParam = parseInt(limitMatch[1]);
        limit = isNaN(limitParam) ? 10 : Math.max(1, Math.min(limitParam, 500)); // Clamp between 1-500
      }

      const cutoffTime = new Date(
        Date.now() - days * 24 * 60 * 60 * 1000
      ).toISOString();

      // Get current users in channel
      let currentUsers: Array<{
        nick: string;
        ident: string;
        hostname: string;
        modes: string[];
      }> = [];
      try {
        currentUsers = await getUsersInChannel(
          data.platform,
          data.instance,
          data.channel,
          nats
        );
        log.debug('Retrieved user list from IRC connector', {
          producer: 'seen',
          channel: data.channel,
          userCount: currentUsers.length,
          users: currentUsers.map((u) => u.nick),
        });
      } catch (error) {
        log.error('Failed to get user list', {
          producer: 'seen',
          channel: data.channel,
          error: error instanceof Error ? error.message : String(error),
        });
        const userText = colorizeSeen(data.user, data.platform, 'user');
        const errorText = colorizeSeen(
          'Failed to retrieve user list from IRC connector',
          data.platform,
          'warning'
        );
        const errorMsg = {
          channel: data.channel,
          network: data.network,
          instance: data.instance,
          platform: data.platform,
          text: `${userText}: ${errorText}`,
          trace: data.trace,
          type: 'message.outgoing',
        };

        const outgoingTopic = `chat.message.outgoing.${data.platform}.${data.instance}.${data.channel}`;
        void nats.publish(outgoingTopic, JSON.stringify(errorMsg));
        return;
      }

      // Get nicknames of current users for filtering
      const currentUserNicks = new Set(
        currentUsers.map((user) => user.nick.toLowerCase())
      );

      // Find users in database who haven't been seen since cutoff time AND are currently in channel
      const stmt = db!.prepare(`
        SELECT nick, date FROM seen_users
        WHERE date < @cutoffTime AND channel = @channel AND platform = @platform AND instance = @instance AND network = @network
        ORDER BY date ASC
        LIMIT @limit
      `);

      // Get all users who haven't been seen since cutoff time
      const allOldUsers = stmt.all({
        cutoffTime,
        channel: data.channel,
        platform: data.platform,
        instance: data.instance,
        network: data.network,
      }) as Array<{ nick: string; date: string }>;

      // Filter to only include users currently in channel
      const oldUsers = allOldUsers.filter((user) =>
        currentUserNicks.has(user.nick.toLowerCase())
      ).slice(0, limit);

      // Find users who are currently in channel but not in database (never seen)
      const unseenUsers: Array<{ nick: string; date: string }> = [];
      const maxUnseenUsers = Math.max(0, limit - oldUsers.length);

      if (maxUnseenUsers > 0) {
        // Query database for all users in this channel to exclude them from unseen users
        const allChannelUsersStmt = db!.prepare(`
          SELECT DISTINCT nick FROM seen_users
          WHERE channel = @channel AND platform = @platform AND instance = @instance AND network = @network
        `);

        const seenUsers = allChannelUsersStmt.all({
          channel: data.channel,
          platform: data.platform,
          instance: data.instance,
          network: data.network,
        }) as Array<{ nick: string }>;

        const seenUserNicks = new Set(
          seenUsers.map((user) => user.nick.toLowerCase())
        );

        // Add currently present users who have never been seen to the unseen list
        for (const currentUser of currentUsers) {
          if (unseenUsers.length >= maxUnseenUsers) break;

          const lowerNick = currentUser.nick.toLowerCase();
          if (!seenUserNicks.has(lowerNick)) {
            unseenUsers.push({
              nick: currentUser.nick,
              date: new Date(0).toISOString(), // Epoch time for "never seen"
            });
          }
        }
      }

      // Combine old users and unseen users
      const lurkersInChannel = [...oldUsers, ...unseenUsers];

      // Colorize the response
      const userText = colorizeSeen(data.user, data.platform, 'user');
      let responseText = '';

      if (lurkersInChannel.length === 0) {
        const infoText = colorizeSeen(
          `No lurkers found in the last ${days} days`,
          data.platform,
          'info'
        );
        responseText = `${userText}: ${infoText}`;
      } else {
        const daysText = colorizeSeen(days.toString(), data.platform, 'date');
        const limitText = colorizeSeen(limit.toString(), data.platform, 'date');
        const lurkerList = lurkersInChannel
          .map((user) => {
            const nickText = colorizeSeen(user.nick, data.platform, 'user');
            const lastSeenDate = new Date(user.date);

            // For users never seen (epoch time), show "never"
            if (lastSeenDate.getTime() === 0) {
              const neverText = colorizeSeen('never', data.platform, 'date');
              return `${nickText} (${neverText})`;
            } else {
              // For users seen long ago, show days ago
              const diffTime = Math.abs(Date.now() - lastSeenDate.getTime());
              const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
              const daysAgoText = colorizeSeen(
                `${diffDays}d`,
                data.platform,
                'date'
              );
              return `${nickText} (${daysAgoText})`;
            }
          })
          .join(', ');

        const infoText = colorizeSeen(
          `Top ${limitText} lurkers not seen in the last ${daysText} days (currently in channel):`,
          data.platform,
          'info'
        );
        responseText = `${userText}: ${infoText} ${lurkerList}`;
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
      log.error('Failed to process lurkers command', {
        producer: 'seen',
        error: error,
      });
    }
  }
);
natsSubscriptions.push(lurkersCommandSub);

// Subscribe to broadcast messages to track user activity
  const seenBroadcastSub = nats.subscribe(
    `broadcast.message.${seenBroadcastUUID}`,
    (subject, message) => {
      try {
        const data = JSON.parse(message.string());
        log.debug('Received broadcast.message for seen tracking', {
          producer: 'seen',
          platform: data.platform,
          instance: data.instance,
          channel: data.channel,
          user: data.user,
        });

      // Update seen database with platform/network/instance/channel information
      const seenData = {
        nick: data.nick?.toLowerCase() || '',
        date: new Date().toISOString(),
        text: data.text,
        platform: data.platform,
        network: data.network,
        instance: data.instance,
        channel: data.channel,
      };
        updateSeenUserStmt.run(seenData);
      } catch (error) {
        log.error('Failed to process broadcast message for seen tracking', {
          producer: 'seen',
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    }
  );
natsSubscriptions.push(seenBroadcastSub);

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
    void registerLurkersCommand();
  }
);
natsSubscriptions.push(controlSubRegisterCommandAll);

// Subscribe to control messages for re-registering lurkers command
const controlSubRegisterCommandLurkers = nats.subscribe(
  `control.registerCommands.${lurkersCommandDisplayName}`,
  () => {
    log.info(
      `Received control.registerCommands.${lurkersCommandDisplayName} control message`,
      {
        producer: 'seen',
      }
    );
    void registerLurkersCommand();
  }
);
natsSubscriptions.push(controlSubRegisterCommandLurkers);

// Subscribe to control messages for re-registering broadcasts
const controlSubRegisterBroadcastSeen = nats.subscribe(
  `control.registerBroadcasts.${seenBroadcastDisplayName}`,
  () => {
    log.info(
      `Received control.registerBroadcasts.${seenBroadcastDisplayName} control message`,
      {
        producer: 'seen',
      }
    );
    void registerSeenBroadcast();
  }
);
natsSubscriptions.push(controlSubRegisterBroadcastSeen);

const controlSubRegisterBroadcastAll = nats.subscribe(
  'control.registerBroadcasts',
  () => {
    log.info('Received control.registerBroadcasts control message', {
      producer: 'seen',
    });
    void registerSeenBroadcast();
  }
);
natsSubscriptions.push(controlSubRegisterBroadcastAll);

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
  {
    command: 'lurkers',
    descr: "Show users who haven't been seen in X days",
    params: [
      {
        param: 'days',
        required: false,
        descr: 'The number of days to look back (default 30, max 365)',
      },
      {
        param: '--limit N',
        required: false,
        descr: 'Limit the number of results (default 10, max 50)',
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
