'use client';

import React, { useState } from 'react';
import { useF1Socket } from '../hooks/useF1Socket';
import { useRaceControl } from '../hooks/useRaceControl';
import { Header } from '../components/navbar/Header';
import { PlaybackBar } from '../components/controls/PlaybackBar';
import { CircuitCanvas } from '../components/circuit/CircuitCanvas';
import { OvertakeRadar } from '../components/battles/OvertakeRadar';
import { TelemetryDashboard } from '../components/telemetry/TelemetryDashboard';
import { LiveLeaderboard } from '../components/leaderboard/LiveLeaderboard';
import { ErrorBoundary } from '../components/common/ErrorBoundary';
import { MatchExplorer } from '../components/explorer/MatchExplorer';
import { DriverComparison } from '../components/comparison/DriverComparison';
import { LiveComparisonPanel } from '../components/comparison/LiveComparisonPanel';
import { TyreStrategyTimeline } from '../components/strategy/TyreStrategyTimeline';
import { RaceControlFeed } from '../components/raceControl/RaceControlFeed';

export default function F1DashboardPage() {
  const {
    isConnected,
    sessionMeta,
    drivers,
    playback,
    currentSnapshot,
    focusedDriverNumber,
    focusedTelemetry,
    selectDriver,
    sendPlaybackControl,
    loadSession,
  } = useF1Socket();

  const [isExplorerOpen, setIsExplorerOpen] = useState(false);
  const [isComparisonOpen, setIsComparisonOpen] = useState(false);

  const { data: raceControl, loading: raceControlLoading } = useRaceControl(
    sessionMeta?.sessionKey || 0,
    currentSnapshot?.lapNumber
  );

  const focusedDriverInfo = drivers.find((d) => d.driverNumber === focusedDriverNumber);
  const grid = currentSnapshot?.grid || [];
  const activeBattles = currentSnapshot?.activeBattles || [];
  const hasGapData = currentSnapshot?.hasGapData ?? sessionMeta?.hasGapData ?? false;
  const hasDrs = sessionMeta?.hasDrs ?? true;

  return (
    <div className="min-h-screen bg-[#07090E] text-slate-100 flex flex-col selection:bg-f1-red selection:text-white">
      {/* Navbar */}
      <Header
        sessionMeta={sessionMeta}
        onOpenExplorer={() => setIsExplorerOpen(true)}
        onOpenComparison={() => setIsComparisonOpen(true)}
      />

      {/* Main Cockpit Workspace */}
      <main className="flex-1 max-w-[1720px] w-full mx-auto p-4 sm:p-6 space-y-4">
        {/* Playback Controls & Status Bar */}
        <PlaybackBar
          playback={playback}
          isConnected={isConnected}
          onControl={sendPlaybackControl}
          onArchivingComplete={() => loadSession(playback.sessionKey)}
        />

        {/* Race Control: flags, safety car & penalties — context for everything below */}
        <ErrorBoundary fallbackTitle="Race Control Feed Offline">
          <RaceControlFeed data={raceControl} loading={raceControlLoading} />
        </ErrorBoundary>

        {/* Upper Zone: Track Visualizer (Left) + Overtake Radar (Right) */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
          {/* 2D Circuit Map with LERP Car Dots */}
          <div className="lg:col-span-2">
            <ErrorBoundary fallbackTitle="Circuit Visualizer Offline">
              <CircuitCanvas
                sessionMeta={sessionMeta}
                grid={grid}
                drivers={drivers}
                focusedDriverNumber={focusedDriverNumber}
                trackStatus={raceControl?.trackStatus}
                onSelectDriver={selectDriver}
              />
            </ErrorBoundary>
          </div>

          {/* Predicted Overtakes Radar */}
          <div className="lg:col-span-1 min-h-[360px] lg:h-[480px]">
            <ErrorBoundary fallbackTitle="Overtake Radar Offline">
              <OvertakeRadar
                battles={activeBattles}
                hasGapData={hasGapData}
                hasDrs={hasDrs}
                onFocusBattle={selectDriver}
              />
            </ErrorBoundary>
          </div>
        </div>

        {/* Lower Zone: Live Telemetry Cockpit (Left) + Race Leaderboard (Right) */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
          {/* Left Column: Cockpit Dials + Multi-Driver Comparison Panel */}
          <div className="lg:col-span-2 space-y-4">
            <ErrorBoundary fallbackTitle="Telemetry Dashboard Offline">
              <TelemetryDashboard
                telemetry={focusedTelemetry}
                driver={focusedDriverInfo}
                hasDrs={hasDrs}
              />
            </ErrorBoundary>

            <ErrorBoundary fallbackTitle="Driver Comparison Panel Offline">
              <LiveComparisonPanel
                sessionKey={sessionMeta?.sessionKey || 0}
                drivers={drivers}
                grid={grid}
                focusedDriverNumber={focusedDriverNumber}
                currentLap={currentSnapshot?.lapNumber}
                hasDrs={hasDrs}
                onSelectDriver={selectDriver}
              />
            </ErrorBoundary>
          </div>

          {/* Classification Standings */}
          <div className="lg:col-span-1">
            <ErrorBoundary fallbackTitle="Live Leaderboard Offline">
              <LiveLeaderboard
                grid={grid}
                drivers={drivers}
                hasGapData={hasGapData}
                focusedDriverNumber={focusedDriverNumber}
                onSelectDriver={selectDriver}
              />
            </ErrorBoundary>
          </div>
        </div>

        {/* Full-Width Zone: Tyre Strategy Timeline (all drivers) */}
        <ErrorBoundary fallbackTitle="Tyre Strategy Timeline Offline">
          <TyreStrategyTimeline
            sessionKey={sessionMeta?.sessionKey || 0}
            currentLap={currentSnapshot?.lapNumber}
            grid={grid}
            focusedDriverNumber={focusedDriverNumber}
            onSelectDriver={selectDriver}
          />
        </ErrorBoundary>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-[#0B0E14] py-3 px-6 text-center text-xs font-mono text-slate-500">
        APEX F1 Live Telemetry Engine • Powered by OpenF1 API, Redis Pub/Sub, Node.js & Next.js
      </footer>

      {/* Match Explorer: browse & load any past race weekend */}
      <MatchExplorer
        isOpen={isExplorerOpen}
        onClose={() => setIsExplorerOpen(false)}
        currentSessionKey={sessionMeta?.sessionKey || 0}
        onLoadSession={loadSession}
      />

      {/* Driver Comparison: head-to-head pace, tyre strategy & predicted pit windows */}
      <DriverComparison
        isOpen={isComparisonOpen}
        onClose={() => setIsComparisonOpen(false)}
        sessionKey={sessionMeta?.sessionKey || 0}
        drivers={drivers}
        defaultDriver1={focusedDriverNumber}
        currentLap={currentSnapshot?.lapNumber}
      />
    </div>
  );
}
