import http from 'http';
import { createApp } from './app';
import { F1WebSocketGateway } from './websocket/socket.server';
import { simulationEngine } from './services/simulation.service';
import { ENV } from './config/env';

/** Wires up the HTTP server, Socket.IO gateway, and the shared live-session engine, then starts listening. */
async function bootstrap() {
  const app = createApp();
  const httpServer = http.createServer(app);

  // Initialize Socket.io Gateway
  const wsGateway = new F1WebSocketGateway(httpServer);

  // Initialize Live Data Engine — auto-detects the latest/live session from OpenF1 API
  await simulationEngine.initialize();

  httpServer.listen(ENV.PORT, () => {
    console.log(`
========================================================
   F1 Live Telemetry & Overtake Predictor Backend
   HTTP Server:    http://localhost:${ENV.PORT}
   WebSocket:      ws://localhost:${ENV.PORT}
   Health Status:  http://localhost:${ENV.PORT}/api/health
   Environment:    ${ENV.NODE_ENV}
   Data Source:    OpenF1 API (Real-Time)
========================================================
    `);
  });
}

bootstrap().catch((err) => {
  console.error('Fatal error starting backend:', err);
  process.exit(1);
});
