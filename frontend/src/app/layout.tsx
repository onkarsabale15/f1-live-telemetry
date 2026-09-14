import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'APEX F1 // Live Telemetry, Track Tracker & Overtake Predictor',
  description: 'Production Formula 1 real-time telemetry console with 60 FPS live track positions, predicted overtakes radar, and cockpit telemetry.',
};

/** Next.js root layout — sets the dark theme shell and page metadata for the whole app. */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased bg-[#07090E] text-slate-100 min-h-screen">
        {children}
      </body>
    </html>
  );
}
