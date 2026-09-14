import { Request, Response } from 'express';
import { z } from 'zod';
import { openF1Service } from '../services/openf1.service';
import { replayDbService } from '../services/replay-db.service';
import { deriveTrackStatus } from '../domain/trackStatus';

const ParamsSchema = z.object({
  sessionKey: z
    .string()
    .regex(/^\d+$/, 'sessionKey must be a positive integer')
    .transform((v) => parseInt(v, 10)),
});

const QuerySchema = z.object({
  // Current replay/scrub position — same lap-granularity convention as
  // /compare and /tyre-strategy. Deliberately NOT keyed to the exact
  // playback timestamp: that would mean re-fetching every ~1s tick instead
  // of once per lap change, and for a still-live (not yet archived) session
  // that's a real OpenF1 call each time — a 90x higher request rate for a
  // marginal gain (catching a flag thrown and cleared within one lap).
  uptoLap: z.string().regex(/^\d+$/).transform((v) => parseInt(v, 10)).optional(),
});

/**
 * Race control feed: flags, safety car / VSC periods, penalties — plus the
 * derived current track-wide status used to recolor the circuit map. Reads
 * from Postgres once a session is archived (no OpenF1 calls); falls back to
 * a single unbounded OpenF1 call otherwise (small, low-frequency dataset,
 * safe well within the rate budget even fetched every lap change).
 */
export async function getRaceControlFeed(req: Request, res: Response) {
  try {
    const paramsParsed = ParamsSchema.safeParse(req.params);
    if (!paramsParsed.success) {
      return res.status(400).json({
        success: false,
        error: paramsParsed.error.issues[0]?.message || 'Invalid sessionKey',
      });
    }
    const { sessionKey } = paramsParsed.data;
    const queryParsed = QuerySchema.safeParse(req.query);
    const uptoLap = queryParsed.success ? queryParsed.data.uptoLap ?? null : null;

    const isArchived = await replayDbService.isFullyIngested(sessionKey);
    const messages = isArchived
      ? await replayDbService.getRaceControlMessages(sessionKey)
      : await openF1Service.getRaceControl(sessionKey);

    // A message with no lap_number (e.g. the race-start green light, fired
    // before lap 1 is officially underway) is session-level context, not
    // tied to a specific lap — always keep it rather than dropping it.
    const filtered =
      uptoLap == null
        ? messages
        : messages.filter((m) => m.lap_number == null || m.lap_number <= uptoLap);

    const sorted = [...filtered].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );

    const trackStatus = deriveTrackStatus(sorted);

    const feed = sorted
      .slice()
      .reverse()
      .map((m) => ({
        date: m.date,
        category: m.category,
        flag: m.flag,
        scope: m.scope,
        sector: m.sector,
        driverNumber: m.driver_number,
        lapNumber: m.lap_number,
        message: m.message,
      }));

    return res.json({
      success: true,
      sessionKey,
      trackStatus: trackStatus.status,
      trackStatusMessage: trackStatus.message,
      messages: feed,
    });
  } catch (err: any) {
    console.error('Error building race control feed:', err?.message);
    return res.status(500).json({ success: false, error: 'Failed to load race control feed' });
  }
}
