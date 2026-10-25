import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

export const metadata = {
  title: 'Product Control Plane',
  description: 'AI product operations control plane',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-portal-theme="light" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try { document.documentElement.dataset.portalTheme = localStorage.getItem('pcp-appearance') === 'dark' ? 'dark' : 'light'; } catch { document.documentElement.dataset.portalTheme = 'light'; }`,
          }}
        />
      </head>
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
