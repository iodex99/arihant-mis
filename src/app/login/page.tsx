import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import LoginForm from './LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if (await getSessionUser()) redirect('/');

  // A fresh install has no users; say so rather than showing a form nobody can
  // pass through.
  const userCount = await prisma.user.count().catch(() => -1);

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Arihant Academy</h1>
          <p className="mt-1 text-sm text-ink-muted">Financial MIS</p>
        </div>

        {userCount === 0 ? (
          <div className="card card-pad text-sm">
            <h2 className="font-semibold">No accounts yet</h2>
            <p className="mt-2 text-ink-muted">
              This installation has no users. Create the first administrator on the server:
            </p>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-canvas p-3 text-xs">
{`npm run seed:admin -- \
  --email you@example.com \
  --password 'a-strong-password' \
  --name 'Your Name'`}
            </pre>
          </div>
        ) : userCount < 0 ? (
          <div className="card card-pad text-sm">
            <h2 className="font-semibold text-negative">Database unavailable</h2>
            <p className="mt-2 text-ink-muted">
              The application could not reach PostgreSQL. Check that the database container is
              running and that <code className="rounded bg-canvas px-1">DATABASE_URL</code> is
              correct, then reload this page.
            </p>
          </div>
        ) : (
          <LoginForm />
        )}
      </div>
    </main>
  );
}
