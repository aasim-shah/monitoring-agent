import type { ReactNode } from 'react';
import { Card, CardDescription } from '../ui/card';

export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card className="portal-auth-card w-full max-w-[440px] space-y-6">
      <div className="space-y-1">
        <h1 className="text-[28px] font-bold leading-[34px] tracking-tight">{title}</h1>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </div>
      {children}
      {footer ? <div className="text-center text-sm text-muted-foreground">{footer}</div> : null}
    </Card>
  );
}
