import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

// Backend has no .env of its own — real credentials (Redis, Postgres) live in
// the monorepo root .env. Load that explicitly since dotenv.config() only
// checks the current working directory (backend/ when run via `npm run dev`).
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

export const ENV = parsed.data;
