import { prisma } from './db';

/**
 * The active company.
 *
 * Single-client today, so this resolves to the first (and only) company. The
 * function exists so that every query already threads a companyId and a second
 * company would not require touching the MIS engine.
 */
export async function getActiveCompany() {
  const company = await prisma.company.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!company) return null;
  return company;
}

export async function requireCompany() {
  const company = await getActiveCompany();
  if (!company) {
    throw new Error('No company configured. Run `npm run seed:admin` to create one.');
  }
  return company;
}
