import type { ReactNode } from 'react';
import './portal.css';
import { AppHeader } from '@/components/shell/app-header';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="portal min-h-screen" data-brand="orange">
      <AppHeader />
      {children}
    </div>
  );
}
