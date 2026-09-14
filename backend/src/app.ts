import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { ENV } from './config/env';
import { messageBus } from './db/redis.client';
import getPrismaClient from './db/prisma.client';
import { getSessions, getSessionsExplorer, getIngestStatus } from './controllers/session.controller';
import { compareDrivers } from './controllers/comparison.controller';
import { getTyreStrategy } from './controllers/strategy.controller';
import { getRaceControlFeed } from './controllers/raceControl.controller';
import { getUserProfile, upsertGoogleUser, updateUserSettings } from './controllers/auth.controller';

/**
 * Builds the Express app: security headers, CORS, body-size limit, rate
 * limiting, and every REST route. Socket.IO is wired separately in
 * server.ts — this only covers the plain HTTP API surface.
 */
export function createApp(): express.Application {
  const app = express();

  // 1. Security Headers via Helmet
  app.use(helmet());

  // 2. Strict CORS Configuration
  const allowedOrigins = ENV.NODE_ENV === 'production'
    ? [ENV.CORS_ORIGIN]
    : [ENV.CORS_ORIGIN, 'http://localhost:3000', 'http://127.0.0.1:3000'];

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          const corsErr = new Error('CORS policy violation: Unauthorized origin.');
          (corsErr as any).status = 403;
          callback(corsErr);
        }
      },
      credentials: true,
    })
  );

  // 3. Request Body Size Limit (10kb)
  app.use(express.json({ limit: '10kb' }));

  // 4. Rate Limiting (Relaxed in dev so dashboard polling and navigation never 429)
  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: ENV.NODE_ENV === 'production' ? 3000 : 50000,
    message: { success: false, error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => ENV.NODE_ENV !== 'production',
  });

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { success: false, error: 'Too many authentication attempts, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.use('/api/', generalLimiter);
  app.use('/api/auth/', authLimiter);

  // Health check endpoint
  app.get('/api/health', (req, res) => {
    const isRedisActive = messageBus.isRedisActive();
    const isDbActive = !!getPrismaClient();

    res.json({
      status: 'ok',
      service: 'f1-telemetry-backend',
      timestamp: new Date().toISOString(),
      redis: isRedisActive ? 'connected' : 'fallback-memory',
      database: isDbActive ? 'configured' : 'not-configured',
    });
  });

  // Session routes
  app.get('/api/sessions', getSessions);
  app.get('/api/sessions/explorer', getSessionsExplorer);
  app.get('/api/sessions/:sessionKey/ingest-status', getIngestStatus);
  app.get('/api/sessions/:sessionKey/compare', compareDrivers);
  app.get('/api/sessions/:sessionKey/comparison', compareDrivers);
  app.get('/api/sessions/:sessionKey/tyre-strategy', getTyreStrategy);
  app.get('/api/sessions/:sessionKey/race-control', getRaceControlFeed);

  // Auth & User routes
  app.get('/api/auth/profile', getUserProfile);
  app.post('/api/auth/google', upsertGoogleUser);
  app.post('/api/auth/settings', updateUserSettings);

  // 404 handler for unknown API routes
  app.use('/api/*', (req: Request, res: Response) => {
    res.status(404).json({ success: false, error: 'Endpoint not found' });
  });

  // 5. Centralized Error Handler
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const statusCode = err.status || err.statusCode || 500;
    if (statusCode >= 500) {
      console.error('Unhandled Server Error:', err);
    }
    res.status(statusCode).json({
      success: false,
      error: ENV.NODE_ENV === 'production' && statusCode >= 500
        ? 'Internal server error'
        : (err.message || 'An unexpected error occurred'),
    });
  });

  return app;
}

export default createApp;
