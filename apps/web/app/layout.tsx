import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

export const metadata = {
  title: 'Product Control Plane',
  description: 'AI product operations control plane',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
