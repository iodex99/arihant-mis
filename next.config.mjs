import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Pin the trace root to this project. Next infers it from the nearest
  // lockfile, and a stray package-lock.json in a parent directory makes it
  // choose that instead — which produces a standalone bundle traced from the
  // wrong tree and missing files at runtime in the container.
  outputFileTracingRoot: projectRoot,
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['exceljs', 'bcryptjs', '@prisma/client'],
  env: { APP_VERSION: process.env.npm_package_version ?? '1.0.0' },
};
export default nextConfig;
