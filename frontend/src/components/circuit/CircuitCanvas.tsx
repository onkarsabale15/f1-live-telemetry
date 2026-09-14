'use client';

import React, { useEffect, useRef } from 'react';
import { SessionMeta, DriverLiveState, DriverInfo, TrackStatus } from '../../types/f1';
import { getTrackStatusStyle } from '../../utils/trackStatus';
import { Flag } from 'lucide-react';

interface CircuitCanvasProps {
  sessionMeta: SessionMeta | null;
  grid: DriverLiveState[];
  drivers: DriverInfo[];
  focusedDriverNumber: number;
  trackStatus?: TrackStatus;
  onSelectDriver: (driverNumber: number) => void;
}

interface InterpolatedCar {
  driverNumber: number;
  currentX: number;
  currentY: number;
  targetX: number;
  targetY: number;
  speed: number;
  position: number;
}

/**
 * The 2D track map — draws the circuit outline (recoloring/pulsing for an
 * active flag or safety car period) and every car as a LERP-animated dot on
 * an HTML canvas at 60fps, smoothing the ~1-4Hz server updates into fluid
 * motion. Click-to-focus hit-tests against each car's interpolated
 * position, not its last raw server position.
 */
export const CircuitCanvas: React.FC<CircuitCanvasProps> = ({
  sessionMeta,
  grid,
  drivers,
  focusedDriverNumber,
  trackStatus,
  onSelectDriver,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const carsRef = useRef<Map<number, InterpolatedCar>>(new Map());
  const driversMap = useRef<Map<number, DriverInfo>>(new Map());

  // Dynamic High-DPI Auto-Resizing via ResizeObserver
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleResize = () => {
      const rect = container.getBoundingClientRect();
      const canvas = canvasRef.current;
      if (!canvas) return;

      const dpr = window.devicePixelRatio || 1;
      const displayWidth = Math.floor(rect.width);
      const displayHeight = Math.floor(rect.height);

      if (displayWidth > 0 && displayHeight > 0) {
        canvas.width = Math.floor(displayWidth * dpr);
        canvas.height = Math.floor(displayHeight * dpr);
      }
    };

    handleResize();

    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  // Update drivers lookup
  useEffect(() => {
    driversMap.current.clear();
    drivers.forEach((d) => driversMap.current.set(d.driverNumber, d));
  }, [drivers]);

  // Update target coordinates when grid updates
  useEffect(() => {
    if (!grid || grid.length === 0) return;

    grid.forEach((car) => {
      const existing = carsRef.current.get(car.driverNumber);
      if (existing) {
        existing.targetX = car.x;
        existing.targetY = car.y;
        existing.speed = car.speed;
        existing.position = car.position;
      } else {
        carsRef.current.set(car.driverNumber, {
          driverNumber: car.driverNumber,
          currentX: car.x,
          currentY: car.y,
          targetX: car.x,
          targetY: car.y,
          speed: car.speed,
          position: car.position,
        });
      }
    });
  }, [grid]);

  // 60 FPS Animation & LERP Loop
  useEffect(() => {
    let animationFrameId: number;

    const render = () => {
      const canvas = canvasRef.current;
      if (!canvas || !sessionMeta) {
        animationFrameId = requestAnimationFrame(render);
        return;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const width = canvas.width / dpr;
      const height = canvas.height / dpr;

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const bounds = sessionMeta.bounds;
      const padding = 45;

      // Clear canvas
      ctx.fillStyle = '#0F1218';
      ctx.fillRect(0, 0, width, height);

      // Scale calculations (Preserving aspect ratio)
      const innerW = width - padding * 2;
      const innerH = height - padding * 2;
      const scale = Math.min(innerW / bounds.width, innerH / bounds.height);
      const offsetX = (width - bounds.width * scale) / 2;
      const offsetY = (height - bounds.height * scale) / 2;

      const worldToScreen = (wx: number, wy: number) => {
        const sx = offsetX + (wx - bounds.minX) * scale;
        // Invert Y for canvas
        const sy = height - (offsetY + (wy - bounds.minY) * scale);
        return { x: sx, y: sy };
      };

      // 1. Draw Circuit Outer Glow & Asphalt Track
      const trackPoints = sessionMeta.trackPath;
      if (trackPoints.length > 2) {
        ctx.beginPath();
        const start = worldToScreen(trackPoints[0].x, trackPoints[0].y);
        ctx.moveTo(start.x, start.y);

        for (let i = 1; i < trackPoints.length; i++) {
          const pt = worldToScreen(trackPoints[i].x, trackPoints[i].y);
          ctx.lineTo(pt.x, pt.y);
        }
        ctx.closePath();

        // Track Outer Border / Curb glow — recolors and pulses for an
        // active flag/safety car period, matching a broadcast graphic.
        const statusStyle = getTrackStatusStyle(trackStatus);
        const pulse = statusStyle.isHazard ? 0.5 + 0.5 * Math.sin(Date.now() / 300) : 0;
        ctx.strokeStyle = statusStyle.isHazard ? statusStyle.hex : '#2A3447';
        ctx.lineWidth = statusStyle.isHazard ? 14 + pulse * 5 : 14;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (statusStyle.isHazard) {
          ctx.shadowColor = statusStyle.hex;
          ctx.shadowBlur = 8 + pulse * 18;
        }
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Track Asphalt
        ctx.strokeStyle = '#181E29';
        ctx.lineWidth = 10;
        ctx.stroke();

        // Track Centerline
        ctx.strokeStyle = '#323E54';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 6]);
        ctx.stroke();
        ctx.setLineDash([]); // Reset dash

        // Draw Start/Finish Line
        const sf = worldToScreen(trackPoints[0].x, trackPoints[0].y);
        ctx.save();
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(sf.x - 3, sf.y - 8, 6, 16);
        ctx.restore();
      }

      // 2. Draw Moving Car Markers with LERP (Linear Interpolation)
      const lerpFactor = 0.15; // Smooth 60fps convergence towards 4Hz updates

      carsRef.current.forEach((car) => {
        // Interpolate world coordinates
        car.currentX += (car.targetX - car.currentX) * lerpFactor;
        car.currentY += (car.targetY - car.currentY) * lerpFactor;

        const screenPos = worldToScreen(car.currentX, car.currentY);
        const driverInfo = driversMap.current.get(car.driverNumber);
        const teamColor = driverInfo?.teamColour || '#FFFFFF';
        const isFocused = car.driverNumber === focusedDriverNumber;

        // Draw Pulsing Ring for Focused Driver
        if (isFocused) {
          ctx.beginPath();
          ctx.arc(screenPos.x, screenPos.y, 14, 0, Math.PI * 2);
          ctx.strokeStyle = teamColor;
          ctx.lineWidth = 2.5;
          ctx.shadowColor = teamColor;
          ctx.shadowBlur = 12;
          ctx.stroke();
          ctx.shadowBlur = 0; // Reset blur
        }

        // Draw Car Dot Base
        ctx.beginPath();
        ctx.arc(screenPos.x, screenPos.y, isFocused ? 7 : 5, 0, Math.PI * 2);
        ctx.fillStyle = teamColor;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#000000';
        ctx.stroke();

        // Draw Driver Label
        ctx.font = isFocused ? 'bold 11px monospace' : '9px monospace';
        ctx.fillStyle = isFocused ? '#FFFFFF' : '#CBD5E1';
        ctx.textAlign = 'center';
        const label = driverInfo?.nameAcronym || `${car.driverNumber}`;
        ctx.fillText(label, screenPos.x, screenPos.y - 9);
      });

      ctx.restore();

      animationFrameId = requestAnimationFrame(render);
    };

    animationFrameId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animationFrameId);
  }, [sessionMeta, focusedDriverNumber, trackStatus]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-[360px] sm:h-[420px] lg:h-[480px] bg-[#0F1218] rounded-xl border border-f1-border overflow-hidden shadow-2xl flex items-center justify-center"
    >
      {/* Circuit Header Overlay */}
      <div className="absolute top-3 left-4 z-10 flex items-center gap-3">
        <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
          {sessionMeta ? `${sessionMeta.location} • ${sessionMeta.circuitShortName}` : 'Circuit Tracking Engine'}
        </span>
      </div>

      {/* Flag / Safety Car Status Banner */}
      {trackStatus && trackStatus !== 'GREEN' && (
        <div
          className={`absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-mono font-black text-[11px] uppercase tracking-wide shadow-lg ${
            getTrackStatusStyle(trackStatus).badgeClass
          } ${getTrackStatusStyle(trackStatus).isHazard ? 'animate-pulse' : ''}`}
        >
          <Flag className="w-3.5 h-3.5" />
          {getTrackStatusStyle(trackStatus).label}
        </div>
      )}

      {/* Speed Legend */}
      <div className="absolute top-3 right-4 z-10 text-[11px] font-mono text-slate-400 bg-slate-900/80 px-2.5 py-1 rounded border border-slate-700/60 backdrop-blur-sm">
        Sampling: <span className="text-emerald-400 font-semibold">4.0 Hz (60 FPS LERP)</span>
      </div>

      {/* HTML5 Canvas */}
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-crosshair block"
        onClick={(e) => {
          // Allow clicking nearest driver to focus with dynamic dimension normalization
          const canvas = canvasRef.current;
          if (!canvas || !sessionMeta) return;
          const rect = canvas.getBoundingClientRect();
          const clickX = e.clientX - rect.left;
          const clickY = e.clientY - rect.top;

          const dpr = window.devicePixelRatio || 1;
          const width = canvas.width / dpr;
          const height = canvas.height / dpr;

          const bounds = sessionMeta.bounds;
          const padding = 45;
          const innerW = width - padding * 2;
          const innerH = height - padding * 2;
          const scale = Math.min(innerW / bounds.width, innerH / bounds.height);
          const offsetX = (width - bounds.width * scale) / 2;
          const offsetY = (height - bounds.height * scale) / 2;

          let closestDriver = focusedDriverNumber;
          let minDistance = 25; // Click radius in logical pixels

          carsRef.current.forEach((car) => {
            const sx = offsetX + (car.currentX - bounds.minX) * scale;
            const sy = height - (offsetY + (car.currentY - bounds.minY) * scale);
            const dist = Math.hypot(clickX - sx, clickY - sy);
            if (dist < minDistance) {
              minDistance = dist;
              closestDriver = car.driverNumber;
            }
          });

          if (closestDriver !== focusedDriverNumber) {
            onSelectDriver(closestDriver);
          }
        }}
      />
    </div>
  );
};

export default CircuitCanvas;
