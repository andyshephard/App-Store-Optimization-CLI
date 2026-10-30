import {
  AppleRateLimiter,
  classifyAppleHost,
  DEFAULT_RATE_PER_MIN,
  THROTTLE_HOLD_MS,
} from "./apple-rate-limiter";

/** Clock whose sleeps are recorded as the absolute time the request goes out. */
function fakeClock(start = 0) {
  let now = start;
  const sentAt: number[] = [];
  return {
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        sentAt.push(now + ms);
      },
    },
    sentAt,
    advance: (ms: number) => {
      now += ms;
    },
    set: (ms: number) => {
      now = ms;
    },
  };
}

/** Largest number of send times inside any 60-second window. */
function maxPerMinute(times: number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < sorted.length; hi += 1) {
    while (sorted[hi] - sorted[lo] >= 60_000) lo += 1;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

describe("AppleRateLimiter", () => {
  afterEach(() => {
    delete process.env.ASO_RATE_MZSEARCH_PER_MIN;
    delete process.env.ASO_RATE_LOOKUP_PER_MIN;
    delete process.env.ASO_RATE_PLAYSEARCH_PER_MIN;
  });

  it("classifies Apple hosts", () => {
    expect(classifyAppleHost("https://search.itunes.apple.com/WebObjects/MZSearch.woa/wa/search")).toBe("mzsearch");
    expect(classifyAppleHost("https://apps.apple.com/gb/iphone/search")).toBe("searchpage");
    expect(classifyAppleHost("https://itunes.apple.com/lookup")).toBe("lookup");
    expect(classifyAppleHost("https://app-ads.apple.com/cm/api/v2/keywords/popularities")).toBe("popularity");
    expect(classifyAppleHost("https://example.com")).toBeNull();
  });

  it("never lets more than the cap through in any minute, however many callers wait at once", async () => {
    const { clock, sentAt } = fakeClock();
    const limiter = new AppleRateLimiter(clock);

    // 200 concurrent callers - what a high ASO_SEARCH_CONCURRENCY or
    // ASO_STOREFRONT_CONCURRENCY would produce.
    await Promise.all(Array.from({ length: 200 }, () => limiter.acquire("mzsearch")));
    const times = [0, ...sentAt]; // the first goes out at once, without a sleep

    expect(times).toHaveLength(200);
    expect(maxPerMinute(times)).toBe(DEFAULT_RATE_PER_MIN.mzsearch);
    expect(limiter.counters().mzsearch.requests).toBe(200);
  });

  it("takes the cap from the environment", async () => {
    process.env.ASO_RATE_LOOKUP_PER_MIN = "6";
    const { clock, sentAt } = fakeClock();
    const limiter = new AppleRateLimiter(clock);

    await Promise.all(Array.from({ length: 20 }, () => limiter.acquire("lookup")));

    expect(maxPerMinute([0, ...sentAt])).toBe(6);
  });

  it("keeps hosts independent", async () => {
    const { clock, sentAt } = fakeClock();
    const limiter = new AppleRateLimiter(clock);
    await limiter.acquire("mzsearch");
    await limiter.acquire("lookup");
    expect(sentAt).toEqual([]);
  });

  it("halves a host's rate on a throttle, holds it 30 minutes, then recovers additively to the cap", () => {
    process.env.ASO_RATE_MZSEARCH_PER_MIN = "40";
    const t = fakeClock(1_000_000);
    const limiter = new AppleRateLimiter(t.clock);

    limiter.record("mzsearch", 429);
    expect(limiter.effectiveRate("mzsearch")).toBe(20);
    limiter.record("mzsearch", 403);
    expect(limiter.effectiveRate("mzsearch")).toBe(10);
    expect(limiter.counters().mzsearch).toMatchObject({ status429: 1, status403: 1, throttles: 2 });

    t.advance(THROTTLE_HOLD_MS - 1);
    expect(limiter.effectiveRate("mzsearch")).toBe(10);
    t.advance(1);
    expect(limiter.effectiveRate("mzsearch")).toBe(14); // +10% of the cap
    t.advance(5 * 60_000);
    expect(limiter.effectiveRate("mzsearch")).toBe(18);
    t.advance(60 * 60_000);
    expect(limiter.effectiveRate("mzsearch")).toBe(40); // never above the cap
    expect(limiter.snapshot().mzsearch).toEqual({
      capPerMin: 40,
      effectivePerMin: 40,
      reducedSince: null,
    });
  });

  it("spaces requests at the reduced rate after a throttle", async () => {
    const t = fakeClock();
    const limiter = new AppleRateLimiter(t.clock);
    limiter.record("lookup", 503);
    await Promise.all(Array.from({ length: 30 }, () => limiter.acquire("lookup")));
    expect(maxPerMinute(t.sentAt)).toBeLessThanOrEqual(Math.ceil(DEFAULT_RATE_PER_MIN.lookup / 2));
  });

  it("does not treat a 403 from the popularity host as a throttle (it is usually auth)", () => {
    const limiter = new AppleRateLimiter(fakeClock().clock);
    limiter.record("popularity", 403);
    expect(limiter.effectiveRate("popularity")).toBe(DEFAULT_RATE_PER_MIN.popularity);
    expect(limiter.counters().popularity.status403).toBe(1);
  });

  it("counts 5xx", () => {
    const limiter = new AppleRateLimiter(fakeClock().clock);
    limiter.record("searchpage", 502);
    limiter.record("searchpage", 200);
    expect(limiter.counters().searchpage).toMatchObject({ status5xx: 1, throttles: 0 });
  });
  it("classifies Google Play search and suggest as their own hosts", () => {
    expect(classifyAppleHost("https://play.google.com/store/search?q=x&c=apps")).toBe("playsearch");
    expect(
      classifyAppleHost("https://play.google.com/_/PlayStoreUi/data/batchexecute?rpcids=IJ4APc")
    ).toBe("playsuggest");
    expect(classifyAppleHost("https://play.google.com/store/apps/details?id=x")).toBeNull();
  });

  it("paces Google Play at conservative default caps, overridable from the environment", async () => {
    expect(DEFAULT_RATE_PER_MIN.playsearch).toBe(20);
    expect(DEFAULT_RATE_PER_MIN.playsuggest).toBe(30);
    const { clock, sentAt } = fakeClock();
    const limiter = new AppleRateLimiter(clock);
    await Promise.all(Array.from({ length: 50 }, () => limiter.acquire("playsearch")));
    expect(maxPerMinute([0, ...sentAt])).toBe(20);

    process.env.ASO_RATE_PLAYSEARCH_PER_MIN = "5";
    const second = fakeClock();
    const slower = new AppleRateLimiter(second.clock);
    await Promise.all(Array.from({ length: 12 }, () => slower.acquire("playsearch")));
    expect(maxPerMinute([0, ...second.sentAt])).toBe(5);
  });

  it("halves Google Play on 429 but not on 403, and reports both hosts", () => {
    const limiter = new AppleRateLimiter(fakeClock().clock);
    limiter.record("playsuggest", 403);
    expect(limiter.effectiveRate("playsuggest")).toBe(DEFAULT_RATE_PER_MIN.playsuggest);
    limiter.record("playsearch", 429);
    expect(limiter.effectiveRate("playsearch")).toBe(DEFAULT_RATE_PER_MIN.playsearch / 2);
    expect(limiter.counters().playsearch).toMatchObject({ status429: 1, throttles: 1 });
    expect(Object.keys(limiter.snapshot())).toEqual(
      expect.arrayContaining(["playsearch", "playsuggest"])
    );
  });
});

describe("AppleRateLimiter with requests already queued", () => {
  /** Clock whose sleeps really wait until advanced. */
  function controllableClock() {
    let now = 0;
    const waiters: Array<{ at: number; resolve: () => void }> = [];
    return {
      clock: {
        now: () => now,
        sleep: (ms: number) =>
          new Promise<void>((resolve) => waiters.push({ at: now + ms, resolve })),
      },
      async runUntil(target: number) {
        for (;;) {
          waiters.sort((a, b) => a.at - b.at);
          const next = waiters[0];
          if (!next || next.at > target) break;
          waiters.shift();
          now = next.at;
          next.resolve();
          for (let i = 0; i < 5; i += 1) await Promise.resolve();
        }
        now = target;
      },
      now: () => now,
    };
  }

  it("slows requests that were already waiting when a throttle arrives", async () => {
    const t = controllableClock();
    const limiter = new AppleRateLimiter(t.clock);
    const firedAt: number[] = [];
    // 8 concurrent callers at 30/min: queued for 0, 2, 4, ... 14 s.
    const calls = Array.from({ length: 8 }, () =>
      limiter.acquire("mzsearch").then(() => firedAt.push(t.now()))
    );
    for (let i = 0; i < 5; i += 1) await Promise.resolve(); // the first goes out at once
    await t.runUntil(2_000); // two have gone out
    expect(firedAt).toEqual([0, 2_000]);

    limiter.record("mzsearch", 429); // rate 30 -> 15/min, 4 s spacing

    await t.runUntil(10 * 60_000);
    await Promise.all(calls);
    expect(firedAt).toHaveLength(8);
    const afterThrottle = firedAt.slice(2);
    // None of the queued six fires at the old 2 s spacing.
    for (let i = 1; i < afterThrottle.length; i += 1) {
      expect(afterThrottle[i] - afterThrottle[i - 1]).toBeGreaterThanOrEqual(4_000);
    }
    expect(afterThrottle[0]).toBeGreaterThanOrEqual(2_000 + 4_000);
  });
});
