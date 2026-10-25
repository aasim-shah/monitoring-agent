// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PortalTheme } from './portal-theme';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.portalTheme;
});

describe('PortalTheme', () => {
  it('defaults to light and persists an explicit dark choice', () => {
    render(<PortalTheme />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement.dataset.portalTheme).toBe('dark');
    expect(localStorage.getItem('pcp-appearance')).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement.dataset.portalTheme).toBe('light');
    expect(localStorage.getItem('pcp-appearance')).toBe('light');
  });

  it('reflects the preference initialized before hydration', () => {
    document.documentElement.dataset.portalTheme = 'dark';
    render(<PortalTheme />);
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
  });

  it('allows switching when browser storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError');
    });
    render(<PortalTheme />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement.dataset.portalTheme).toBe('dark');
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
  });

  it('syncs changes from another tab and returns to light when the preference is cleared', async () => {
    render(<PortalTheme />);
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'pcp-appearance', newValue: 'dark' }));
    });
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(document.documentElement.dataset.portalTheme).toBe('light');
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeInTheDocument();
  });
});
