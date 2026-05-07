import { colorizeByType, type SemanticColorMap } from '@eeveebot/libeevee';

// Custom semantic color map for seen module
// (olive replaces the old 'orange' — irc-colors doesn't have orange)
const seenColorMap: SemanticColorMap = {
  user: 'cyan',
  date: 'green',
  action: 'yellow',
  warning: 'olive',
  info: 'blue',
};

/**
 * Colorize seen text based on platform
 */
export function colorizeSeen(
  text: string,
  platform: string,
  type: 'user' | 'date' | 'action' | 'info' | 'warning' = 'info'
): string {
  return colorizeByType(text, platform, type, seenColorMap);
}
