import * as crypto from "crypto";
import * as http from "http";
import { sendApiError } from "./http-utils";
import { ASO_ENV } from "../shared/aso-env";

/**
 * Paths served without a token so an uptime probe or load balancer can reach
 * them. `/health` and `/livez` are static JSON responses that touch neither
 * the database nor Apple, so exposing them leaks nothing. The truthful report
 * at `/api/aso/health` stays behind the token.
 */
const OPEN_PATHS = new Set(["/health", "/livez"]);

/**
 * The only requests `ASO_API_READ_TOKEN` may make: GETs of pure database
 * reads. Anything else - writes, the dashboard bundle, endpoints that reach
 * out to Apple as a side effect - needs the full token.
 */
export const READ_TOKEN_PATHS = new Set([
  "/api/aso/keywords",
  "/api/aso/position-history",
  "/api/aso/autocomplete",
  "/api/aso/refresh-status",
  "/api/aso/health",
  "/api/aso/v1/observations",
  "/api/aso/storefronts",
]);

function digest(value: string): Buffer {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

/**
 * Constant-time comparison. Hashing first is deliberate: `timingSafeEqual`
 * throws when the buffers differ in length, which would both leak the expected
 * token length and turn a wrong guess into a 500.
 */
function safeEquals(a: string, b: string): boolean {
  return crypto.timingSafeEqual(digest(a), digest(b));
}

export function extractBearerToken(req: http.IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (typeof raw !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1].trim() : null;
}

/**
 * Cross-site request forgery guard for state-changing requests.
 *
 * Needed because the browser reaches this server through a reverse proxy that
 * authenticates the user and injects the token, so a request originating from
 * another site would carry credentials automatically. Requests with no `Origin`
 * header (curl, n8n, any server-to-server client) are allowed through — those
 * are not browser-driven and cannot be forged this way.
 */
function isCrossOriginWrite(req: http.IncomingMessage): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return false;
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin === "") return false;
  const allowed = ASO_ENV.allowedOrigin;
  return allowed == null || origin !== allowed;
}

/**
 * Gate every request behind `ASO_API_TOKEN`.
 *
 * With no token configured this is a no-op, so a local run on loopback behaves
 * exactly as before. `startDashboard` refuses to bind to a non-loopback host
 * without a token, so "reachable but unauthenticated" is unreachable rather
 * than merely warned about.
 *
 * The whole surface is covered, including `/` and the static bundle, so a route
 * added later cannot accidentally be public.
 *
 * @returns true when the request may proceed; otherwise responds and returns false.
 */
export function enforceRequestAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string
): boolean {
  const expected = ASO_ENV.apiToken;
  if (!expected) return true;
  if (OPEN_PATHS.has(pathname)) return true;

  const presented = extractBearerToken(req);
  const readToken = ASO_ENV.apiReadToken;
  if (
    presented != null &&
    readToken != null &&
    !safeEquals(presented, expected) &&
    safeEquals(presented, readToken)
  ) {
    const method = (req.method ?? "GET").toUpperCase();
    if ((method === "GET" || method === "HEAD") && READ_TOKEN_PATHS.has(pathname)) {
      return true;
    }
    sendApiError(
      res,
      403,
      "AUTHORIZATION_FAILED",
      "This token is read-only and cannot call this endpoint."
    );
    return false;
  }
  if (presented == null || !safeEquals(presented, expected)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="aso"');
    sendApiError(res, 401, "AUTH_REQUIRED", "Missing or invalid API token.");
    return false;
  }

  if (isCrossOriginWrite(req)) {
    sendApiError(
      res,
      403,
      "AUTHORIZATION_FAILED",
      "Cross-origin request rejected."
    );
    return false;
  }

  return true;
}
