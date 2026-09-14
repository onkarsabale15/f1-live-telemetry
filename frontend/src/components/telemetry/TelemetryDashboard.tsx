'use client';

import React from 'react';
import { DriverLiveState, DriverInfo } from '../../types/f1';
import { CockpitGauge } from './CockpitGauge';
import { PedalMeters } from './PedalMeters';
import { GearDrsIndicator } from './GearDrsIndicator';

interface TelemetryDashboardProps {
  telemetry: DriverLiveState | null;
  driver: DriverInfo | undefined;
  hasDrs?: boolean;
}

export const TelemetryDashboard: React.FC<TelemetryDashboardProps> = ({ telemetry, driver, hasDrs = true }) => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <CockpitGauge telemetry={telemetry} driver={driver} />
      <PedalMeters
        throttle={telemetry?.throttle || 0}
        brake={telemetry?.brake || 0}
      />
      <GearDrsIndicator
        gear={telemetry?.gear || 0}
        drs={telemetry?.drs || false}
        compound={telemetry?.compound || 'UNKNOWN'}
        tyreAge={telemetry ? telemetry.tyreAge : null}
        hasDrs={hasDrs}
      />
    </div>
  );
};

export default TelemetryDashboard;
