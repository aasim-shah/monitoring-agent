import type { ReactNode } from 'react';

export const metadata = {
  title: 'Product Control Plane',
  description: 'AI product operations control plane',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
