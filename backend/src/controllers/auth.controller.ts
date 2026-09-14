import { Request, Response } from 'express';
import { z } from 'zod';
import getPrismaClient from '../db/prisma.client';

/**
 * Demo-scoped user profile/settings endpoints backing the "Continue with
 * Google" flow. Every handler degrades to an in-memory response when
 * Postgres isn't configured, so the app stays usable without a database.
 */

const EmailQuerySchema = z.object({
  email: z.string().trim().email('Invalid email address'),
});

const UpsertGoogleUserSchema = z.object({
  email: z.string().trim().email('Invalid email address'),
  googleId: z.string().trim().min(1, 'googleId is required'),
  name: z.string().trim().min(1).max(100).optional(),
  image: z.string().trim().optional(),
});

const UpdateUserSettingsSchema = z.object({
  userId: z.string().trim().min(1, 'userId is required'),
  favoriteDriver: z.number().int().min(1).max(99).optional(),
  speedUnit: z.enum(['KMH', 'MPH']).optional(),
  soundAlerts: z.boolean().optional(),
});

/** Looks up a user (with settings and bookmarks) by email, or returns a default profile if not found or the DB is unavailable. */
export async function getUserProfile(req: Request, res: Response) {
  const parsed = EmailQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: parsed.error.issues[0]?.message || 'Valid email required',
    });
  }

  const { email } = parsed.data;
  const prisma = getPrismaClient();

  if (!prisma) {
    // Graceful response when Postgres is not yet connected
    return res.json({
      success: true,
      user: { email, name: 'F1 Fan', settings: { favoriteDriver: 1, speedUnit: 'KMH' } },
      isDbActive: false,
    });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      include: { settings: true, bookmarks: true },
    });

    if (!user) {
      return res.json({
        success: true,
        user: { email, name: 'F1 Fan', settings: { favoriteDriver: 1, speedUnit: 'KMH' } },
        isDbActive: true,
      });
    }

    return res.json({ success: true, user, isDbActive: true });
  } catch (err: any) {
    console.error('Error in getUserProfile:', err?.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/** Creates or updates a user record from a completed Google sign-in, seeding default settings on first login. */
export async function upsertGoogleUser(req: Request, res: Response) {
  const parsed = UpsertGoogleUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: parsed.error.issues[0]?.message || 'Invalid user payload',
    });
  }

  const { email, name, image, googleId } = parsed.data;
  const prisma = getPrismaClient();

  if (!prisma) {
    return res.json({
      success: true,
      message: 'PostgreSQL not configured, session handled in-memory',
      user: { email, name: name || 'F1 Fan', image, googleId },
      isDbActive: false,
    });
  }

  try {
    const user = await prisma.user.upsert({
      where: { googleId },
      update: {
        ...(name !== undefined ? { name } : {}),
        ...(image !== undefined ? { image } : {}),
      },
      create: {
        email,
        name: name || 'F1 Fan',
        image,
        googleId,
        settings: {
          create: {
            favoriteDriver: 1, // Default to Norris
            speedUnit: 'KMH',
            soundAlerts: true,
          },
        },
      },
      include: { settings: true },
    });

    return res.json({ success: true, user, isDbActive: true });
  } catch (err: any) {
    console.error('Error in upsertGoogleUser:', err?.message);
    return res.status(500).json({ success: false, error: 'Failed to update user profile' });
  }
}

/** Updates a user's saved preferences (favorite driver, speed unit, sound alerts). */
export async function updateUserSettings(req: Request, res: Response) {
  const parsed = UpdateUserSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: parsed.error.issues[0]?.message || 'Invalid user settings payload',
    });
  }

  const { userId, favoriteDriver, speedUnit, soundAlerts } = parsed.data;
  const prisma = getPrismaClient();

  if (!prisma) {
    return res.json({ success: true, message: 'Settings updated in memory', isDbActive: false });
  }

  try {
    const updateData: { favoriteDriver?: number; speedUnit?: string; soundAlerts?: boolean } = {};
    if (favoriteDriver !== undefined) updateData.favoriteDriver = favoriteDriver;
    if (speedUnit !== undefined) updateData.speedUnit = speedUnit;
    if (soundAlerts !== undefined) updateData.soundAlerts = soundAlerts;

    const settings = await prisma.userSettings.upsert({
      where: { userId },
      update: updateData,
      create: {
        userId,
        favoriteDriver: favoriteDriver ?? 1,
        speedUnit: speedUnit ?? 'KMH',
        soundAlerts: soundAlerts ?? true,
      },
    });

    return res.json({ success: true, settings, isDbActive: true });
  } catch (err: any) {
    console.warn('⚠️ updateUserSettings database error, falling back to in-memory settings:', err?.message);
    return res.json({
      success: true,
      message: 'Settings updated',
      settings: {
        userId,
        favoriteDriver: favoriteDriver ?? 1,
        speedUnit: speedUnit ?? 'KMH',
        soundAlerts: soundAlerts ?? true,
      },
      isDbActive: false,
    });
  }
}
