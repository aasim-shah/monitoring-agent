'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { relativeTime } from '@/lib/relative-time';

export interface AssetRow {
  id: string;
  name: string;
  assetType: string;
  lifecycle: string;
  source: string;
  lastSeenAt: string;
}

const selectClass = 'h-9 rounded-md border border-border bg-background px-2 text-sm';

/** Assets of the product (WB-10 §8 Inventory), filterable by type and lifecycle. */
export function InventoryTable({ assets, basePath }: { assets: AssetRow[]; basePath: string }) {
  const [type, setType] = useState('');
  const [lifecycle, setLifecycle] = useState('');
  const types = [...new Set(assets.map((a) => a.assetType))].sort();
  const lifecycles = [...new Set(assets.map((a) => a.lifecycle))].sort();
  const shown = assets.filter(
    (a) => (!type || a.assetType === type) && (!lifecycle || a.lifecycle === lifecycle),
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3 text-sm">
        <label className="flex items-center gap-2">
          Type
          <select
            aria-label="Type"
            className={selectClass}
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            <option value="">All</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Lifecycle
          <select
            aria-label="Lifecycle"
            className={selectClass}
            value={lifecycle}
            onChange={(e) => setLifecycle(e.target.value)}
          >
            <option value="">All</option>
            {lifecycles.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Asset</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Lifecycle</th>
              <th className="px-4 py-2 font-medium">Source</th>
              <th className="px-4 py-2 font-medium">Last seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.map((a) => (
              <tr key={a.id}>
                <td className="px-4 py-2">
                  <Link
                    href={`${basePath}/${a.id}`}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {a.name}
                  </Link>
                </td>
                <td className="px-4 py-2">{a.assetType}</td>
                <td className="px-4 py-2">
                  <Badge className={a.lifecycle === 'missing' ? 'border-amber-500/40 text-amber-600' : ''}>
                    {a.lifecycle}
                  </Badge>
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{a.source.replace('_', ' ')}</td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{relativeTime(a.lastSeenAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
