import '../(app)/portal.css';
import { PortalTheme } from '@/components/shell/portal-theme';
import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main
      data-brand="orange"
      className="portal portal-auth flex min-h-screen flex-col items-center justify-center gap-6 bg-muted px-4 py-12"
    >
      <div className="absolute right-4 top-4">
        <PortalTheme />
      </div>
      <p className="text-sm font-semibold tracking-wide text-muted-foreground">Product Control Plane</p>
      {children}
    </main>
  );
}
