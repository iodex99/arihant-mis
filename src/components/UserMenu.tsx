'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { SessionUser } from '@/lib/auth';

export default function UserMenu({ user }: { user: SessionUser }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  }

  return (
    <div className="flex items-center gap-3">
      <div className="hidden text-right sm:block">
        <div className="text-xs font-medium leading-tight">{user.name}</div>
        <div className="text-xs leading-tight text-ink-faint">{user.role.toLowerCase()}</div>
      </div>
      <button onClick={signOut} disabled={busy} className="btn-ghost text-xs">
        {busy ? '…' : 'Sign out'}
      </button>
    </div>
  );
}
