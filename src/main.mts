'use strict';

// Seen module
// Tracks when users were last seen and provides commands to check

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
  registerBroadcast,
  initializeSystemMetrics,
  setupHttpServer,
  NatsSubscriptionResult,
} from '@eeveebot/libeevee';
import { initDatabase, closeDatabase, updateSeenUser } from './lib/database.mjs';
import type { SeenConfig } from './lib/types.mjs';
import { handleSeenCommand } from './commands/seen.mjs';
import { handleSinceCommand } from './commands/since.mjs';
import { handleLurkersCommand } from './commands/lurkers.mjs';
import { handleLurkersReportCommand } from './commands/lurkers-report.mjs';
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

const lurkersReportCommandUUID = '3b517daa-9af3-4e0d-8128-a98fdb5cfa0b';
const lurkersReportCommandDisplayName = 'lurkers-report';

const seenBroadcastUUID = 'd3a0ee0a-32e3-4613-bcdd-736c52e38e81';
const seenBroadcastDisplayName = 'seen';

const natsClients: InstanceType<typeof NatsClient>[] = [];
const natsSubscriptions: Array<Promise<NatsSubscriptionResult>> = [];

// Initialize system metrics
initializeSystemMetrics('seen');

// Setup HTTP server for metrics and health checks
setupHttpServer({
  port: process.env.HTTP_API_PORT || '9000',
  serviceName: 'seen',
  natsClients: natsClients,
});

// Do whatever teardown is necessary before calling common handler
registerGracefulShutdown(natsClients, async () => {
  closeDatabase();
});

// Setup NATS connection
const nats = await createNatsConnection();
natsClients.push(nats);

// Load configuration at startup
const seenConfig = loadModuleConfig<SeenConfig>({});

// Initialize database
initDatabase();

// Register broadcast at startup using registerBroadcast helper
const seenBroadcastSubs = await registerBroadcast(nats, {
  broadcastUUID: seenBroadcastUUID,
  broadcastDisplayName: seenBroadcastDisplayName,
}, metrics);
natsSubscriptions.push(...seenBroadcastSubs);

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
  regex: '^lurkers(?!-)\\s*',
  ratelimit: seenConfig.ratelimit || defaultRateLimit,
}, metrics);
natsSubscriptions.push(...lurkersCommandSubs);

const lurkersReportCommandSubs = await registerCommand(nats, {
  commandUUID: lurkersReportCommandUUID,
  commandDisplayName: lurkersReportCommandDisplayName,
  regex: '^lurkers-report\\s*',
  ratelimit: seenConfig.ratelimit || defaultRateLimit,
}, metrics);
natsSubscriptions.push(...lurkersReportCommandSubs);

// Subscribe to command execution messages
natsSubscriptions.push(handleSeenCommand({ nats, commandUUID: seenCommandUUID }));
natsSubscriptions.push(handleSinceCommand({ nats, commandUUID: sinceCommandUUID }));
natsSubscriptions.push(handleLurkersCommand({ nats, commandUUID: lurkersCommandUUID }));
natsSubscriptions.push(handleLurkersReportCommand({ nats, commandUUID: lurkersReportCommandUUID }));

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
      updateSeenUser(seenData);
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
// (control.registerBroadcasts subscriptions are now handled by registerBroadcast helper)

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
  {
    command: 'lurkers-report',
    descr: 'Comprehensive channel lurkers report (admin only, sent via private message)',
    params: [
      {
        param: 'days',
        required: false,
        descr: 'The number of days to look back (default 30, max 365)',
      },
    ],
  },
];

// Register help information using registerHelp helper
const helpSubs = await registerHelp(nats, 'seen', seenHelp, metrics);
natsSubscriptions.push(...helpSubs);
