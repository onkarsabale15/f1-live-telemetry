/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produces a minimal, self-contained server bundle (.next/standalone) in
  // addition to the normal build output — used by frontend/Dockerfile to
  // keep the local Docker image small. Doesn't change `next dev` or a plain
  // `next build && next start` outside Docker (e.g. on Render), which keep
  // working exactly as before.
  output: 'standalone',
};

module.exports = nextConfig;
