import Link from 'next/link';

interface Props {
  title: string;
  body: string;
  action?: { href: string; label: string };
  secondary?: { href: string; label: string };
}

export default function EmptyState({ title, body, action, secondary }: Props) {
  return (
    <div className="card card-pad py-16 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-ink-muted">{body}</p>
      {(action || secondary) && (
        <div className="mt-6 flex items-center justify-center gap-3">
          {action && <Link href={action.href} className="btn-primary">{action.label}</Link>}
          {secondary && <Link href={secondary.href} className="btn-secondary">{secondary.label}</Link>}
        </div>
      )}
    </div>
  );
}
