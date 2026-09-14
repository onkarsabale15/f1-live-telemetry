import { PrismaClient } from '@prisma/client';
import { ENV } from '../config/env';

let prisma: PrismaClient | null = null;

/**
 * Lazily creates and returns a singleton Prisma client, or `null` when no
 * `DATABASE_URL` is configured. Postgres archival/replay is an optional
 * enhancement, not a hard dependency — every caller of this function must
 * handle the `null` case by falling back to the live OpenF1 path.
 */
export function getPrismaClient(): PrismaClient | null {
  if (!ENV.DATABASE_URL) {
    return null;
  }

  if (!prisma) {
    try {
      prisma = new PrismaClient({
        log: ENV.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
      });
    } catch (err) {
      console.warn('⚠️ Prisma Client initialization failed. Check DATABASE_URL.', err);
    }
  }

  return prisma;
}

export default getPrismaClient;
