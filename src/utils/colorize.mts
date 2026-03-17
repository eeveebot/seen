import { ircColors, log } from '@eeveebot/libeevee';

// Available irc-colors for seen module
const safeColorFunctions: Record<
  string,
  ((text: string) => string) | undefined
> = {
  blue: ircColors.blue,
  cyan: ircColors.cyan,
  green: ircColors.green,
  yellow: ircColors.yellow,
  orange: ircColors.orange,
  red: ircColors.red,
  purple: ircColors.purple,
  gray: ircColors.gray,
};

/**
 * Colorize seen text based on platform
 * @param text Text to colorize
 * @param platform Platform identifier
 * @param type Type of message (user, date, action)
 * @returns Colorized text if platform is IRC, otherwise original text
 */
export function colorizeSeen(
  text: string,
  platform: string,
  type: 'user' | 'date' | 'action' | 'info' | 'warning' = 'info'
): string {
  log.debug('colorizeSeen called', {
    producer: 'seen',
    text: text,
    platform: platform,
    type: type,
  });

  // Only apply colorization for IRC platform
  if (platform === 'irc') {
    try {
      log.debug('Applying colorization for IRC', {
        producer: 'seen',
        text: text,
        type: type,
      });

      let colorFunction: ((text: string) => string) | undefined;

      // Select color based on message type
      switch (type) {
        case 'user':
          colorFunction = safeColorFunctions.cyan;
          break;
        case 'date':
          colorFunction = safeColorFunctions.green;
          break;
        case 'action':
          colorFunction = safeColorFunctions.yellow;
          break;
        case 'warning':
          colorFunction = safeColorFunctions.orange;
          break;
        case 'info':
        default:
          colorFunction = safeColorFunctions.blue;
          break;
      }

      // Safety check to ensure we have a valid function
      if (typeof colorFunction !== 'function') {
        log.error('Color function is not a function or is undefined', {
          producer: 'seen',
          colorFunction: colorFunction,
          typeofColorFunction: typeof colorFunction,
        });
        // Return a fallback function that just returns the text unchanged
        return text;
      }

      const coloredText = colorFunction(text);

      log.debug('Successfully colorized seen text for IRC', {
        producer: 'seen',
        originalText: text,
        coloredText: coloredText,
      });

      return coloredText;
    } catch (error) {
      log.error('Failed to colorize seen text for IRC', {
        producer: 'seen',
        text: text,
        error: error instanceof Error ? error.message : String(error),
      });
      return text;
    }
  }

  log.debug('Returning original text for non-IRC platform', {
    producer: 'seen',
    text: text,
    platform: platform,
  });

  // Return original text for non-IRC platforms
  return text;
}
