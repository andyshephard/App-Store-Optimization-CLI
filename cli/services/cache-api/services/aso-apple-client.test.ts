import { jest } from "@jest/globals";
import { asoAppleGet, resetAppleThrottleGateForTests } from "./aso-apple-client";
import {
  AppleRateLimiter,
  __setAppleRateLimiterForTests,
} from "../../../shared/apple-rate-limiter";

jest.mock("axios", () => {
  const get = jest.fn();
  return {
    __esModule: true,
    default: {
      create: jest.fn(() => ({
        get,
        interceptors: {
          request: { use: jest.fn() },
          response: { use: jest.fn() },
        },
      })),
    },
    __mockGet: get,
  };
});

const mockGet = (jest.requireMock("axios") as { __mockGet: jest.Mock }).__mockGet;

describe("aso-apple-client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetAppleThrottleGateForTests();
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(0);
    process.env.ASO_RETRY_MAX_ATTEMPTS = "2";
    process.env.ASO_RETRY_BASE_DELAY_MS = "1000";
    process.env.ASO_RETRY_MAX_DELAY_MS = "30000";
    process.env.ASO_RETRY_JITTER_FACTOR = "0.1";
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete process.env.ASO_RETRY_MAX_ATTEMPTS;
    delete process.env.ASO_RETRY_BASE_DELAY_MS;
    delete process.env.ASO_RETRY_MAX_DELAY_MS;
    delete process.env.ASO_RETRY_JITTER_FACTOR;
  });

  it("uses shared retry defaults and retries 500 responses up to attempt 2", async () => {
    const transientError = {
      response: { status: 500, statusText: "Server Error", headers: {} },
      message: "Internal error",
    };

    (mockGet as any)
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        headers: {},
        data: { ok: true },
      } as any);

    const promise = asoAppleGet("https://example.com", {
      operation: "test-op",
      headers: {},
    });

    await jest.advanceTimersByTimeAsync(1000);
    const response = await promise;

    expect(response.status).toBe(200);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
  it("holds every request to a host after one of them is told to back off", async () => {
    const throttled = {
      response: { status: 429, statusText: "Too Many Requests", headers: { "retry-after": "4" } },
      message: "Request failed with status code 429",
    };
    const ok = { status: 200, statusText: "OK", headers: {}, data: {} };
    (mockGet as any).mockRejectedValueOnce(throttled).mockResolvedValue(ok);

    const first = asoAppleGet("https://apps.apple.com/a", { operation: "op" });
    await jest.advanceTimersByTimeAsync(0);
    // Issued after the 429 landed: must wait for the gate, not go straight out.
    const second = asoAppleGet("https://apps.apple.com/b", { operation: "op" });
    const otherHost = asoAppleGet("https://itunes.apple.com/lookup", { operation: "op" });
    await jest.advanceTimersByTimeAsync(0);
    expect(mockGet).toHaveBeenCalledTimes(2); // first + otherHost

    await jest.advanceTimersByTimeAsync(4000);
    await Promise.all([first, second, otherHost]);
    expect(mockGet).toHaveBeenCalledTimes(4);
  });

  it("retries a 403 as a throttle only when the caller says the endpoint uses it", async () => {
    const forbidden = {
      response: { status: 403, statusText: "Forbidden", headers: {} },
      message: "Request failed with status code 403",
    };
    const ok = { status: 200, statusText: "OK", headers: {}, data: {} };

    (mockGet as any).mockRejectedValueOnce(forbidden);
    await expect(
      asoAppleGet("https://example.com/plain", { operation: "op" })
    ).rejects.toBe(forbidden);
    expect(mockGet).toHaveBeenCalledTimes(1);

    (mockGet as any).mockRejectedValueOnce(forbidden).mockResolvedValueOnce(ok);
    const promise = asoAppleGet("https://example.com/throttled", {
      operation: "op",
      throttleStatusCodes: [403],
    });
    await jest.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toBe(ok);
    expect(mockGet).toHaveBeenCalledTimes(3);
  });
});

describe("aso-apple-client rate limiting", () => {
  afterEach(() => {
    process.env.ASO_RATE_LIMIT_DISABLED = "1";
    __setAppleRateLimiterForTests(new AppleRateLimiter());
  });

  it("takes a limiter slot per request and records throttles against the host", async () => {
    delete process.env.ASO_RATE_LIMIT_DISABLED;
    const sleeps: number[] = [];
    const limiter = new AppleRateLimiter({
      now: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    __setAppleRateLimiterForTests(limiter);
    (mockGet as any)
      .mockResolvedValueOnce({ status: 200, data: {}, headers: {} })
      .mockRejectedValueOnce({
        response: { status: 404, statusText: "Not Found", headers: {} },
        message: "nope",
      });

    await asoAppleGet("https://itunes.apple.com/lookup", { operation: "itunes.lookup", maxAttempts: 1 });
    await expect(
      asoAppleGet("https://itunes.apple.com/lookup", { operation: "itunes.lookup", maxAttempts: 1 })
    ).rejects.toBeDefined();

    expect(limiter.counters().lookup.requests).toBe(2);
    // The second request waited for its slot: 60s / 15 per minute.
    expect(sleeps).toEqual([4000]);
  });
});
