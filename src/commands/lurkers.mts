'use strict';

import { NatsClient, log, createModuleMetrics, sendChatMessage, queryChannelUsers, NatsSubscriptionResult } from '@eeveebot/libeevee';
import { getDb } from '../lib/database.mjs';
import { colorizeSeen } from '../utils/colorize.mjs';

const metrics = createModuleMetrics('seen');

export interface CommandHandlerParams {
  nats: InstanceType<typeof NatsClient>;
  commandUUID: string;
}

export async function handleLurkersCommand({
  nats,
  commandUUID,
}: CommandHandlerParams): Promise<NatsSubscriptionResult> {
  const lurkersCommandSub = nats.subscribe(
    `command.execute.${commandUUID}`,
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

        const db = getDb();

        // Find users in database who haven't been seen since cutoff time AND are currently in channel
        const stmt = db.prepare(`
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
          const allChannelUsersStmt = db.prepare(`
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

  return lurkersCommandSub;
}
