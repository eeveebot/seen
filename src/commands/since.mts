'use strict';

import { NatsClient, log, createModuleMetrics, sendChatMessage, NatsSubscriptionResult } from '@eeveebot/libeevee';
import { findUsersSince } from '../lib/database.mjs';
import { colorizeSeen } from '../utils/colorize.mjs';

const metrics = createModuleMetrics('seen');

export interface CommandHandlerParams {
  nats: InstanceType<typeof NatsClient>;
  commandUUID: string;
}

export async function handleSinceCommand({
  nats,
  commandUUID,
}: CommandHandlerParams): Promise<NatsSubscriptionResult> {
  const sinceCommandSub = nats.subscribe(
    `command.execute.${commandUUID}`,
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
          const userText = colorizeSeen(data.nick, data.platform, 'user');
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
          const userText = colorizeSeen(data.nick, data.platform, 'user');
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
        const users = findUsersSince(sinceTime);

        // Colorize the response
        const userText = colorizeSeen(data.nick, data.platform, 'user');
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

  return sinceCommandSub;
}
