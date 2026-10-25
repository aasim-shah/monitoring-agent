'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

export function PortalTheme() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const sync = () => setDark(document.documentElement.dataset.portalTheme === 'dark');
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-portal-theme'] });
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'pcp-appearance' || event.key === null) {
        document.documentElement.dataset.portalTheme = event.newValue === 'dark' ? 'dark' : 'light';
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      observer.disconnect();
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return (
    <button
      type="button"
      className="portal-theme"
      aria-label={`Switch to ${dark ? 'light' : 'dark'} theme`}
      title={`Switch to ${dark ? 'light' : 'dark'} theme`}
      onClick={() => {
        const value = !dark;
        setDark(value);
        document.documentElement.dataset.portalTheme = value ? 'dark' : 'light';
        try {
          localStorage.setItem('pcp-appearance', value ? 'dark' : 'light');
        } catch {
          // Appearance still works for this visit when browser storage is unavailable.
        }
      }}
    >
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}
