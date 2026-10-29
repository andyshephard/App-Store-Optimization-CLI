/**
 * Per-host request limiter for every call to Apple.
 *
 * Pacing used to come from fixed sleeps between batches and storefronts, so
 * the real request rate depended on Apple's latency and on how many keywords a
 * batch held. This makes the rate explicit: each host class has a cap in
 * requests per minute, and requests are spaced at least 60s / rate apart, so
 * no 60-second window ever sees more than `rate` requests to that host -
 * however many workers are waiting. Concurrency settings only fill the
 * schedule faster; they can never exceed it.
 *
 * Adaptive guard (AIMD): a throttle answer (429, 503, and 403 where that host
 * uses 403 for throttling) halves the host's effective rate and holds it there
 * for 30 minutes, then recovers additively towards the configured cap - which
 * is the hard ceiling.
 */

import { logger } from "../utils/logger";

export type AppleHostClass = "mzsearch" | "searchpage" | "lookup" | "popularity";

export const APPLE_HOST_CLASSES: AppleHostClass[] = [
  "mzsearch",
  "searchpage",
  "lookup",
  "popularity",
];

/**
 * Defaults are today's effective rates, derived in docs/deployment.md
 * ("Request rates") from the pre-limiter pacing, so switching the limiter on
 * does not raise any rate.
 */
export const DEFAULT_RATE_PER_MIN: Record<AppleHostClass, number> = {
  mzsearch: 30,
  searchpage: 30,
  lookup: 15,
  popularity: 4,
};

const RATE_ENV: Record<AppleHostClass, string> = {
  mzsearch: "ASO_RATE_MZSEARCH_PER_MIN",
  searchpage: "ASO_RATE_SEARCHPAGE_PER_MIN",
  lookup: "ASO_RATE_LOOKUP_PER_MIN",
  popularity: "ASO_RATE_POPULARITY_PER_MIN",
};

/** How long a throttle keeps the rate halved before recovery starts. */
export const THROTTLE_HOLD_MS = 30 * 60 * 1000;
/** Recovery: add this share of the cap per step... */
const RECOVERY_STEP_SHARE = 0.1;
/** ...every this long, until back at the cap. */
const RECOVERY_STEP_MS = 5 * 60 * 1000;
/** Never slow a host below this, so a run always finishes eventually. */
const MIN_RATE_PER_MIN = 1;

/** Which limiter a URL belongs to; null = not limited. */
export function classifyAppleHost(url: string): AppleHostClass | null {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
  // MZSearch order and MZSearchHints (autocomplete) share this host.
  if (host === "search.itunes.apple.com") return "mzsearch";
  if (host === "apps.apple.com") return "searchpage";
  if (host === "itunes.apple.com") return "lookup";
  if (host === "app-ads.apple.com") return "popularity";
  return null;
}

function readCap(hostClass: AppleHostClass): number {
  const raw = process.env[RATE_ENV[hostClass]];
  const parsed = raw == null ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RATE_PER_MIN[hostClass];
}

/** Statuses that mean "slow down" for this host class. */
export function isThrottleStatus(hostClass: AppleHostClass, status: number): boolean {
  if (status === 429 || status === 503) return true;
  // apps.apple.com answers 403 when it throttles. On app-ads.apple.com 403 is
  // usually an auth or business error, so it does not count there.
  return status === 403 && hostClass !== "popularity";
}

export type HostCounters = {
  requests: number;
  status429: number;
  status403: number;
  status5xx: number;
  throttles: number;
};

type HostState = {
  nextSlotAt: number;
  /** Rate after the last throttle (null = at the cap). */
  reducedRate: number | null;
  reducedAt: number;
  counters: HostCounters;
};

type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };

const defaultClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function emptyCounters(): HostCounters {
  return { requests: 0, status429: 0, status403: 0, status5xx: 0, throttles: 0 };
}

export class AppleRateLimiter {
  private readonly hosts = new Map<AppleHostClass, HostState>();

  constructor(private readonly clock: Clock = defaultClock) {}

  private state(hostClass: AppleHostClass): HostState {
    let state = this.hosts.get(hostClass);
    if (!state) {
      state = { nextSlotAt: 0, reducedRate: null, reducedAt: 0, counters: emptyCounters() };
      this.hosts.set(hostClass, state);
    }
    return state;
  }

  /** Requests per minute allowed right now: the cap, or less after a throttle. */
  effectiveRate(hostClass: AppleHostClass): number {
    const cap = readCap(hostClass);
    const state = this.state(hostClass);
    if (state.reducedRate == null) return cap;
    const sinceThrottle = this.clock.now() - state.reducedAt;
    if (sinceThrottle < THROTTLE_HOLD_MS) return Math.min(cap, state.reducedRate);
    const steps = Math.floor((sinceThrottle - THROTTLE_HOLD_MS) / RECOVERY_STEP_MS) + 1;
    const recovered = state.reducedRate + steps * RECOVERY_STEP_SHARE * cap;
    if (recovered >= cap) {
      state.reducedRate = null;
      logger.info(`[apple-rate] ${hostClass} recovered to the cap of ${cap}/min`);
      return cap;
    }
    return recovered;
  }

  /**
   * Waits for this host's next slot and reserves it. Slots are handed out in
   * call order, at least 60s / effective rate apart.
   */
  async acquire(hostClass: AppleHostClass): Promise<void> {
    const state = this.state(hostClass);
    const intervalMs = 60_000 / this.effectiveRate(hostClass);
    const now = this.clock.now();
    const slot = Math.max(now, state.nextSlotAt);
    state.nextSlotAt = slot + intervalMs;
    state.counters.requests += 1;
    if (slot > now) await this.clock.sleep(slot - now);
  }

  /** Records the outcome of a request; a throttle halves the host's rate. */
  record(hostClass: AppleHostClass, status: number | undefined): void {
    if (status == null) return;
    const state = this.state(hostClass);
    if (status === 429) state.counters.status429 += 1;
    else if (status === 403) state.counters.status403 += 1;
    else if (status >= 500) state.counters.status5xx += 1;
    if (!isThrottleStatus(hostClass, status)) return;
    const before = this.effectiveRate(hostClass);
    const after = Math.max(MIN_RATE_PER_MIN, before / 2);
    state.reducedRate = after;
    state.reducedAt = this.clock.now();
    state.counters.throttles += 1;
    // Push the next slot out to the new spacing straight away.
    state.nextSlotAt = Math.max(state.nextSlotAt, this.clock.now() + 60_000 / after);
    logger.warn(
      `[apple-rate] ${hostClass} answered ${status}; rate ${before.toFixed(1)} -> ${after.toFixed(1)}/min for ${THROTTLE_HOLD_MS / 60_000} min, then recovering towards ${readCap(hostClass)}/min`
    );
  }

  counters(): Record<AppleHostClass, HostCounters> {
    return Object.fromEntries(
      APPLE_HOST_CLASSES.map((hostClass) => [hostClass, { ...this.state(hostClass).counters }])
    ) as Record<AppleHostClass, HostCounters>;
  }

  snapshot(): Record<
    AppleHostClass,
    { capPerMin: number; effectivePerMin: number; reducedSince: string | null }
  > {
    return Object.fromEntries(
      APPLE_HOST_CLASSES.map((hostClass) => {
        const effective = this.effectiveRate(hostClass);
        const state = this.state(hostClass);
        return [
          hostClass,
          {
            capPerMin: readCap(hostClass),
            effectivePerMin: Math.round(effective * 10) / 10,
            reducedSince:
              state.reducedRate == null ? null : new Date(state.reducedAt).toISOString(),
          },
        ];
      })
    ) as Record<
      AppleHostClass,
      { capPerMin: number; effectivePerMin: number; reducedSince: string | null }
    >;
  }
}

let shared = new AppleRateLimiter();

export function appleRateLimiter(): AppleRateLimiter {
  return shared;
}

export function __setAppleRateLimiterForTests(limiter: AppleRateLimiter): void {
  shared = limiter;
}

/** Per-host request and error counts between two counters() snapshots. */
export function diffCounters(
  before: Record<AppleHostClass, HostCounters>,
  after: Record<AppleHostClass, HostCounters>
): Record<AppleHostClass, HostCounters> {
  return Object.fromEntries(
    APPLE_HOST_CLASSES.map((hostClass) => {
      const a = after[hostClass] ?? emptyCounters();
      const b = before[hostClass] ?? emptyCounters();
      return [
        hostClass,
        {
          requests: a.requests - b.requests,
          status429: a.status429 - b.status429,
          status403: a.status403 - b.status403,
          status5xx: a.status5xx - b.status5xx,
          throttles: a.throttles - b.throttles,
        },
      ];
    })
  ) as Record<AppleHostClass, HostCounters>;
}

/** ASO_RATE_LIMIT_DISABLED=1 turns the limiter off (unit tests set it). */
function limiterDisabled(): boolean {
  return process.env.ASO_RATE_LIMIT_DISABLED === "1";
}

/** Waits for a slot for this URL's host. Returns the host class to record against. */
export async function beforeAppleRequest(url: string): Promise<AppleHostClass | null> {
  const hostClass = classifyAppleHost(url);
  if (!hostClass || limiterDisabled()) return hostClass;
  await shared.acquire(hostClass);
  return hostClass;
}

export function afterAppleResponse(
  hostClass: AppleHostClass | null,
  status: number | undefined
): void {
  if (!hostClass || limiterDisabled()) return;
  shared.record(hostClass, status);
}
