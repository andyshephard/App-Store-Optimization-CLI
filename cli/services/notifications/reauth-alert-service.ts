import { ASO_ENV } from "../../shared/aso-env";
import { getMetadataValue, setMetadataValue } from "../../db/metadata";
import { logger } from "../../utils/logger";

/**
 * Emails when the Apple session dies, because nothing else tells anyone.
 *
 * A dead session is silent by design: the crawl keeps running and keeps
 * updating rank and difficulty from the public search page, so the dashboard
 * looks alive while popularity quietly stops refreshing and new keywords sit
 * unenriched. The trust cookie expires roughly monthly, so this will fire on a
 * predictable schedule and there is no one watching the box when it does.
 *
 * Deliberately fail-quiet: an alert that cannot be sent must never take down
 * the refresh it is reporting on.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const LAST_SENT_KEY = "dashboard:auth-alert:last-sent-at";

/**
 * Minimum gap between alerts for the same outage. The daily crawl will keep
 * hitting the same dead session every night; one mail per incident is a
 * reminder, one per night is noise that gets filtered.
 */
const RESEND_SUPPRESSION_MS = 24 * 60 * 60 * 1000;

export type AlertMailer = (payload: {
  from: string;
  to: string;
  subject: string;
  text: string;
}) => Promise<void>;

type AlertDeps = {
  mailer?: AlertMailer;
  now?: () => number;
  readLastSentAt?: () => string | null;
  writeLastSentAt?: (iso: string) => void;
};

function isConfigured(): boolean {
  return Boolean(ASO_ENV.resendApiKey && ASO_ENV.alertEmailTo);
}

async function sendViaResend(payload: {
  from: string;
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ASO_ENV.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: payload.from,
      to: [payload.to],
      subject: payload.subject,
      text: payload.text,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Resend returned ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`
    );
  }
}

function buildBody(dashboardUrl: string, detail: string | null): string {
  return [
    "The Apple Search Ads session used for keyword popularity has expired, and",
    "unattended reauthentication did not restore it. That usually means the",
    "two-factor trust cookie has run out, which needs a verification code and",
    "therefore a human.",
    "",
    "What still works: rank, app count, difficulty and keyword match. Those come",
    "from the public App Store search page and need no session, so the daily",
    "crawl keeps updating them.",
    "",
    "What has stopped: popularity refresh, and enrichment of any newly added",
    "keyword - those sit pending until the session is back.",
    "",
    `Fix: open ${dashboardUrl} and complete the Apple login prompt. That re-arms`,
    "the trust cookie for about another 29 days.",
    ...(detail ? ["", `Reported error: ${detail}`] : []),
  ].join("\n");
}

/**
 * Sends the reauthentication alert unless one was already sent recently.
 *
 * @returns what happened, so a caller testing the wiring can tell the
 * difference between "sent", "suppressed" and "not configured".
 */
export async function sendReauthenticationAlert(
  params: {
    detail?: string | null;
    dashboardUrl?: string;
    force?: boolean;
  } = {},
  deps: AlertDeps = {}
): Promise<"sent" | "suppressed" | "not-configured" | "failed"> {
  if (!isConfigured()) {
    logger.debug(
      "[aso-alert] reauthentication alert skipped: ASO_RESEND_API_KEY or ASO_ALERT_EMAIL_TO is unset"
    );
    return "not-configured";
  }

  const now = deps.now?.() ?? Date.now();
  const readLastSentAt =
    deps.readLastSentAt ?? (() => getMetadataValue(LAST_SENT_KEY));
  const writeLastSentAt =
    deps.writeLastSentAt ??
    ((iso: string) => setMetadataValue(LAST_SENT_KEY, iso));

  if (params.force !== true) {
    const lastSentRaw = readLastSentAt();
    const lastSent = lastSentRaw ? Date.parse(lastSentRaw) : NaN;
    if (Number.isFinite(lastSent) && now - lastSent < RESEND_SUPPRESSION_MS) {
      logger.debug(
        `[aso-alert] reauthentication alert suppressed, last sent ${lastSentRaw}`
      );
      return "suppressed";
    }
  }

  const mailer = deps.mailer ?? sendViaResend;
  const dashboardUrl =
    params.dashboardUrl ?? ASO_ENV.allowedOrigin ?? "the ASO dashboard";

  try {
    await mailer({
      from: ASO_ENV.alertEmailFrom,
      to: ASO_ENV.alertEmailTo as string,
      subject: "ASO keywords: Apple session needs reauthentication",
      text: buildBody(dashboardUrl, params.detail ?? null),
    });
  } catch (error) {
    logger.debug(
      `[aso-alert] reauthentication alert failed to send: ${String(error)}`
    );
    return "failed";
  }

  // Recorded only on success, so a Resend outage does not silently consume the
  // one alert for this incident - and never for a forced send, which is a
  // delivery test rather than an incident. Recording it would arm the
  // suppression window and swallow a real failure that happened to follow
  // within the day.
  if (params.force !== true) {
    try {
      writeLastSentAt(new Date(now).toISOString());
    } catch (error) {
      logger.debug(
        `[aso-alert] could not record alert timestamp: ${String(error)}`
      );
    }
  }
  logger.debug("[aso-alert] reauthentication alert sent");
  return "sent";
}

/**
 * Clears the suppression record after a healthy run, so the next outage alerts
 * immediately instead of waiting out a window from the previous one.
 */
export function clearReauthenticationAlertState(
  deps: Pick<AlertDeps, "writeLastSentAt"> = {}
): void {
  try {
    (
      deps.writeLastSentAt ??
      ((iso: string) => setMetadataValue(LAST_SENT_KEY, iso))
    )("");
  } catch {
    // Losing the reset only risks suppressing one alert; never worth throwing.
  }
}

function operationalAlertKey(key: string): string {
  return `dashboard:ops-alert:${key}:last-sent-at`;
}

/**
 * Health alerts (stale storefront, no completed run, restart loop), sent
 * through the same Resend path as the reauthentication alert and suppressed
 * per condition for a day. Fail-quiet for the same reason.
 */
export async function sendOperationalAlert(
  params: { key: string; subject: string; text: string },
  deps: AlertDeps = {}
): Promise<"sent" | "suppressed" | "not-configured" | "failed"> {
  if (!isConfigured()) {
    logger.warn(
      `[aso-alert] ${params.key} alert not sent: ASO_RESEND_API_KEY or ASO_ALERT_EMAIL_TO is unset. ${params.subject}`
    );
    return "not-configured";
  }
  const now = deps.now?.() ?? Date.now();
  const metadataKey = operationalAlertKey(params.key);
  const readLastSentAt =
    deps.readLastSentAt ?? (() => getMetadataValue(metadataKey));
  const writeLastSentAt =
    deps.writeLastSentAt ??
    ((iso: string) => setMetadataValue(metadataKey, iso));

  const lastSentRaw = readLastSentAt();
  const lastSent = lastSentRaw ? Date.parse(lastSentRaw) : NaN;
  if (Number.isFinite(lastSent) && now - lastSent < RESEND_SUPPRESSION_MS) {
    return "suppressed";
  }

  try {
    await (deps.mailer ?? sendViaResend)({
      from: ASO_ENV.alertEmailFrom,
      to: ASO_ENV.alertEmailTo as string,
      subject: params.subject,
      text: params.text,
    });
  } catch (error) {
    logger.warn(`[aso-alert] ${params.key} alert failed to send: ${String(error)}`);
    return "failed";
  }
  try {
    writeLastSentAt(new Date(now).toISOString());
  } catch (error) {
    logger.debug(`[aso-alert] could not record alert timestamp: ${String(error)}`);
  }
  logger.warn(`[aso-alert] ${params.key} alert sent: ${params.subject}`);
  return "sent";
}

/** Re-arms a condition once it clears, so its next occurrence alerts at once. */
export function clearOperationalAlertState(
  key: string,
  deps: Pick<AlertDeps, "readLastSentAt" | "writeLastSentAt"> = {}
): void {
  try {
    const metadataKey = operationalAlertKey(key);
    const read = deps.readLastSentAt ?? (() => getMetadataValue(metadataKey));
    if (!read()) return;
    (deps.writeLastSentAt ?? ((iso: string) => setMetadataValue(metadataKey, iso)))("");
  } catch {
    // Losing the reset only risks suppressing one alert; never worth throwing.
  }
}
