import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

/**
 * Loads and validates environment variables for the backend process.
 *
 * Two sources are merged: the monorepo root `.env` (loaded first, explicitly
 * by path since `dotenv.config()` only checks the current working directory)
 * and `backend/.env` (loaded second via the bare call below, which takes
 * precedence for any key defined in both — Node resolves relative paths
 * against `backend/` when the process is started via `npm run dev` there).
 */
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('4000').transform((v) => parseInt(v, 10)),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  JWT_SECRET: z.string().default('f1-telemetry-dev-jwt-secret-key-change-in-prod-32chars'),
  OPENF1_API_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

/** Validated, typed process environment — import this instead of reading `process.env` directly. */
export const ENV = parsed.data;
