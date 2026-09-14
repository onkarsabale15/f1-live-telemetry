import { PrismaClient } from '@prisma/client';
import { ENV } from '../config/env';

let prisma: PrismaClient | null = null;

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
