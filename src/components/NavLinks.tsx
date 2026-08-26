'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import type { UserRole } from '@prisma/client';

const LINKS = [
  { href: '/', label: 'Dashboard', exact: true },
  { href: '/mis', label: 'Tabular MIS' },
  { href: '/analysis', label: 'Analysis' },
  { href: '/drill', label: 'Drill-down' },
  { href: '/imports', label: 'Imports' },
  { href: '/admin', label: 'Admin', adminOnly: true },
];

export default function NavLinks({ role }: { role: UserRole }) {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1 overflow-x-auto">
      {LINKS.filter((l) => !l.adminOnly || role === 'ADMIN').map((link) => {
        const active = link.exact ? pathname === link.href : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
              active ? 'bg-accent-soft text-accent' : 'text-ink-muted hover:bg-canvas hover:text-ink',
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
