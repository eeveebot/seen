'use strict';

import { NatsClient, log, createModuleMetrics, sendChatMessage, queryChannelUsers, queryUserModes, NatsSubscriptionResult } from '@eeveebot/libeevee';
import { getDb } from '../lib/database.mjs';
import { colorizeSeen } from '../utils/colorize.mjs';

const metrics = createModuleMetrics('seen');

export interface CommandHandlerParams {
  nats: InstanceType<typeof NatsClient>;
  commandUUID: string;
}

export async function handleLurkersReportCommand({
  nats,
  commandUUID,
}: CommandHandlerParams): Promise<NatsSubscriptionResult> {
  const lurkersReportCommandSub = nats.subscribe(
    `command.execute.${commandUUID}`,
    async (subject, message) => {
      try {
        const data = JSON.parse(message.string());
        log.info('Received command.execute for lurkers-report', {
          producer: 'seen',
          platform: data.platform,
          instance: data.instance,
          channel: data.channel,
          user: data.user,
          originalText: data.originalText,
        });

        // Parse the command: lurkers-report [days]
        const args = data.text.trim();
        let days = 30; // Default to 30 days
        const daysMatch = args.match(/^(\d+)/);
        if (daysMatch) {
          const daysParam = parseInt(daysMatch[1]);
          days = isNaN(daysParam) ? 30 : Math.max(1, Math.min(daysParam, 365));
        }

        // Admin gate — check if the requesting user is a channel admin
        let isAdmin = false;
        try {
          const userModes = await queryUserModes(
            nats,
            data.platform,
            data.instance,
            data.channel,
            data.nick,
            { metrics, producer: 'seen' }
          );
          isAdmin = userModes.isChannelAdmin;
        } catch (error) {
          log.error('Failed to query user modes for lurkers-report', {
            producer: 'seen',
            error: error instanceof Error ? error.message : String(error),
          });
          const userText = colorizeSeen(data.nick, data.platform, 'user');
          const errorText = colorizeSeen(
            'Unable to verify admin status. Please try again later.',
            data.platform,
            'warning'
          );
          void sendChatMessage(nats, { channel: data.channel, network: data.network, instance: data.instance, platform: data.platform, text: `${userText}: ${errorText}`, trace: data.trace }, metrics);
          return;
        }

        if (!isAdmin) {
          const userText = colorizeSeen(data.nick, data.platform, 'user');
          const errorText = colorizeSeen(
            'You must be a channel admin to use this command',
            data.platform,
            'warning'
          );
          void sendChatMessage(nats, { channel: data.channel, network: data.network, instance: data.instance, platform: data.platform, text: `${userText}: ${errorText}`, trace: data.trace }, metrics);
          return;
        }

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
          log.debug('Retrieved user list from IRC connector for lurkers-report', {
            producer: 'seen',
            channel: data.channel,
            userCount: currentUsers.length,
          });
        } catch (error) {
          log.error('Failed to get user list for lurkers-report', {
            producer: 'seen',
            channel: data.channel,
            error: error instanceof Error ? error.message : String(error),
          });
          const userText = colorizeSeen(data.nick, data.platform, 'user');
          const errorText = colorizeSeen(
            'Failed to retrieve user list from IRC connector',
            data.platform,
            'warning'
          );
          void sendChatMessage(nats, { channel: data.channel, network: data.network, instance: data.instance, platform: data.platform, text: `${userText}: ${errorText}`, trace: data.trace }, metrics);
          return;
        }

        const currentUserNicks = new Set(
          currentUsers.map((user) => user.nick.toLowerCase())
        );

        const cutoffTime = new Date(
          Date.now() - days * 24 * 60 * 60 * 1000
        ).toISOString();

        const db = getDb();

        // Query all users in this channel from the database — no LIMIT
        const allDbUsersStmt = db.prepare(`
          SELECT nick, date FROM seen_users
          WHERE channel = @channel AND platform = @platform AND instance = @instance AND network = @network
        `);

        let allDbUsers: Array<{ nick: string; date: string }> = [];
        try {
          allDbUsers = allDbUsersStmt.all({
            channel: data.channel,
            platform: data.platform,
            instance: data.instance,
            network: data.network,
          }) as Array<{ nick: string; date: string }>;
        } catch (error) {
          log.error('Failed to execute lurkers-report query', {
            producer: 'seen',
            error: error instanceof Error ? error.message : String(error),
          });
          const userText = colorizeSeen(data.nick, data.platform, 'user');
          const errorText = colorizeSeen(
            'Failed to query seen database',
            data.platform,
            'warning'
          );
          void sendChatMessage(nats, { channel: data.channel, network: data.network, instance: data.instance, platform: data.platform, text: `${userText}: ${errorText}`, trace: data.trace }, metrics);
          return;
        }

        // Build a map of nick -> lastSeenDate for current channel users
        const dbUserMap = new Map<string, string>();
        for (const u of allDbUsers) {
          const lowerNick = u.nick.toLowerCase();
          if (currentUserNicks.has(lowerNick)) {
            // Keep the most recent date for each nick
            const existing = dbUserMap.get(lowerNick);
            if (!existing || u.date > existing) {
              dbUserMap.set(lowerNick, u.date);
            }
          }
        }

        // Categorize current channel users
        const activeUsers: Array<{ nick: string; daysAgo: number }> = [];
        const inactiveUsers: Array<{ nick: string; daysAgo: number }> = [];
        const neverSeenUsers: Array<{ nick: string }> = [];

        for (const cu of currentUsers) {
          const lowerNick = cu.nick.toLowerCase();
          const lastSeen = dbUserMap.get(lowerNick);
          if (!lastSeen) {
            neverSeenUsers.push({ nick: cu.nick });
          } else {
            const lastSeenDate = new Date(lastSeen);
            const diffMs = Date.now() - lastSeenDate.getTime();
            const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            if (lastSeenDate.getTime() >= new Date(cutoffTime).getTime()) {
              activeUsers.push({ nick: cu.nick, daysAgo: diffDays });
            } else {
              inactiveUsers.push({ nick: cu.nick, daysAgo: diffDays });
            }
          }
        }

        // Build the report lines
        const lines: string[] = [];
        lines.push(`=== Lurkers Report for ${data.channel} (${days} day window) ===`);

        // Active users
        if (activeUsers.length > 0) {
          const activeList = activeUsers
            .map((u) => `${u.nick} (${u.daysAgo === 0 ? 'today' : `${u.daysAgo}d ago`})`)
            .join(', ');
          lines.push(`Active users (seen within ${days} days): ${activeList}`);
        } else {
          lines.push(`Active users (seen within ${days} days): none`);
        }

        // Inactive users
        if (inactiveUsers.length > 0) {
          const inactiveList = inactiveUsers
            .map((u) => `${u.nick} (${u.daysAgo}d ago)`)
            .join(', ');
          lines.push(`Inactive users (not seen in ${days} days): ${inactiveList}`);
        } else {
          lines.push(`Inactive users (not seen in ${days} days): none`);
        }

        // Never seen
        if (neverSeenUsers.length > 0) {
          const neverList = neverSeenUsers.map((u) => u.nick).join(', ');
          lines.push(`Never seen: ${neverList}`);
        } else {
          lines.push('Never seen: none');
        }

        // Summary
        const total = activeUsers.length + inactiveUsers.length + neverSeenUsers.length;
        lines.push(
          `Total: ${total} users (${activeUsers.length} active, ${inactiveUsers.length} inactive, ${neverSeenUsers.length} never seen)`
        );

        // Deliver report via private message, splitting across multiple messages if needed
        const MAX_MSG_LENGTH = 400;
        let currentBatch = '';
        const sendBatch = async (text: string) => {
          await sendChatMessage(nats, {
            channel: data.nick, // nick as target = PM in IRC
            network: data.network,
            instance: data.instance,
            platform: data.platform,
            text,
            trace: data.trace,
          }, metrics);
        };

        for (const line of lines) {
          if (currentBatch.length + line.length + 1 > MAX_MSG_LENGTH && currentBatch.length > 0) {
            await sendBatch(currentBatch);
            currentBatch = line;
          } else {
            currentBatch = currentBatch ? `${currentBatch}\n${line}` : line;
          }
        }
        if (currentBatch) {
          await sendBatch(currentBatch);
        }

        // Send brief confirmation to the channel
        const userText = colorizeSeen(data.nick, data.platform, 'user');
        const confirmText = colorizeSeen(
          'Lurkers report sent via private message.',
          data.platform,
          'info'
        );
        void sendChatMessage(nats, { channel: data.channel, network: data.network, instance: data.instance, platform: data.platform, text: `${userText}: ${confirmText}`, trace: data.trace }, metrics);
      } catch (error) {
        log.error('Failed to process lurkers-report command', {
          producer: 'seen',
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    }
  );

  return lurkersReportCommandSub;
}
