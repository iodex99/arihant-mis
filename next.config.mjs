/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['exceljs', 'bcryptjs', '@prisma/client'],
  env: { APP_VERSION: process.env.npm_package_version ?? '1.0.0' },
};
export default nextConfig;
