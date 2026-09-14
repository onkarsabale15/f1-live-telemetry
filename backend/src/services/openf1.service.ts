import axios from 'axios';
import { DriverInfo, SessionMeta, TyreCompound } from '../domain/models';
import { computeCircuitBounds } from '../domain/formulas';
import { ENV } from '../config/env';
import { getCatalogSessionsForYear, getCatalogSessionByKey } from './openf1.catalog';

const OPENF1_BASE = 'https://api.openf1.org/v1';
const CURRENT_YEAR = new Date().getFullYear();
// Generous enough for the larger windowed ingestion chunks (~150k rows of
// car_data per 30-minute window, CSV-encoded) without needing a separate
// timeout just for those calls.
const REQUEST_TIMEOUT = 35000;

// 2026 fallback driver roster — used ONLY when the API is unreachable
export const FALLBACK_DRIVERS_2026: DriverInfo[] = [
  { driverNumber: 1, broadcastName: 'L NORRIS', fullName: 'Lando Norris', nameAcronym: 'NOR', teamName: 'McLaren', teamColour: '#F47600', countryCode: 'GBR' },
  { driverNumber: 3, broadcastName: 'M VERSTAPPEN', fullName: 'Max Verstappen', nameAcronym: 'VER', teamName: 'Red Bull Racing', teamColour: '#4781D7', countryCode: 'NED' },
  { driverNumber: 5, broadcastName: 'G BORTOLETO', fullName: 'Gabriel Bortoleto', nameAcronym: 'BOR', teamName: 'Audi', teamColour: '#F50537', countryCode: 'BRA' },
  { driverNumber: 6, broadcastName: 'I HADJAR', fullName: 'Isack Hadjar', nameAcronym: 'HAD', teamName: 'Red Bull Racing', teamColour: '#4781D7', countryCode: 'FRA' },
  { driverNumber: 10, broadcastName: 'P GASLY', fullName: 'Pierre Gasly', nameAcronym: 'GAS', teamName: 'Alpine', teamColour: '#00A1E8', countryCode: 'FRA' },
  { driverNumber: 11, broadcastName: 'S PEREZ', fullName: 'Sergio Perez', nameAcronym: 'PER', teamName: 'Cadillac', teamColour: '#909090', countryCode: 'MEX' },
  { driverNumber: 12, broadcastName: 'K ANTONELLI', fullName: 'Kimi Antonelli', nameAcronym: 'ANT', teamName: 'Mercedes', teamColour: '#00D7B6', countryCode: 'ITA' },
  { driverNumber: 14, broadcastName: 'F ALONSO', fullName: 'Fernando Alonso', nameAcronym: 'ALO', teamName: 'Aston Martin', teamColour: '#229971', countryCode: 'ESP' },
  { driverNumber: 16, broadcastName: 'C LECLERC', fullName: 'Charles Leclerc', nameAcronym: 'LEC', teamName: 'Ferrari', teamColour: '#ED1131', countryCode: 'MON' },
  { driverNumber: 18, broadcastName: 'L STROLL', fullName: 'Lance Stroll', nameAcronym: 'STR', teamName: 'Aston Martin', teamColour: '#229971', countryCode: 'CAN' },
  { driverNumber: 23, broadcastName: 'A ALBON', fullName: 'Alexander Albon', nameAcronym: 'ALB', teamName: 'Williams', teamColour: '#1868DB', countryCode: 'THA' },
  { driverNumber: 27, broadcastName: 'N HULKENBERG', fullName: 'Nico Hulkenberg', nameAcronym: 'HUL', teamName: 'Audi', teamColour: '#F50537', countryCode: 'GER' },
  { driverNumber: 30, broadcastName: 'L LAWSON', fullName: 'Liam Lawson', nameAcronym: 'LAW', teamName: 'Racing Bulls', teamColour: '#6C98FF', countryCode: 'NZL' },
  { driverNumber: 31, broadcastName: 'E OCON', fullName: 'Esteban Ocon', nameAcronym: 'OCO', teamName: 'Haas F1 Team', teamColour: '#9C9FA2', countryCode: 'FRA' },
  { driverNumber: 41, broadcastName: 'A LINDBLAD', fullName: 'Arvid Lindblad', nameAcronym: 'LIN', teamName: 'Racing Bulls', teamColour: '#6C98FF', countryCode: 'GBR' },
  { driverNumber: 43, broadcastName: 'F COLAPINTO', fullName: 'Franco Colapinto', nameAcronym: 'COL', teamName: 'Alpine', teamColour: '#00A1E8', countryCode: 'ARG' },
  { driverNumber: 44, broadcastName: 'L HAMILTON', fullName: 'Lewis Hamilton', nameAcronym: 'HAM', teamName: 'Ferrari', teamColour: '#ED1131', countryCode: 'GBR' },
  { driverNumber: 55, broadcastName: 'C SAINZ', fullName: 'Carlos Sainz', nameAcronym: 'SAI', teamName: 'Williams', teamColour: '#1868DB', countryCode: 'ESP' },
  { driverNumber: 63, broadcastName: 'G RUSSELL', fullName: 'George Russell', nameAcronym: 'RUS', teamName: 'Mercedes', teamColour: '#00D7B6', countryCode: 'GBR' },
  { driverNumber: 77, broadcastName: 'V BOTTAS', fullName: 'Valtteri Bottas', nameAcronym: 'BOT', teamName: 'Cadillac', teamColour: '#909090', countryCode: 'FIN' },
  { driverNumber: 81, broadcastName: 'O PIASTRI', fullName: 'Oscar Piastri', nameAcronym: 'PIA', teamName: 'McLaren', teamColour: '#F47600', countryCode: 'AUS' },
  { driverNumber: 87, broadcastName: 'O BEARMAN', fullName: 'Oliver Bearman', nameAcronym: 'BEA', teamName: 'Haas F1 Team', teamColour: '#9C9FA2', countryCode: 'GBR' },
];

export interface OpenF1Session {
  session_key: number;
  session_name: string;
  session_type: string;
  circuit_key: number;
  circuit_short_name: string;
  country_name: string;
  country_code: string;
  location: string;
  date_start: string;
  date_end: string;
  year: number;
  meeting_key: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thin client over the public OpenF1 API (https://openf1.org) — every method
 * here is a single resource fetch (sessions, drivers, laps, telemetry, ...),
 * with retry/backoff on 429s and a small in-memory cache for low-churn data.
 * Never fabricates live results: `getOfflineFallback()` only ever returns
 * static reference data (calendar, roster), never invented positions or
 * telemetry — see its own doc comment for why.
 */
export class OpenF1Service {
  private cache = new Map<string, { data: any; expiry: number }>();

  /** Returns a cached value for `key` if present and not yet expired, else `null`. */
  private getFromCache<T>(key: string): T | null {
    const cached = this.cache.get(key);
    if (cached && Date.now() < cached.expiry) return cached.data as T;
    return null;
  }

  /** Stores `data` under `key` with a TTL (default 5 minutes). */
  private setCache<T>(key: string, data: T, ttlSeconds: number = 300): void {
    this.cache.set(key, { data, expiry: Date.now() + ttlSeconds * 1000 });
  }

  /**
   * @param useCsv OpenF1 supports `csv=true`, returning the same rows as a
   *   CSV body instead of JSON — measured ~62% smaller on the wire for
   *   car_data/location (no repeated key names, more compact numerics), so
   *   ingestion's two highest-volume endpoints request it explicitly. Cell
   *   values come back untyped strings; parseCsv() coerces numeric-looking
   *   ones back to numbers and normalizes the date separator, so callers see
   *   the exact same shape as the JSON path.
   */
  private async apiGet<T = any>(path: string, params: Record<string, any> = {}, retries: number = 2, useCsv: boolean = false): Promise<T[]> {
    const url = `${OPENF1_BASE}${path}`;
    const headers: Record<string, string> = {
      'User-Agent': 'ApexF1-LiveTelemetry/1.0',
    };
    if (ENV.OPENF1_API_KEY) {
      headers['Authorization'] = `Bearer ${ENV.OPENF1_API_KEY}`;
    }
    const finalParams = useCsv ? { ...params, csv: true } : params;

    try {
      const resp = await axios.get(url, {
        params: finalParams,
        headers,
        timeout: REQUEST_TIMEOUT,
        responseType: useCsv ? 'text' : 'json',
      });
      if (useCsv) return this.parseCsv(resp.data || '');
      return resp.data || [];
    } catch (err: any) {
      if (err.response?.status === 404) return [];

      if (err.response?.status === 401) {
        console.warn(`[OpenF1 401 Notice] Free global API access restricted during live sessions. Serving cached/offline data for ${path}`);
        return this.getOfflineFallback<T>(path, params);
      }

      if (err.response?.status === 429) {
        if (retries > 0) {
          console.warn(`[OpenF1 429 Notice] Rate limit encountered on ${path}. Retrying with backoff...`);
          await delay(1500 * (3 - retries));
          return this.apiGet<T>(path, params, retries - 1, useCsv);
        }
        console.warn(`[OpenF1 429 Notice] Rate limit retries exhausted for ${path}. Serving cached/offline data.`);
        return this.getOfflineFallback<T>(path, params);
      }

      const fallback = this.getOfflineFallback<T>(path, params);
      if (fallback.length > 0) return fallback;
      return [];
    }
  }

  /**
   * Parses OpenF1's `csv=true` body into the same shape as its JSON
   * response: an array of objects keyed by the header row. Cell values are
   * plain strings on the wire — numeric-looking ones are coerced to
   * numbers, timestamp-looking ones get their space separator normalized to
   * 'T' (OpenF1's CSV uses "2026-09-06 12:08:42.815+00:00"; the rest of this
   * codebase calls `new Date()` on JSON's "2026-09-06T12:08:42.815+00:00").
   * No library needed — OpenF1's telemetry fields never contain commas or
   * quoted text, so a plain split is safe here.
   */
  private parseCsv(text: string): any[] {
    if (!text || !text.trim()) return [];
    const lines = text.trim().split('\n');
    if (lines.length < 2) return [];

    const headers = lines[0].split(',').map((h) => h.trim());
    const rows: any[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(',');
      const row: any = {};
      for (let j = 0; j < headers.length; j++) {
        row[headers[j]] = this.coerceCsvCell((cells[j] ?? '').trim());
      }
      rows.push(row);
    }
    return rows;
  }

  /** Coerces one CSV cell string to null / ISO-normalized timestamp / number / plain string, in that priority order. */
  private coerceCsvCell(raw: string): any {
    if (raw === '') return null;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw)) return raw.replace(' ', 'T');
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    return raw;
  }

  /**
   * Offline fallback: ONLY for static reference data that is real, known,
   * and doesn't change lap-to-lap — the race calendar and the driver
   * roster. Never fabricate positions, gaps, laps, or telemetry here; a
   * grid order or lap invented from nothing is indistinguishable from a
   * real one on screen, which is worse than showing no data at all.
   */
  public getOfflineFallback<T = any>(path: string, params: Record<string, any> = {}): T[] {
    if (path === '/sessions') {
      if (params.session_key) {
        const session = getCatalogSessionByKey(parseInt(params.session_key, 10));
        return (session ? [session] : []) as unknown as T[];
      }
      const year = params.year ? parseInt(params.year, 10) : CURRENT_YEAR;
      return getCatalogSessionsForYear(year) as unknown as T[];
    }

    if (path === '/drivers') {
      return FALLBACK_DRIVERS_2026.map((d) => ({
        driver_number: d.driverNumber,
        broadcast_name: d.broadcastName,
        full_name: d.fullName,
        name_acronym: d.nameAcronym,
        team_name: d.teamName,
        team_colour: d.teamColour ? d.teamColour.replace('#', '') : 'FFFFFF',
        country_code: d.countryCode,
        headshot_url: d.headshotUrl,
      })) as unknown as T[];
    }

    return [];
  }

  /**
   * Finds the best session to display:
   * 1. Currently live session (highest priority)
   * 2. Most recently ended session with data
   * 3. Upcoming session (for pre-race info)
   */
  public async getLatestSession(): Promise<OpenF1Session | null> {
    const cacheKey = 'session:latest';
    const cached = this.getFromCache<OpenF1Session>(cacheKey);
    if (cached) return cached;

    let allSessions: OpenF1Session[] = [];

    for (const year of [CURRENT_YEAR, CURRENT_YEAR - 1]) {
      try {
        const sessions = await this.apiGet<OpenF1Session>('/sessions', { year });
        allSessions = allSessions.concat(sessions);
        if (sessions.length > 0) break;
      } catch (err: any) {
        console.warn(`Failed to fetch ${year} sessions: ${err.message}`);
      }
    }

    if (allSessions.length === 0) return null;

    const now = new Date();

    // 1. Currently live session
    const live = allSessions.find((s) => {
      const start = new Date(s.date_start);
      const end = new Date(s.date_end);
      // Add 30-min buffer after official end for data lag
      end.setMinutes(end.getMinutes() + 30);
      return start <= now && now <= end;
    });
    if (live) {
      this.setCache(cacheKey, live, 30);
      return live;
    }

    // 2. Most recently completed session (date_end in the past, closest to now)
    const completed = allSessions
      .filter((s) => new Date(s.date_end) <= now)
      .sort((a, b) => new Date(b.date_end).getTime() - new Date(a.date_end).getTime());

    if (completed.length > 0) {
      this.setCache(cacheKey, completed[0], 120);
      return completed[0];
    }

    // 3. Next upcoming session
    const upcoming = allSessions
      .filter((s) => new Date(s.date_start) > now)
      .sort((a, b) => new Date(a.date_start).getTime() - new Date(b.date_start).getTime());

    if (upcoming.length > 0) {
      this.setCache(cacheKey, upcoming[0], 120);
      return upcoming[0];
    }

    return allSessions[allSessions.length - 1];
  }

  /**
   * Returns whether a session is currently live
   */
  public isSessionLive(session: OpenF1Session): boolean {
    const now = new Date();
    const start = new Date(session.date_start);
    const end = new Date(session.date_end);
    end.setMinutes(end.getMinutes() + 30);
    return start <= now && now <= end;
  }

  /**
   * Returns whether a session is upcoming (not yet started)
   */
  public isSessionUpcoming(session: OpenF1Session): boolean {
    return new Date(session.date_start) > new Date();
  }

  /**
   * Fetches all sessions for a given year (cached per-year)
   */
  public async getSessionsForYear(year: number): Promise<OpenF1Session[]> {
    const cacheKey = `sessions:${year}`;
    const cached = this.getFromCache<OpenF1Session[]>(cacheKey);
    if (cached) return cached;

    try {
      const sessions = await this.apiGet<OpenF1Session>('/sessions', { year });
      if (sessions.length > 0) {
        this.setCache(cacheKey, sessions, 86400);
        return sessions;
      }
    } catch (err: any) {
      console.warn(`Failed to fetch ${year} sessions: ${err.message}`);
    }

    const fallback = getCatalogSessionsForYear(year) as unknown as OpenF1Session[];
    if (fallback.length > 0) {
      this.setCache(cacheKey, fallback, 86400);
      return fallback;
    }
    return [];
  }

  /**
   * Fetches all sessions for the current year
   */
  public async getRecentSessions(): Promise<OpenF1Session[]> {
    return this.getSessionsForYear(CURRENT_YEAR);
  }

  /**
   * Looks up a single session directly by key
   */
  public async getSessionByKey(sessionKey: number): Promise<OpenF1Session | null> {
    const cacheKey = `session:${sessionKey}`;
    const cached = this.getFromCache<OpenF1Session>(cacheKey);
    if (cached) return cached;

    try {
      const sessions = await this.apiGet<OpenF1Session>('/sessions', { session_key: sessionKey });
      if (sessions.length > 0) {
        this.setCache(cacheKey, sessions[0], 86400);
        return sessions[0];
      }
    } catch (err: any) {
      console.warn(`Failed to fetch session ${sessionKey}: ${err.message}`);
    }

    const fallback = getCatalogSessionByKey(sessionKey) as unknown as OpenF1Session | null;
    if (fallback) {
      this.setCache(cacheKey, fallback, 86400);
      return fallback;
    }
    return null;
  }

  /**
   * Fetches drivers for a session from the API
   */
  public async getDrivers(sessionKey: number): Promise<DriverInfo[]> {
    const cacheKey = `drivers:${sessionKey}`;
    const cached = this.getFromCache<DriverInfo[]>(cacheKey);
    if (cached) return cached;

    try {
      const raw = await this.apiGet('/drivers', { session_key: sessionKey });
      if (raw.length > 0) {
        const drivers: DriverInfo[] = raw.map((d: any) => ({
          driverNumber: d.driver_number,
          broadcastName: d.broadcast_name || d.full_name,
          fullName: d.full_name,
          nameAcronym: d.name_acronym,
          teamName: d.team_name,
          teamColour: d.team_colour ? `#${d.team_colour}` : '#FFFFFF',
          countryCode: d.country_code || 'F1',
          headshotUrl: d.headshot_url,
        }));
        this.setCache(cacheKey, drivers, 3600);
        return drivers;
      }
    } catch (err: any) {
      console.warn(`Could not fetch drivers for session ${sessionKey}: ${err.message}`);
    }

    return FALLBACK_DRIVERS_2026;
  }

  /**
   * Returns whether gap/interval data exists for this session type.
   * OpenF1's /intervals endpoint 404s for Qualifying and Practice sessions —
   * gaps-to-leader only make sense for Race and Sprint formats.
   */
  public sessionHasGapData(session: OpenF1Session): boolean {
    const type = (session.session_type || '').toLowerCase();
    return type === 'race';
  }

  /**
   * 2026 regulations replaced traditional DRS with a Manual Override Mode
   * on the new active-aero system — the driver-facing "wing open" concept
   * is gone from that season onward. Determined by year, since it's a fixed
   * regulatory fact rather than something to infer from live telemetry.
   */
  public sessionHasDrs(session: OpenF1Session): boolean {
    return session.year < 2026;
  }

  /**
   * A single hardcoded track outline used only when a session has no
   * location data to trace its own path from yet (e.g. right at session
   * start). `circuitKey` is accepted for a future per-circuit lookup but
   * currently unused — every caller gets the same generic loop shape purely
   * as a visual placeholder, never presented as that circuit's real layout.
   */
  public getFallbackTrackPath(circuitKey?: number): { x: number; y: number }[] {
    return [
      { x: 1228, y: -1685 }, { x: 1183, y: -2179 }, { x: 1157, y: -2463 }, { x: 1108, y: -2997 },
      { x: 1070, y: -3406 }, { x: 1037, y: -3756 }, { x: 1002, y: -4114 }, { x: 953, y: -4542 },
      { x: 890, y: -4916 }, { x: 834, y: -5135 }, { x: 730, y: -5389 }, { x: 503, y: -5650 },
      { x: 259, y: -5770 }, { x: -28, y: -5799 }, { x: -322, y: -5735 }, { x: -562, y: -5619 },
      { x: -773, y: -5459 }, { x: -1004, y: -5202 }, { x: -1181, y: -4912 }, { x: -1279, y: -4693 },
      { x: -1358, y: -4460 }, { x: -1458, y: -3989 }, { x: -1498, y: -3365 }, { x: -1499, y: -3006 },
      { x: -1494, y: -2722 }, { x: -1474, y: -2141 }, { x: -1448, y: -1669 }, { x: -1421, y: -1286 },
      { x: -1403, y: -1040 }, { x: -1350, y: -398 }, { x: -1308, y: 72 }, { x: -1260, y: 616 },
      { x: -1221, y: 1069 }, { x: -1175, y: 1613 }, { x: -1140, y: 2012 }, { x: -1099, y: 2485 },
      { x: -1070, y: 2829 }, { x: -974, y: 3940 }, { x: -928, y: 4470 }, { x: -883, y: 5001 },
      { x: -838, y: 5514 }, { x: -788, y: 6090 }, { x: -733, y: 6762 }, { x: -690, y: 7271 },
      { x: -662, y: 7614 }, { x: -646, y: 7785 }, { x: -608, y: 8045 }, { x: -581, y: 8127 },
      { x: -530, y: 8213 }, { x: -437, y: 8288 }, { x: -346, y: 8313 }, { x: -222, y: 8353 },
      { x: -155, y: 8455 }, { x: -141, y: 8553 }, { x: -143, y: 8622 }, { x: -164, y: 8751 },
      { x: -187, y: 8843 }, { x: -224, y: 8981 }, { x: -260, y: 9120 }, { x: -301, y: 9282 },
      { x: -351, y: 9503 }, { x: -389, y: 9716 }, { x: -410, y: 9893 }, { x: -427, y: 10264 },
      { x: -423, y: 10600 }, { x: -399, y: 11002 }, { x: -366, y: 11307 }, { x: -290, y: 11724 },
      { x: -55, y: 12392 }, { x: 150, y: 12760 }, { x: 407, y: 13101 }, { x: 731, y: 13413 },
      { x: 1027, y: 13634 }, { x: 1519, y: 13910 }, { x: 2121, y: 14129 }, { x: 2383, y: 14190 },
      { x: 2912, y: 14278 }, { x: 3314, y: 14324 }, { x: 3652, y: 14352 }, { x: 3960, y: 14379 },
      { x: 4531, y: 14422 }, { x: 4980, y: 14449 }, { x: 5436, y: 14469 }, { x: 5784, y: 14483 },
      { x: 5996, y: 14490 }, { x: 6384, y: 14507 }, { x: 6520, y: 14525 }, { x: 6726, y: 14587 },
      { x: 6824, y: 14645 }, { x: 6973, y: 14882 }, { x: 7110, y: 15005 }, { x: 7237, y: 15069 },
      { x: 7461, y: 15131 }, { x: 7640, y: 15164 }, { x: 7906, y: 15220 }, { x: 8159, y: 15295 },
      { x: 8541, y: 15418 }, { x: 8976, y: 15585 }, { x: 9309, y: 15702 }, { x: 9619, y: 15804 },
      { x: 9875, y: 15870 }, { x: 10162, y: 15874 }, { x: 10378, y: 15814 }, { x: 10564, y: 15701 },
      { x: 10741, y: 15502 }, { x: 10861, y: 15226 }, { x: 10909, y: 14993 }, { x: 10950, y: 14622 },
      { x: 10966, y: 14401 }, { x: 10993, y: 14002 }, { x: 11014, y: 13756 }, { x: 11059, y: 13274 },
      { x: 11064, y: 12976 }, { x: 11014, y: 12740 }, { x: 10888, y: 12538 }, { x: 10733, y: 12406 },
      { x: 10611, y: 12330 }, { x: 10399, y: 12219 }, { x: 10133, y: 12085 }, { x: 9857, y: 11938 },
      { x: 9566, y: 11782 }, { x: 9361, y: 11672 }, { x: 8908, y: 11414 }, { x: 8690, y: 11291 },
      { x: 8162, y: 10993 }, { x: 7764, y: 10757 }, { x: 7345, y: 10463 }, { x: 6918, y: 10115 },
      { x: 6467, y: 9723 }, { x: 6106, y: 9409 }, { x: 5800, y: 9143 }, { x: 5508, y: 8889 },
    ];
  }

  /**
   * Builds session metadata from an OpenF1 session response
   */
  public buildSessionMeta(session: OpenF1Session, trackPath: { x: number; y: number }[]): SessionMeta {
    const finalPath = trackPath && trackPath.length > 0 ? trackPath : this.getFallbackTrackPath(session.circuit_key);
    const bounds = computeCircuitBounds(finalPath);
    return {
      sessionKey: session.session_key,
      circuitKey: session.circuit_key,
      circuitShortName: session.circuit_short_name,
      countryName: session.country_name,
      location: session.location,
      year: session.year,
      sessionName: session.session_name,
      sessionType: session.session_type,
      hasGapData: this.sessionHasGapData(session),
      hasDrs: this.sessionHasDrs(session),
      bounds,
      trackPath: finalPath,
    };
  }

  /**
   * Fetches car location data (x, y, z coordinates)
   */
  public async getLocations(sessionKey: number, since?: string, until?: string, driverNumber?: number, useCsv: boolean = false): Promise<any[]> {
    const params: Record<string, any> = { session_key: sessionKey };
    if (since) params['date>'] = since;
    if (until) params['date<'] = until;
    if (driverNumber) params.driver_number = driverNumber;
    try {
      return await this.apiGet('/location', params, 2, useCsv);
    } catch (err: any) {
      console.warn(`Location fetch failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Fetches car telemetry data (speed, rpm, gear, throttle, brake, drs)
   */
  public async getCarData(sessionKey: number, since?: string, until?: string, useCsv: boolean = false): Promise<any[]> {
    const params: Record<string, any> = { session_key: sessionKey };
    if (since) params['date>'] = since;
    if (until) params['date<'] = until;
    try {
      return await this.apiGet('/car_data', params, 2, useCsv);
    } catch (err: any) {
      console.warn(`Car data fetch failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Fetches interval data (gap to leader, interval to car ahead)
   */
  public async getIntervals(sessionKey: number, since?: string, until?: string, useCsv: boolean = false): Promise<any[]> {
    const params: Record<string, any> = { session_key: sessionKey };
    if (since) params['date>'] = since;
    if (until) params['date<'] = until;
    try {
      return await this.apiGet('/intervals', params, 2, useCsv);
    } catch (err: any) {
      console.warn(`Intervals fetch failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Fetches position data (race standings)
   */
  public async getPositions(sessionKey: number, since?: string, until?: string): Promise<any[]> {
    const params: Record<string, any> = { session_key: sessionKey };
    if (since) params['date>'] = since;
    if (until) params['date<'] = until;
    try {
      return await this.apiGet('/position', params);
    } catch (err: any) {
      console.warn(`Position fetch failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Fetches stint/tyre data
   */
  public async getStints(sessionKey: number): Promise<any[]> {
    const cacheKey = `stints:${sessionKey}`;
    const cached = this.getFromCache<any[]>(cacheKey);
    if (cached) return cached;

    try {
      const data = await this.apiGet('/stints', { session_key: sessionKey });
      this.setCache(cacheKey, data, 15);
      return data;
    } catch (err: any) {
      console.warn(`Stints fetch failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Fetches lap data for current lap count
   */
  public async getLatestLaps(sessionKey: number, driverNumber?: number): Promise<any[]> {
    const params: Record<string, any> = { session_key: sessionKey };
    if (driverNumber) params.driver_number = driverNumber;
    try {
      return await this.apiGet('/laps', params);
    } catch (err: any) {
      console.warn(`Laps fetch failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Fetches pit stop data (lap number, duration) for a session
   */
  public async getPitStops(sessionKey: number, driverNumber?: number): Promise<any[]> {
    const params: Record<string, any> = { session_key: sessionKey };
    if (driverNumber) params.driver_number = driverNumber;
    try {
      return await this.apiGet('/pit', params);
    } catch (err: any) {
      console.warn(`Pit stops fetch failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Fetches race control messages: flags, safety car / VSC periods,
   * penalties, investigations. Low-frequency, small payload even for a
   * full race — safe to poll at the slowest tier for live sessions.
   */
  public async getRaceControl(sessionKey: number, since?: string): Promise<any[]> {
    const params: Record<string, any> = { session_key: sessionKey };
    if (since) params['date>'] = since;
    try {
      return await this.apiGet('/race_control', params);
    } catch (err: any) {
      console.warn(`Race control fetch failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Builds a track reference path from location data.
   */
  public buildTrackPath(locations: any[]): { x: number; y: number }[] {
    if (!locations || locations.length === 0) return [];

    // Group by driver, pick the driver with the most data points
    const byDriver = new Map<number, any[]>();
    for (const loc of locations) {
      const driverNum = loc.driver_number;
      if (!byDriver.has(driverNum)) byDriver.set(driverNum, []);
      byDriver.get(driverNum)!.push(loc);
    }

    let bestDriver = 0;
    let maxPoints = 0;
    byDriver.forEach((pts, driverNum) => {
      if (pts.length > maxPoints) {
        maxPoints = pts.length;
        bestDriver = driverNum;
      }
    });

    const driverLocs = byDriver.get(bestDriver) || [];
    if (driverLocs.length === 0) return [];

    driverLocs.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // Take roughly one lap worth of points (about 80-90 seconds of data)
    // At ~3 points/sec that's ~250 points. Sample to ~150.
    const lapDurationMs = 90_000;
    const startTime = new Date(driverLocs[0].date).getTime();
    const oneLap = driverLocs.filter(
      (l: any) => new Date(l.date).getTime() - startTime <= lapDurationMs
    );

    const pointsToUse = oneLap.length > 10 ? oneLap : driverLocs;
    const step = Math.max(1, Math.floor(pointsToUse.length / 150));
    const path: { x: number; y: number }[] = [];
    for (let i = 0; i < pointsToUse.length; i += step) {
      path.push({ x: pointsToUse[i].x, y: pointsToUse[i].y });
    }

    return path;
  }

  /**
   * Parses interval/gap values that can be numbers, strings ("+1 LAP"), or null
   */
  public parseInterval(value: any): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return Math.max(0, value);
    const str = String(value).trim();
    if (str.includes('LAP')) {
      const lapMatch = str.match(/(\d+)/);
      const laps = lapMatch ? parseInt(lapMatch[1], 10) : 1;
      return laps * 90;
    }
    const parsed = parseFloat(str);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }
}

export const openF1Service = new OpenF1Service();
export default openF1Service;
