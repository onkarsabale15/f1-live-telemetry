import { Request, Response } from 'express';
import { z } from 'zod';
import { openF1Service } from '../services/openf1.service';
import { replayDbService } from '../services/replay-db.service';
import { normalizeCompound } from '../domain/tyreCompound';
import { filterToLap } from '../domain/replayFilter';

const ParamsSchema = z.object({
  sessionKey: z
    .string()
    .regex(/^\d+$/, 'sessionKey must be a positive integer')
    .transform((v) => parseInt(v, 10)),
});

const QuerySchema = z.object({
  // Current replay/scrub position — when present, each driver's stints and
  // pit stops are trimmed to "as of this lap" so the timeline fills in
  // progressively during replay instead of always showing the final race.
  uptoLap: z.string().regex(/^\d+$/).transform((v) => parseInt(v, 10)).optional(),
});

/**
 * Full-grid tyre strategy: every driver's complete stint + pit-stop history
 * for the session, used to render a race-long Gantt-style timeline. Reads
 * from Postgres when the session is fully archived (no OpenF1 calls at
 * all); falls back to the live OpenF1 endpoints otherwise.
 */
export async function getTyreStrategy(req: Request, res: Response) {
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

    let laps: any[];
    let stints: any[];
    let pits: any[];
    let driverInfos: any[];

    if (isArchived) {
      const [{ laps: l, stints: s }, pitRows, drivers] = await Promise.all([
        replayDbService.getLapsAndStints(sessionKey),
        replayDbService.getPitStops(sessionKey),
        replayDbService.getDriversInfo(sessionKey),
      ]);
      laps = l;
      stints = s;
      pits = pitRows;
      driverInfos = drivers;
    } else {
      const [l, s, p, d] = await Promise.all([
        openF1Service.getLatestLaps(sessionKey),
        openF1Service.getStints(sessionKey),
        openF1Service.getPitStops(sessionKey),
        openF1Service.getDrivers(sessionKey),
      ]);
      laps = l;
      stints = s;
      pits = p;
      driverInfos = d;
    }

    const totalLaps = Math.max(
      0,
      laps.reduce((max, l) => Math.max(max, l.lap_number || 0), 0),
      stints.reduce((max, s) => Math.max(max, s.lap_end || s.lap_start || 0), 0)
    );

    // totalLaps stays anchored to the session's real final distance (not
    // the filtered subset) so the timeline axis stays fixed while replay
    // progressively fills it in, matching a live broadcast graphic.
    const { stints: fStints, pits: fPits } = filterToLap(laps, stints, pits, uptoLap);

    const driverInfoMap = new Map(driverInfos.map((d) => [d.driverNumber, d]));
    const driverNumbers = Array.from(new Set(stints.map((s) => s.driver_number)));

    const drivers = driverNumbers.map((num) => {
      const driverStints = fStints
        .filter((s) => s.driver_number === num)
        .sort((a, b) => a.stint_number - b.stint_number)
        .map((s) => ({
          stintNumber: s.stint_number,
          compound: normalizeCompound(s.compound),
          lapStart: s.lap_start,
          lapEnd: s.lap_end,
          tyreAgeAtStart: s.tyre_age_at_start || 0,
        }));

      const pitStops = fPits
        .filter((p) => p.driver_number === num)
        .sort((a, b) => a.lap_number - b.lap_number)
        .map((p) => ({
          lap: p.lap_number,
          duration: typeof p.pit_duration === 'number' ? Number(p.pit_duration.toFixed(1)) : null,
        }));

      return {
        driverNumber: num,
        info: driverInfoMap.get(num) || null,
        stints: driverStints,
        pitStops,
      };
    });

    return res.json({ success: true, sessionKey, totalLaps, drivers });
  } catch (err: any) {
    console.error('Error building tyre strategy:', err?.message);
    return res.status(500).json({ success: false, error: 'Failed to load tyre strategy' });
  }
}
