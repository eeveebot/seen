'use strict';

import { NatsClient, log, createModuleMetrics, sendChatMessage, NatsSubscriptionResult } from '@eeveebot/libeevee';
import { findDeparture } from '../lib/database.mjs';
import { colorizeSeen } from '../utils/colorize.mjs';

const metrics = createModuleMetrics('seen');

export interface CommandHandlerParams {
  nats: InstanceType<typeof NatsClient>;
  commandUUID: string;
}

export async function handleLastwordsCommand({
  nats,
  commandUUID,
}: CommandHandlerParams): Promise<NatsSubscriptionResult> {
  const lastwordsCommandSub = nats.subscribe(
    `command.execute.${commandUUID}`,
    (subject, message) => {
      try {
        const data = JSON.parse(message.string());
        log.info('Received command.execute for lastwords', {
          producer: 'seen',
          platform: data.platform,
          instance: data.instance,
          channel: data.channel,
          user: data.user,
          originalText: data.originalText,
        });

        // Parse the command: lastwords <username>
        const parts = data.text.trim().split(/\s+/);
        if (parts.length < 1) {
          const userText = colorizeSeen(data.nick, data.platform, 'user');
          const usageText = colorizeSeen(
            'Usage: lastwords <username>',
            data.platform,
            'warning'
          );
          void sendChatMessage(nats, { channel: data.channel, network: data.network, instance: data.instance, platform: data.platform, text: `${userText}: ${usageText}`, trace: data.trace }, metrics);
          return;
        }

        const targetUser = parts[0].toLowerCase();

        // Find the most recent departure record for this user
        const departure = findDeparture(
          targetUser,
          data.platform,
          data.network,
          data.instance
        );

        if (!departure) {
          const userText = colorizeSeen(data.nick, data.platform, 'user');
          const targetUserText = colorizeSeen(
            targetUser,
            data.platform,
            'warning'
          );
          const responseText = colorizeSeen(
            `I don't have a departure record for ${targetUserText}`,
            data.platform,
            'info'
          );
          void sendChatMessage(nats, { channel: data.channel, network: data.network, instance: data.instance, platform: data.platform, text: `${userText}: ${responseText}`, trace: data.trace }, metrics);
          return;
        }

        // Format the last message date
        let lastMsgDate: Date;
        try {
          lastMsgDate = new Date(departure.last_message_date);
          if (isNaN(lastMsgDate.getTime())) {
            throw new Error('Invalid date');
          }
        } catch {
          lastMsgDate = new Date();
        }

        // Format the departure date
        let depDate: Date;
        try {
          depDate = new Date(departure.departure_date);
          if (isNaN(depDate.getTime())) {
            throw new Error('Invalid date');
          }
        } catch {
          depDate = new Date();
        }

        const lastMsgDateStr = lastMsgDate.toISOString().substring(0, 10);
        const lastMsgTimeStr = lastMsgDate.toISOString().substring(11, 16);
        const depDateStr = depDate.toISOString().substring(0, 10);
        const depTimeStr = depDate.toISOString().substring(11, 16);

        // Build the departure phrase based on type
        let departurePhrase: string;
        switch (departure.departure_type) {
          case 'part':
            departurePhrase = `parted from ${departure.channel}`;
            break;
          case 'quit':
            departurePhrase = `quit from ${departure.channel}`;
            break;
          case 'kick':
            departurePhrase = `kicked from ${departure.channel}`;
            if (departure.kicked_by) {
              departurePhrase += ` by ${departure.kicked_by}`;
            }
            break;
          default:
            departurePhrase = `left ${departure.channel}`;
        }

        // Build the reason parenthetical (shown for all types when non-empty)
        let reasonText = '';
        if (departure.departure_reason && departure.departure_reason.trim() !== '') {
          reasonText = ` (${departure.departure_reason})`;
        }

        // Handle edge case where last_message is empty
        const lastMessageDisplay = departure.last_message || 'nothing';

        // Colorize the response
        const userText = colorizeSeen(data.nick, data.platform, 'user');
        const targetUserText = colorizeSeen(targetUser, data.platform, 'user');
        const lastMsgText = colorizeSeen(lastMessageDisplay, data.platform, 'action');
        const lastMsgDateTime = colorizeSeen(
          `${lastMsgDateStr} ${lastMsgTimeStr}`,
          data.platform,
          'date'
        );
        const depDateTime = colorizeSeen(
          `${depDateStr} ${depTimeStr}`,
          data.platform,
          'date'
        );
        const departurePhraseText = colorizeSeen(departurePhrase, data.platform, 'info');
        const reasonColored = colorizeSeen(reasonText, data.platform, 'info');

        const responseText = `${userText}: [${targetUserText}] Last said "${lastMsgText}" at ${lastMsgDateTime}, ${departurePhraseText} at ${depDateTime}${reasonColored}`;

        void sendChatMessage(nats, { channel: data.channel, network: data.network, instance: data.instance, platform: data.platform, text: responseText, trace: data.trace }, metrics);
      } catch (error) {
        log.error('Failed to process lastwords command', {
          producer: 'seen',
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    }
  );

  return lastwordsCommandSub;
}
