import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-muted px-4 py-12">
      <p className="text-sm font-semibold tracking-wide text-muted-foreground">Product Control Plane</p>
      {children}
    </main>
  );
}
