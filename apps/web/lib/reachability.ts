/**
 * True when the `--control-url` in an install command points somewhere a server on the
 * internet cannot reach: localhost, *.localhost, loopback, or private (RFC 1918) addresses.
 */
export function isLocalControlUrl(installCommand: string): boolean {
  const match = /--control-url\s+(\S+)/.exec(installCommand);
  if (!match) return false;
  let host: string;
  try {
    host = new URL(match[1]!).hostname;
  } catch {
    return false;
  }
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '[::1]'
  );
}
