/**
 * 2026 regulations replaced DRS with a Manual Override Mode on the new
 * active-aero system — same proximity-gated overtake aid (activate within
 * ~1s of the car ahead in a defined zone), different name. Centralizes the
 * terminology so every component shows the era-correct label instead of
 * "DRS" for a system that no longer exists from 2026 onward.
 */
export interface OvertakeAidLabels {
  short: string; // "DRS" | "OVERRIDE"
  statusOpen: string; // "OPEN" | "ACTIVE"
  statusOff: string; // "OFF"
  activeBadge: string; // "DRS ACTIVE (WING OPEN)" | "OVERRIDE ACTIVE"
  inRangeBadge: string; // "DRS IN RANGE (<1.0s)" | "OVERRIDE IN RANGE (<1.0s)"
}

export function getOvertakeAidLabels(hasDrs: boolean): OvertakeAidLabels {
  if (hasDrs) {
    return {
      short: 'DRS',
      statusOpen: 'OPEN',
      statusOff: 'OFF',
      activeBadge: 'DRS ACTIVE (WING OPEN)',
      inRangeBadge: 'DRS IN RANGE (<1.0s)',
    };
  }
  return {
    short: 'OVERRIDE',
    statusOpen: 'ACTIVE',
    statusOff: 'OFF',
    activeBadge: 'OVERRIDE ACTIVE',
    inRangeBadge: 'OVERRIDE IN RANGE (<1.0s)',
  };
}
