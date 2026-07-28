import { version } from "../../../package.json";
import { initializeBugsnag } from "../../shared/telemetry/bugsnag-shared";
import { initializePostHog } from "../../shared/telemetry/posthog-shared";

/**
 * Fork change: upstream hardcodes its own PostHog project key here, so every
 * command run by anyone lands in the upstream author's analytics. Blanked so
 * telemetry is opt-in — `initializePostHog` no-ops on an empty key. Set
 * ASO_POSTHOG_API_KEY (and optionally ASO_POSTHOG_HOST) to send events to your
 * own project.
 *
 * Bugsnag needs no equivalent change: its key is the build-time placeholder
 * `__ASO_PACKAGED_BUGSNAG_API_KEY__`, only substituted when upstream publishes,
 * so local builds already report nowhere unless BUGSNAG_API_KEY is set.
 */
const DEFAULT_POSTHOG_API_KEY = "";

const isDevelopment = process.env.NODE_ENV == "development";
const bugsnagApiKey = process.env.BUGSNAG_API_KEY?.trim();
initializeBugsnag({
  isDevelopment,
  ...(bugsnagApiKey ? { apiKey: bugsnagApiKey } : {}),
  appVersion: version,
});

const posthogApiKey = process.env.ASO_POSTHOG_API_KEY?.trim() || DEFAULT_POSTHOG_API_KEY;
const posthogHost = process.env.ASO_POSTHOG_HOST?.trim();
initializePostHog({
  isDevelopment,
  apiKey: posthogApiKey,
  ...(posthogHost ? { host: posthogHost } : {}),
});
