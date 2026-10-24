import { statfsSync } from 'node:fs';

/**
 * Refuses to start a Docker-heavy suite when the disk is nearly full. A full disk corrupts Docker
 * Desktop's VM disk (I/O errors, lost build cache) instead of failing cleanly.
 */
export function assertFreeDisk(minGb = Number(process.env.PCP_MIN_FREE_GB ?? 25), path = '/'): void {
  const s = statfsSync(path);
  const freeGb = (s.bavail * s.bsize) / 1024 ** 3;
  if (freeGb < minGb)
    throw new Error(
      `Not enough free disk: ${freeGb.toFixed(1)} GB free, need ${minGb} GB. ` +
        'Free space first, e.g. `docker builder prune -af` (never `docker volume prune` on a dev machine).',
    );
}
