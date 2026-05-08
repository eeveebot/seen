'use strict';

// Seen module
// Tracks when users were last seen and provides commands to check

import fs from 'node:fs';
import {
  NatsClient,
  log,
  createNatsConnection,
  registerGracefulShutdown,
  createModuleMetrics,
  loadModuleConfig,
  RateLimitConfig,
  defaultRateLimit,
  registerCommand,
  sendChatMessage,
  registerHelp,
  HelpEntry,
  registerStatsHandlers,
  queryChannelUsers,
  initializeSystemMetrics,
  setupHttpServer,
} from '@eeveebot/libeevee';
import Database from 'better-sqlite3';
import { colorizeSeen } from './utils/colorize.mjs';

const metrics = createModuleMetrics('seen');

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

// Seen module configuration interface
interface SeenConfig {
  ratelimit?: RateLimitConfig;
  dbPath?: string;
}

const natsClients: InstanceType<typeof NatsClient>[] = [];
const natsSubscriptions: Array<Promise<string | boolean>> = [];

// Initialize system metrics
initializeSystemMetrics('seen');

// Setup HTTP server for metrics and health checks
setupHttpServer({
  port: process.env.HTTP_API_PORT || '9000',
  serviceName: 'seen',
  natsClients: natsClients,
});

// Database instance
let db: Database.Database | null = null;

//
// Do whatever teardown is necessary before calling common handler
registerGracefulShutdown(natsClients, async () => {
  if (db) db.close();
});

//
// Setup NATS connection

const nats = await createNatsConnection();
natsClients.push(nats);

// Load configuration at startup
const seenConfig = loadModuleConfig<SeenConfig>({});

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

// (seen command registration now handled by registerCommand helper below)

// (since command registration now handled by registerCommand helper below)

// (lurkers command registration now handled by registerCommand helper below)

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

// Register commands at startup using registerCommand helper
const seenCommandSubs = await registerCommand(nats, {
  commandUUID: seenCommandUUID,
  commandDisplayName: seenCommandDisplayName,
  regex: '^seen\\s+',
  ratelimit: seenConfig.ratelimit || defaultRateLimit,
}, metrics);
natsSubscriptions.push(...seenCommandSubs);

const sinceCommandSubs = await registerCommand(nats, {
  commandUUID: sinceCommandUUID,
  commandDisplayName: sinceCommandDisplayName,
  regex: '^since\\s+',
  ratelimit: seenConfig.ratelimit || defaultRateLimit,
}, metrics);
natsSubscriptions.push(...sinceCommandSubs);

const lurkersCommandSubs = await registerCommand(nats, {
  commandUUID: lurkersCommandUUID,
  commandDisplayName: lurkersCommandDisplayName,
  regex: '^lurkers\\s*',
  ratelimit: seenConfig.ratelimit || defaultRateLimit,
}, metrics);
natsSubscriptions.push(...lurkersCommandSubs);

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
        void sendChatMessage(nats, { channel: data.channel, network: data.network, instance: data.instance, platform: data.platform, text: `${userText}: ${usageText}`, trace: data.trace }, metrics);
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

        void sendChatMessage(nats, { channel: data.channel, network: data.network, instance: data.instance, platform: data.platform, text: `${userText}: ${responseText}`, trace: data.trace }, metrics);
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

      void sendChatMessage(nats, { channel: data.channel, network: data.network, instance: data.instance, platform: data.platform, text: `${userText}: [${targetUserText}] [${dateTimeText}] [${actionText}]`, trace: data.trace }, metrics);
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
        void sendChatMessage(nats, { channel: data.channel, network: data.network, instance: data.instance, platform: data.platform, text: `${userText}: ${usageText}`, trace: data.trace }, metrics);
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
        void sendChatMessage(nats, { channel: data.channel, network: data.network, instance: data.instance, platform: data.platform, text: `${userText}: ${errorText}`, trace: data.trace }, metrics);
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

      void sendChatMessage(nats, { channel: data.channel, network: data.network, instance: data.instance, platform: data.platform, text: responseText, trace: data.trace }, metrics);
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
        currentUsers = await queryChannelUsers(
          nats,
          data.platform,
          data.instance,
          data.channel,
          { metrics, producer: 'seen' }
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
        void sendChatMessage(nats, { channel: data.channel, network: data.network, instance: data.instance, platform: data.platform, text: `${userText}: ${errorText}`, trace: data.trace }, metrics);
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
      let allOldUsers: Array<{ nick: string; date: string }> = [];
      try {
        allOldUsers = stmt.all({
          cutoffTime,
          channel: data.channel,
          platform: data.platform,
          instance: data.instance,
          network: data.network,
          limit: limit,
        }) as Array<{ nick: string; date: string }>;
      } catch (error) {
        log.error('Failed to execute lurkers query for old users', {
          producer: 'seen',
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          query: {
            cutoffTime,
            channel: data.channel,
            platform: data.platform,
            instance: data.instance,
            network: data.network,
          },
        });
        throw error;
      }

      // Filter to only include users currently in channel
      const oldUsers = allOldUsers
        .filter((user) => currentUserNicks.has(user.nick.toLowerCase()))
        .slice(0, limit);

      // Find users who are currently in channel but not in database (never seen)
      const unseenUsers: Array<{ nick: string; date: string }> = [];
      const maxUnseenUsers = Math.max(0, limit - oldUsers.length);

      if (maxUnseenUsers > 0) {
        // Query database for all users in this channel to exclude them from unseen users
        const allChannelUsersStmt = db!.prepare(`
          SELECT DISTINCT nick FROM seen_users
          WHERE channel = @channel AND platform = @platform AND instance = @instance AND network = @network
        `);

        let seenUsers: Array<{ nick: string }> = [];
        try {
          seenUsers = allChannelUsersStmt.all({
            channel: data.channel,
            platform: data.platform,
            instance: data.instance,
            network: data.network,
          }) as Array<{ nick: string }>;
        } catch (error) {
          log.error('Failed to execute lurkers query for seen users', {
            producer: 'seen',
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            queries: {
              channel: data.channel,
              platform: data.platform,
              instance: data.instance,
              network: data.network,
            },
          });
          throw error;
        }

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

      void sendChatMessage(nats, { channel: data.channel, network: data.network, instance: data.instance, platform: data.platform, text: responseText, trace: data.trace }, metrics);
    } catch (error) {
      log.error('Failed to process lurkers command', {
        producer: 'seen',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
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

// (control.registerCommands subscriptions are now handled by registerCommand helper)

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

// Subscribe to stats.uptime and stats.emit.request
const statsSubs = registerStatsHandlers({ nats, moduleName: 'seen', startTime: moduleStartTime, metrics });
natsSubscriptions.push(...statsSubs);

// Help information for seen commands
const seenHelp: HelpEntry[] = [
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

// Register help information using registerHelp helper
const helpSubs = await registerHelp(nats, 'seen', seenHelp, metrics);
natsSubscriptions.push(...helpSubs);
