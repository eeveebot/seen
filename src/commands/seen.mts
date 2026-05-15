'use strict';

import { NatsClient, log, createModuleMetrics, sendChatMessage, NatsSubscriptionResult } from '@eeveebot/libeevee';
import { findUser } from '../lib/database.mjs';
import { colorizeSeen } from '../utils/colorize.mjs';

const metrics = createModuleMetrics('seen');

export interface CommandHandlerParams {
  nats: InstanceType<typeof NatsClient>;
  commandUUID: string;
}

export async function handleSeenCommand({
  nats,
  commandUUID,
}: CommandHandlerParams): Promise<NatsSubscriptionResult> {
  const seenCommandSub = nats.subscribe(
    `command.execute.${commandUUID}`,
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
        const userData = findUser(targetUser);
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

  return seenCommandSub;
}
