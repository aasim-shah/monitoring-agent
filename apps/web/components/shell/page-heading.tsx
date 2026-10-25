import type { ReactNode } from 'react';

export function PageHeading({
  title,
  description,
  action,
  eyebrow = 'Product operations',
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <header className="portal-page-heading">
      <div>
        <p className="portal-eyebrow">{eyebrow}</p>
        <h1 className="text-[28px] font-bold leading-[34px] tracking-tight">{title}</h1>
        {description && <p className="portal-page-description">{description}</p>}
      </div>
      {action && <div className="portal-page-actions">{action}</div>}
    </header>
  );
}
export function PageMetrics({ items }: { items: { label: string; value: ReactNode; detail: string }[] }) {
  return (
    <div className="portal-page-metrics">
      {items.map((item) => (
        <article key={item.label}>
          <p>{item.label}</p>
          <strong>{item.value}</strong>
          <span>{item.detail}</span>
        </article>
      ))}
    </div>
  );
}
