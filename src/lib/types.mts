'use strict';

import { RateLimitConfig } from '@eeveebot/libeevee';

// Seen module configuration interface
export interface SeenConfig {
  ratelimit?: RateLimitConfig;
  dbPath?: string;
}
