import type { Metadata } from 'next';
import { LandingPage } from '@/components/landing/landing-page';

export const metadata: Metadata = {
  title: 'Product Control Plane — Your product, in one workspace',
  description:
    'Connect your websites, apps, servers, databases, and analytics. Monitor product health, investigate with evidence, and review the next step in one workspace.',
};

export default function HomePage() {
  return <LandingPage />;
}
