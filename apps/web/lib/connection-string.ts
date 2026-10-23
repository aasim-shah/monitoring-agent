/** What the dialog needs from a pasted connection string; the password is never extracted or sent in config. */
export interface ConnectionTarget {
  engine: 'postgres' | 'mysql' | 'mongodb';
  host: string;
  port: number;
  database?: string;
  srv: boolean;
}

const DEFAULT_PORT = { postgres: 5432, mysql: 3306, mongodb: 27017 } as const;

export function readConnectionString(uri: string): ConnectionTarget {
  const s = uri.trim();
  const scheme = /^([a-z+]+):\/\//i.exec(s)?.[1]?.toLowerCase();
  const engine =
    scheme === 'postgres' || scheme === 'postgresql'
      ? 'postgres'
      : scheme === 'mysql'
        ? 'mysql'
        : scheme === 'mongodb' || scheme === 'mongodb+srv'
          ? 'mongodb'
          : undefined;
  if (!engine)
    throw new Error('The connection string must start with postgres://, mysql://, or mongodb(+srv)://');
  const m = /^[a-z+]+:\/\/(?:[^@/]*@)?([^/?#]+)(?:\/([^?#]*))?/i.exec(s);
  if (!m) throw new Error('The connection string is not a valid URI');
  const first = m[1]!.split(',')[0]!;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(first);
  const host = bracketed ? bracketed[1]! : first.replace(/:\d+$/, '');
  const port = bracketed?.[2] ?? /:(\d+)$/.exec(first)?.[1];
  if (!host) throw new Error('The connection string has no host');
  let database: string | undefined;
  try {
    database = m[2] ? decodeURIComponent(m[2]) : undefined;
  } catch {
    database = m[2];
  }
  return {
    engine,
    host,
    port: port ? Number(port) : DEFAULT_PORT[engine],
    ...(database ? { database } : {}),
    srv: scheme === 'mongodb+srv',
  };
}

/** Providers that sign with their own certificate authority (encrypted, not verifiable with public roots). */
export const ownCaHost = (host: string) => /\.supabase\.(co|com)$/i.test(host);
