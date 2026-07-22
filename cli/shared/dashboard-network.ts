import { isIP } from "net";

function canonicalIpv6Host(host: string): string | null {
  if (isIP(host) !== 6) return null;
  try {
    return new URL(`http://[${host}]`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function normalizeDashboardBindHost(host: string): string {
  const trimmed = host.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return trimmed;
  const unwrapped = trimmed.slice(1, -1);
  return isIP(unwrapped) === 6 ? unwrapped : trimmed;
}

export function formatDashboardHttpUrl(host: string, port: number): string {
  const urlHost = isIP(host) === 6 ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

export function isLoopbackDashboardHost(host: string): boolean {
  const normalized = normalizeDashboardBindHost(host).toLowerCase();
  const hostname = normalized.endsWith(".")
    ? normalized.slice(0, -1)
    : normalized;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (isIP(hostname) === 4) return hostname.startsWith("127.");
  const canonicalIpv6 = canonicalIpv6Host(hostname);
  return (
    canonicalIpv6 === "[::1]" ||
    canonicalIpv6?.startsWith("[::ffff:7f") === true
  );
}

function isUnspecifiedDashboardHost(host: string): boolean {
  const normalized = normalizeDashboardBindHost(host);
  if (normalized === "0.0.0.0") return true;
  return canonicalIpv6Host(normalized) === "[::]";
}

export function getDashboardBrowserUrl(host: string, port: number): string {
  const normalized = normalizeDashboardBindHost(host);
  if (!isUnspecifiedDashboardHost(normalized)) {
    return formatDashboardHttpUrl(normalized, port);
  }
  return formatDashboardHttpUrl(
    isIP(normalized) === 6 ? "::1" : "127.0.0.1",
    port
  );
}

export function getDashboardExposureWarning(
  host: string,
  port: number
): string | null {
  if (isLoopbackDashboardHost(host)) return null;
  return (
    `WARNING: ASO dashboard is listening on ${formatDashboardHttpUrl(host, port)} without authentication. ` +
    "Use this only on a trusted private network or behind an authenticated reverse proxy. " +
    "Do not expose this port directly to the internet."
  );
}
