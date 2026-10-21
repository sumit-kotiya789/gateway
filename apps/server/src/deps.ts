import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Config } from './common/config.js';
import type { Envelope } from './common/crypto/envelope.js';
import type { Db } from './common/db.js';

/** Everything a request handler may touch. Built once in main; tests build their own. */
export interface Deps {
  config: Config;
  db: Db;
  redis: Redis | null;
  envelope: Envelope;
  clock: () => number;
  log: Logger;
}
