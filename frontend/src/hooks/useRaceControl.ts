'use client';

import { useEffect, useState } from 'react';
import { RaceControlResult } from '../types/f1';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000';

/**
 * Fetches the race control feed (flags, safety car/VSC, penalties) and the
 * derived track status, re-fetching whenever the replay/live lap advances —
 * same lap-driven cadence as the other analytics panels, so this stays
 * cheap even for a still-live session hitting OpenF1 directly.
 */
export function useRaceControl(sessionKey: number, currentLap?: number) {
  const [data, setData] = useState<RaceControlResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!sessionKey) return;
    let cancelled = false;

    const fetchFeed = async () => {
      setLoading((prev) => (data ? prev : true));
      try {
        const uptoLapParam = currentLap != null ? `?uptoLap=${currentLap}` : '';
        const res = await fetch(`${BACKEND_URL}/api/sessions/${sessionKey}/race-control${uptoLapParam}`);
        if (!res.ok) throw new Error('Failed to load race control feed');
        const json = await res.json();
        if (!cancelled && json.success) setData(json);
      } catch {
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchFeed();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, currentLap]);

  return { data, loading };
}
