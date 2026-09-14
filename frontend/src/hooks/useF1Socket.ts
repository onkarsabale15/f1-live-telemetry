'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { RaceSnapshot, DriverLiveState, SessionMeta, DriverInfo, PlaybackState } from '../types/f1';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000';

export function useF1Socket() {
  const [isConnected, setIsConnected] = useState(false);
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null);
  const [drivers, setDrivers] = useState<DriverInfo[]>([]);
  const [playback, setPlayback] = useState<PlaybackState>({
    isPlaying: true,
    isLive: false,
    speed: 1,
    currentTick: 0,
    totalTicks: 0,
    sessionKey: 0,
    sessionStartMs: 0,
    sessionEndMs: 0,
    positionMs: 0,
  });
  const [currentSnapshot, setCurrentSnapshot] = useState<RaceSnapshot | null>(null);
  const [focusedDriverNumber, setFocusedDriverNumber] = useState<number>(1); // Default: race leader
  const [focusedTelemetry, setFocusedTelemetry] = useState<DriverLiveState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const focusedDriverNumberRef = useRef<number>(focusedDriverNumber);

  useEffect(() => {
    const socket = io(BACKEND_URL, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      console.log('✅ Connected to F1 Telemetry WebSocket Server');
      if (focusedDriverNumberRef.current) {
        socket.emit('client:v1:subscribe_driver', { driverNumber: focusedDriverNumberRef.current });
      }
      // The server auto-loads a default session (live, or latest completed)
      // for every new connection — see socket.server.ts's connection handler.
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    socket.on('f1:v1:session_init', (data: { sessionMeta: SessionMeta; drivers: DriverInfo[]; playback: PlaybackState }) => {
      setLoadError(null);
      setSessionMeta(data.sessionMeta);
      setDrivers(data.drivers);
      setPlayback(data.playback);
      setCurrentSnapshot(null);
    });

    socket.on('f1:v1:load_error', (data: { message: string }) => {
      setLoadError(data.message);
    });

    socket.on('f1:v1:grid_snapshot', (snapshot: RaceSnapshot) => {
      setCurrentSnapshot(snapshot);

      const driver = snapshot.grid.find((d) => d.driverNumber === focusedDriverNumberRef.current);
      if (driver) {
        setFocusedTelemetry(driver);
      }
    });

    socket.on('f1:v1:playback_state', (state: PlaybackState) => {
      setPlayback(state);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  // Driver room subscription effect: keeps socket alive while switching focused driver room
  useEffect(() => {
    if (focusedDriverNumberRef.current !== focusedDriverNumber) {
      focusedDriverNumberRef.current = focusedDriverNumber;
      if (socketRef.current && socketRef.current.connected) {
        socketRef.current.emit('client:v1:subscribe_driver', { driverNumber: focusedDriverNumber });
      }
    }
  }, [focusedDriverNumber]);

  const selectDriver = useCallback((driverNumber: number) => {
    setFocusedDriverNumber(driverNumber);
    focusedDriverNumberRef.current = driverNumber;
    if (socketRef.current && socketRef.current.connected) {
      socketRef.current.emit('client:v1:subscribe_driver', { driverNumber });
    }
  }, []);

  const sendPlaybackControl = useCallback((action: 'play' | 'pause' | 'seek', speed?: 1 | 2 | 4, progress?: number) => {
    if (socketRef.current) {
      socketRef.current.emit('client:v1:playback_control', { action, speed, progress });
    }
  }, []);

  /**
   * Loads a session for THIS tab only — every other connected browser keeps
   * whatever it was already viewing. Resolves once the server confirms the
   * load (session_init) or rejects on an explicit error / timeout, so
   * callers (Match Explorer, the archiving-complete auto-retry) can show
   * their own loading/error state around it.
   */
  const loadSession = useCallback((sessionKey?: number): Promise<void> => {
    return new Promise((resolve, reject) => {
      const socket = socketRef.current;
      if (!socket) {
        reject(new Error('Not connected'));
        return;
      }

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out loading session'));
      }, 15000);

      const onInit = () => {
        cleanup();
        resolve();
      };
      const onError = (err: { message: string }) => {
        cleanup();
        reject(new Error(err?.message || 'Failed to load session'));
      };
      function cleanup() {
        clearTimeout(timeout);
        socket!.off('f1:v1:session_init', onInit);
        socket!.off('f1:v1:load_error', onError);
      }

      socket.once('f1:v1:session_init', onInit);
      socket.once('f1:v1:load_error', onError);
      socket.emit('client:v1:load_session', { sessionKey });
    });
  }, []);

  return {
    isConnected,
    sessionMeta,
    drivers,
    playback,
    currentSnapshot,
    focusedDriverNumber,
    focusedTelemetry,
    loadError,
    selectDriver,
    sendPlaybackControl,
    loadSession,
  };
}
