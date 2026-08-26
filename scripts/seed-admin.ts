/**
 * Create the organization, company and first administrator.
 * Safe to re-run: existing records are left alone.
 *
 *   npm run seed:admin -- --email you@example.com --password 'secret' --name 'Your Name'
 */
import { prisma } from '../src/lib/db';
import { hashPassword } from '../src/lib/auth';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const env = process.env[`SEED_${name.toUpperCase()}`];
  if (env) return env;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing --${name}`);
}

async function main() {
  const email = arg('email', 'admin@arihant.local').toLowerCase();
  const password = arg('password', 'ChangeMe123!');
  const name = arg('name', 'Administrator');

  const org = await prisma.organization.upsert({
    where: { slug: 'arihant' },
    create: { name: 'Arihant Academy', slug: 'arihant' },
    update: {},
  });

  const company = await prisma.company.upsert({
    where: { organizationId_name: { organizationId: org.id, name: 'Arihant Academy' } },
    create: { organizationId: org.id, name: 'Arihant Academy', currency: 'INR' },
    update: {},
  });

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`User ${email} already exists (role ${existing.role}); leaving it unchanged.`);
  } else {
    const user = await prisma.user.create({
      data: { email, name, passwordHash: await hashPassword(password), role: 'ADMIN' },
    });
    console.log(`Created admin ${user.email}`);
    if (password === 'ChangeMe123!') {
      console.log('\n  WARNING: the default password was used. Change it after first login.\n');
    }
  }

  console.log(`Organization: ${org.name} (${org.id})`);
  console.log(`Company:      ${company.name} (${company.id})`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
