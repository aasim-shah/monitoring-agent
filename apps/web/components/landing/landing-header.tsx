'use client';

import Link from 'next/link';
import { LumenIcon } from '@lumen/icons/react';
import { useEffect, useRef, useState } from 'react';

export function LandingHeader() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [open]);
  return (
    <header>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <nav aria-label="Main navigation">
        <Link className="wordmark" href="/">
          Product Control Plane
        </Link>
        <div className="navlinks">
          <a href="#product">Product</a>
          <a href="#how">How it works</a>
          <Link href="/login">Log in ↗</Link>
        </div>
        <button
          ref={trigger}
          type="button"
          className="mobile-toggle"
          aria-label={open ? 'Close navigation' : 'Open navigation'}
          aria-controls="landing-mobile-nav"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <LumenIcon name={open ? 'close' : 'menu'} />
        </button>
      </nav>
      {open && (
        <nav
          id="landing-mobile-nav"
          className="mobile-links"
          aria-label="Mobile navigation"
          onClick={() => setOpen(false)}
        >
          <a href="#product">Product</a>
          <a href="#how">How it works</a>
          <Link href="/login">Log in ↗</Link>
        </nav>
      )}
    </header>
  );
}
