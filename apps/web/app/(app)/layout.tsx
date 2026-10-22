import type { ReactNode } from 'react';
import { AppHeader } from '@/components/shell/app-header';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-muted/40">
      <AppHeader />
      {children}
    </div>
  );
}
