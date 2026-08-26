import { PrismaClient } from '@prisma/client';

/**
 * A single PrismaClient per process. Next.js hot-reloads modules in
 * development, which would otherwise open a new connection pool on every edit
 * until Postgres refuses them.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.LOG_LEVEL === 'debug' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
