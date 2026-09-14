import { Request, Response } from 'express';
import { z } from 'zod';
import { openF1Service } from '../services/openf1.service';
import { replayDbService } from '../services/replay-db.service';
import { filterToLap } from '../domain/replayFilter';
import { normalizeCompound } from '../domain/tyreCompound';

const ParamsSchema = z.object({
  sessionKey: z
    .string()
    .regex(/^\d+$/, 'sessionKey must be a positive integer')
    .transform((v) => parseInt(v, 10)),
});

const QuerySchema = z
  .object({
    drivers: z.string().optional(),
    driver1: z.string().regex(/^\d+$/).transform((v) => parseInt(v, 10)).optional(),
    driver2: z.string().regex(/^\d+$/).transform((v) => parseInt(v, 10)).optional(),
    driver3: z.string().regex(/^\d+$/).transform((v) => parseInt(v, 10)).optional(),
    // Current replay/scrub position. When present, all analytics (pace,
    // stints, predicted tyre change) are computed "as of this lap" instead
    // of using the session's final, fully-raced state — so a paused or
    // in-progress replay reads like a live race at that point in time.
    uptoLap: z.string().regex(/^\d+$/).transform((v) => parseInt(v, 10)).optional(),
  })
  .refine(
    (data) => {
      if (data.drivers) {
        const parts = data.drivers.split(',').map((s) => s.trim()).filter(Boolean);
        return parts.length >= 1 && parts.length <= 3 && parts.every((p) => /^\d+$/.test(p));
      }
      return typeof data.driver1 === 'number' && typeof data.driver2 === 'number';
    },
    { message: 'Provide either "drivers" (1 to 3 comma-separated numbers) or "driver1" and "driver2"' }
  );

// Rough expected stint life in laps per compound, used only to estimate
// "predicted tyre change" — real degradation varies hugely by circuit/car,
// so this is a heuristic baseline, adjusted below by observed degradation.
const TYPICAL_STINT_LIFE: Record<string, number> = {
  SOFT: 18,
  MEDIUM: 28,
  HARD: 40,
  INTERMEDIATE: 25,
  WET: 30,
  UNKNOWN: 28,
};


interface LapTimeEntry {
  lap: number;
  time: number;
  sector1: number | null;
  sector2: number | null;
  sector3: number | null;
}

/**
 * Fits a simple linear regression (least squares) and returns the slope —
 * i.e. seconds gained/lost per lap — used as a proxy for tyre degradation
 * rate within the current stint.
 */
function computeSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den !== 0 ? num / den : 0;
}

function computeDriverSummary(laps: any[], stints: any[], pits: any[], currentLap: number, driverNumber: number) {
  const driverLaps = laps
    .filter((l) => l.driver_number === driverNumber && typeof l.lap_duration === 'number' && l.lap_duration > 0)
    .sort((a, b) => a.lap_number - b.lap_number);

  const driverStints = stints
    .filter((s) => s.driver_number === driverNumber)
    .sort((a, b) => a.stint_number - b.stint_number);

  const driverPits = pits
    .filter((p) => p.driver_number === driverNumber)
    .sort((a, b) => a.lap_number - b.lap_number);

  const lapTimes: LapTimeEntry[] = driverLaps
    .filter((l) => !l.is_pit_out_lap)
    .map((l) => ({
      lap: l.lap_number,
      time: l.lap_duration,
      sector1: typeof l.duration_sector_1 === 'number' ? l.duration_sector_1 : null,
      sector2: typeof l.duration_sector_2 === 'number' ? l.duration_sector_2 : null,
      sector3: typeof l.duration_sector_3 === 'number' ? l.duration_sector_3 : null,
    }));

  const bestLap = lapTimes.length
    ? lapTimes.reduce((best, l) => (l.time < best.time ? l : best))
    : null;

  // Exclude laps heavily affected by traffic/incidents/pit-in from the average
  const validForAvg = bestLap
    ? lapTimes.filter((l) => l.time <= bestLap.time * 1.07)
    : lapTimes;
  const avgLap = validForAvg.length
    ? validForAvg.reduce((sum, l) => sum + l.time, 0) / validForAvg.length
    : null;

  const stints_ = driverStints.map((s) => ({
    stintNumber: s.stint_number,
    compound: normalizeCompound(s.compound),
    lapStart: s.lap_start,
    lapEnd: s.lap_end,
    tyreAgeAtStart: s.tyre_age_at_start || 0,
  }));

  const pitStops = driverPits.map((p) => ({
    lap: p.lap_number,
    duration: typeof p.pit_duration === 'number' ? Number(p.pit_duration.toFixed(1)) : null,
  }));

  // Predicted tyre change: based on the current (last) stint's compound,
  // age, and the observed lap-time trend within that stint.
  const currentStint = driverStints[driverStints.length - 1] || null;
  let predictedTyreChange: any = null;

  if (currentStint) {
    const compound = normalizeCompound(currentStint.compound);
    const typicalLife = TYPICAL_STINT_LIFE[compound] ?? 28;
    const stintEnd = currentStint.lap_end || currentLap || currentStint.lap_start;
    const currentAge = Math.max(0, (currentStint.tyre_age_at_start || 0) + (stintEnd - currentStint.lap_start));

    const stintLapTimes = lapTimes
      .filter((l) => l.lap >= currentStint.lap_start && l.lap <= stintEnd)
      .map((l) => l.time);

    const degradationSlope = computeSlope(stintLapTimes);
    const lapsRemainingBaseline = Math.max(0, typicalLife - currentAge);

    // Faster-than-usual degradation shortens the predicted window; a flat
    // (or improving, e.g. fuel burn-off) trend extends it moderately.
    let estimatedLapsRemaining = lapsRemainingBaseline;
    if (degradationSlope > 0.15) {
      estimatedLapsRemaining = Math.round(lapsRemainingBaseline * 0.6);
    } else if (degradationSlope < 0.02) {
      estimatedLapsRemaining = Math.round(lapsRemainingBaseline * 1.15);
    }

    predictedTyreChange = {
      compound,
      currentAge,
      typicalStintLife: typicalLife,
      degradationSlopeSecPerLap: Number(degradationSlope.toFixed(3)),
      estimatedLapsRemaining: Math.max(0, estimatedLapsRemaining),
      confidence: stintLapTimes.length >= 6 ? 'HIGH' : stintLapTimes.length >= 3 ? 'MEDIUM' : 'LOW',
    };
  }

  return {
    driverNumber,
    lapTimes,
    bestLap,
    avgLap: avgLap !== null ? Number(avgLap.toFixed(3)) : null,
    stints: stints_,
    pitStops,
    predictedTyreChange,
  };
}

/**
 * Head-to-head driver comparison: lap-by-lap pace, tyre stint history,
 * pit stops, and a predicted next tyre change for each driver.
 */
export async function compareDrivers(req: Request, res: Response) {
  try {
    const paramsParsed = ParamsSchema.safeParse(req.params);
    const queryParsed = QuerySchema.safeParse(req.query);

    if (!paramsParsed.success) {
      return res.status(400).json({
        success: false,
        error: paramsParsed.success ? '' : paramsParsed.error.issues[0]?.message || 'Invalid sessionKey',
      });
    }
    if (!queryParsed.success) {
      return res.status(400).json({
        success: false,
        error: queryParsed.error.issues[0]?.message || 'driver1 and driver2 query params are required',
      });
    }

    const { sessionKey } = paramsParsed.data;

    let driverNumbers: number[] = [];
    if (queryParsed.data.drivers) {
      driverNumbers = queryParsed.data.drivers
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n) && n > 0);
    } else {
      if (queryParsed.data.driver1) driverNumbers.push(queryParsed.data.driver1);
      if (queryParsed.data.driver2) driverNumbers.push(queryParsed.data.driver2);
      if (queryParsed.data.driver3) driverNumbers.push(queryParsed.data.driver3);
    }

    // Deduplicate and enforce max 3
    driverNumbers = Array.from(new Set(driverNumbers)).slice(0, 3);
    if (driverNumbers.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one valid driver must be selected' });
    }

    const isArchived = await replayDbService.isFullyIngested(sessionKey);

    let laps: any[];
    let stints: any[];
    let pits: any[];
    let drivers: any[];

    if (isArchived) {
      const [{ laps: l, stints: s }, pitRows, driverInfos] = await Promise.all([
        replayDbService.getLapsAndStints(sessionKey),
        replayDbService.getPitStops(sessionKey),
        replayDbService.getDriversInfo(sessionKey),
      ]);
      laps = l;
      stints = s;
      pits = pitRows;
      drivers = driverInfos;
    } else {
      [laps, stints, pits, drivers] = await Promise.all([
        openF1Service.getLatestLaps(sessionKey),
        openF1Service.getStints(sessionKey),
        openF1Service.getPitStops(sessionKey),
        openF1Service.getDrivers(sessionKey),
      ]);
    }

    const uptoLap = queryParsed.data.uptoLap ?? null;
    const { laps: fLaps, stints: fStints, pits: fPits } = filterToLap(laps, stints, pits, uptoLap);

    const driverInfoMap = new Map(drivers.map((d) => [d.driverNumber, d]));
    const currentLap = uptoLap ?? (fLaps.length > 0 ? Math.max(...fLaps.map((l: any) => l.lap_number || 0)) : 0);

    const summaries = driverNumbers.map((num) => ({
      info: driverInfoMap.get(num) || null,
      ...computeDriverSummary(fLaps, fStints, fPits, currentLap, num),
    }));

    const hasAnyLapData = summaries.some((s) => s.lapTimes.length > 0);
    // If no full lap history exists yet (e.g. session just started or 401 lock),
    // still return the driver metadata and stint info instead of erroring out.

    const paceDeltaBest =
      summaries[0]?.bestLap && summaries[1]?.bestLap
        ? Number((summaries[0].bestLap.time - summaries[1].bestLap.time).toFixed(3))
        : null;
    const paceDeltaAvg =
      summaries[0]?.avgLap != null && summaries[1]?.avgLap != null
        ? Number((summaries[0].avgLap - summaries[1].avgLap).toFixed(3))
        : null;

    return res.json({
      success: true,
      sessionKey,
      drivers: summaries,
      driver1: summaries[0] || null,
      driver2: summaries[1] || null,
      driver3: summaries[2] || null,
      paceDeltaBest,
      paceDeltaAvg,
    });
  } catch (err: any) {
    console.error('Error comparing drivers:', err?.message);
    return res.status(500).json({ success: false, error: 'Failed to compare drivers' });
  }
}
