import { Request, Response } from 'express';
import { z } from 'zod';
import { openF1Service } from '../services/openf1.service';
import { replayDbService } from '../services/replay-db.service';

const SessionKeyParamSchema = z.object({
  sessionKey: z
    .string()
    .regex(/^\d+$/, 'sessionKey must be a positive integer')
    .transform((v) => parseInt(v, 10)),
});

const ExplorerQuerySchema = z.object({
  year: z
    .string()
    .regex(/^\d{4}$/, 'year must be a 4-digit number')
    .transform((v) => parseInt(v, 10))
    .optional(),
});

export async function getSessions(req: Request, res: Response) {
  try {
    const sessions = await openF1Service.getRecentSessions();
    return res.json({ success: true, sessions });
  } catch (err: any) {
    console.error('Error fetching sessions:', err?.message);
    return res.status(500).json({ success: false, error: 'Failed to retrieve sessions' });
  }
}

/**
 * Match Explorer: lists every session for a given year (defaults to current
 * year) so the user can browse and load any past race weekend, not just the
 * live/latest one.
 */
export async function getSessionsExplorer(req: Request, res: Response) {
  try {
    const parsed = ExplorerQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: parsed.error.issues[0]?.message || 'Invalid year parameter',
      });
    }

    const year = parsed.data.year || new Date().getFullYear();
    const sessions = await openF1Service.getSessionsForYear(year);

    const enriched = sessions
      .map((s) => ({
        ...s,
        isLive: openF1Service.isSessionLive(s),
        isUpcoming: openF1Service.isSessionUpcoming(s),
      }))
      .sort((a, b) => new Date(b.date_start).getTime() - new Date(a.date_start).getTime());

    return res.json({ success: true, year, sessions: enriched });
  } catch (err: any) {
    console.error('Error fetching session explorer data:', err?.message);
    return res.status(500).json({ success: false, error: 'Failed to retrieve sessions for explorer' });
  }
}

/**
 * Progress of the one-time database archival for a session — lets the
 * frontend show "Archiving for instant replay: 42%" instead of the user
 * wondering why the first load of an old race is slower than the second.
 */
export async function getIngestStatus(req: Request, res: Response) {
  try {
    const parsed = SessionKeyParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: parsed.error.issues[0]?.message || 'Invalid sessionKey: must be a positive integer',
      });
    }

    const status = await replayDbService.getIngestStatus(parsed.data.sessionKey);
    return res.json({
      success: true,
      sessionKey: parsed.data.sessionKey,
      status: status?.status || 'NONE',
      progress: status?.progress ?? 0,
    });
  } catch (err: any) {
    console.error('Error fetching ingest status:', err?.message);
    return res.status(500).json({ success: false, error: 'Failed to retrieve ingest status' });
  }
}
