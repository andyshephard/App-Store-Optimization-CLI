import { jest } from "@jest/globals";
import {
  __resetStorefrontPopularityRejectionsForTests,
  asoPopularityService,
  resetUnattendedReauthCooldown,
  probeAsoPopularitySession,
} from "./aso-popularity-service";
import { asoAuthService } from "../auth/aso-auth-service";
import { requestPopularitiesWithKwsRetry } from "./aso-apple-popularity-client";
import { getConfiguredAsoAdamId } from "./aso-adam-id-service";

jest.mock("../auth/aso-auth-service", () => ({
  asoAuthService: {
    getCookieHeader: jest.fn(),
    reAuthenticate: jest.fn(),
  },
}));

jest.mock("./aso-apple-popularity-client", () => ({
  requestPopularitiesWithKwsRetry: jest.fn(),
}));

jest.mock("./aso-adam-id-service", () => ({
  getConfiguredAsoAdamId: jest.fn(),
}));

const mockRequestPopularitiesWithKwsRetry = jest.mocked(
  requestPopularitiesWithKwsRetry
);

describe("AsoPopularityService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(asoAuthService.getCookieHeader).mockReturnValue("cookie=value");
    jest.mocked(getConfiguredAsoAdamId).mockReturnValue("1234567890");
    resetUnattendedReauthCooldown();
  });

  describe("fetchKeywordPopularities", () => {
    it("throws when more than 100 keywords", async () => {
      const many = Array.from({ length: 101 }, (_, i) => `kw${i}`);
      await expect(
        asoPopularityService.fetchKeywordPopularities(many)
      ).rejects.toThrow("A maximum of 100 keywords is supported per call");
      expect(mockRequestPopularitiesWithKwsRetry).not.toHaveBeenCalled();
    });

    it("returns empty object for empty keywords", async () => {
      const result = await asoPopularityService.fetchKeywordPopularities([]);
      expect(result).toEqual({});
      expect(mockRequestPopularitiesWithKwsRetry).not.toHaveBeenCalled();
    });

    it("returns empty object when all keywords are whitespace", async () => {
      const result = await asoPopularityService.fetchKeywordPopularities([
        "  ",
        " ",
        "",
      ]);
      expect(result).toEqual({});
      expect(mockRequestPopularitiesWithKwsRetry).not.toHaveBeenCalled();
    });

    it("sanitizes keywords and maps response back to original casing", async () => {
      mockRequestPopularitiesWithKwsRetry.mockResolvedValue({
        statusCode: 200,
        attempts: 1,
        data: {
          status: "success",
          data: [
            { name: "keyword", popularity: 42 },
            { name: "another", popularity: 10 },
          ],
        },
      });

      const result = await asoPopularityService.fetchKeywordPopularities([
        "Keyword",
        "ANOTHER",
      ]);

      expect(result).toEqual({ Keyword: 42, ANOTHER: 10 });
      expect(mockRequestPopularitiesWithKwsRetry).toHaveBeenCalledWith(
        ["keyword", "another"],
        "cookie=value",
        expect.any(String),
        { storefronts: [] }
      );
      expect(asoAuthService.getCookieHeader).toHaveBeenCalledWith(
        "https://app-ads.apple.com/cm/api/v2/keywords/popularities"
      );
    });

    it("treats null popularity as resolved with no data, at the floor score", async () => {
      mockRequestPopularitiesWithKwsRetry.mockResolvedValue({
        statusCode: 200,
        attempts: 1,
        data: {
          status: "success",
          data: [
            { name: "a", popularity: 1 },
            { name: "b", popularity: null },
            { name: "c", popularity: 3 },
          ],
        },
      });

      const result = await asoPopularityService.fetchKeywordPopularities([
        "a",
        "b",
        "c",
      ]);

      expect(result).toEqual({ a: 1, b: 5, c: 3 });
    });

    it("matches Apple's echoed names case- and space-insensitively", async () => {
      mockRequestPopularitiesWithKwsRetry.mockResolvedValue({
        statusCode: 200,
        attempts: 1,
        data: {
          status: "success",
          data: [
            { name: " Meditation ", popularity: 44 },
            { name: "SLEEP", popularity: null },
          ],
        },
      });

      const result = await asoPopularityService.fetchKeywordPopularitiesWithFailures([
        "meditation",
        "sleep",
        "focus",
      ]);

      expect(result.popularities).toEqual({ meditation: 44, sleep: 5 });
      expect(result.noDataKeywords).toEqual(["sleep"]);
      // A term Apple left out entirely is drift, not "no data".
      expect(result.failedKeywords).toEqual([
        expect.objectContaining({ keyword: "focus", reasonCode: "APPLE_CONTRACT_DRIFT" }),
      ]);
    });

    it("throws ContextualError on non-200 response", async () => {
      mockRequestPopularitiesWithKwsRetry.mockResolvedValue({
        statusCode: 500,
        attempts: 1,
        data: { status: "error" },
      });

      await expect(
        asoPopularityService.fetchKeywordPopularities(["test"])
      ).rejects.toThrow("Popularity API request failed with status 500");
    });

    it("throws when adam id is missing", async () => {
      jest.mocked(getConfiguredAsoAdamId).mockReturnValue(null);

      await expect(
        asoPopularityService.fetchKeywordPopularities(["test"])
      ).rejects.toThrow("Primary App ID is missing.");
      expect(mockRequestPopularitiesWithKwsRetry).not.toHaveBeenCalled();
    });

    it("throws ContextualError when status is not success", async () => {
      mockRequestPopularitiesWithKwsRetry.mockResolvedValue({
        statusCode: 200,
        attempts: 1,
        data: { status: "error", error: { errors: [{ messageCode: "ERR" }] } },
      });

      await expect(
        asoPopularityService.fetchKeywordPopularities(["test"])
      ).rejects.toThrow("Popularity API request failed with status 200");
    });

    it("reauthenticates when getCookieHeader returns empty and retries", async () => {
      jest.mocked(asoAuthService.getCookieHeader).mockReturnValue("");
      jest.mocked(asoAuthService.reAuthenticate).mockResolvedValue("new-cookie");
      mockRequestPopularitiesWithKwsRetry.mockResolvedValue({
        statusCode: 200,
        attempts: 1,
        data: { status: "success", data: [{ name: "x", popularity: 1 }] },
      });

      const result = await asoPopularityService.fetchKeywordPopularities(["x"]);

      expect(asoAuthService.reAuthenticate).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ x: 1 });
      expect(mockRequestPopularitiesWithKwsRetry).toHaveBeenCalledWith(
        ["x"],
        "new-cookie",
        expect.any(String),
        { storefronts: [] }
      );
    });

    it("throws auth-required error without interactive recovery when cookie is missing", async () => {
      jest.mocked(asoAuthService.getCookieHeader).mockReturnValue("");

      await expect(
        asoPopularityService.fetchKeywordPopularities(["x"], {
          allowInteractiveAuthRecovery: false,
        })
      ).rejects.toMatchObject({ code: "ASO_AUTH_REAUTH_REQUIRED" });
      expect(asoAuthService.reAuthenticate).not.toHaveBeenCalled();
      expect(mockRequestPopularitiesWithKwsRetry).not.toHaveBeenCalled();
    });

    it("retries once after auth failure (401)", async () => {
      mockRequestPopularitiesWithKwsRetry
        .mockResolvedValueOnce({
          statusCode: 401,
          attempts: 1,
          data: {},
        })
        .mockResolvedValueOnce({
          statusCode: 200,
          attempts: 1,
          data: { status: "success", data: [{ name: "y", popularity: 2 }] },
        });
      jest.mocked(asoAuthService.reAuthenticate).mockResolvedValue(
        "refreshed-cookie"
      );

      const result = await asoPopularityService.fetchKeywordPopularities(["y"]);

      expect(asoAuthService.reAuthenticate).toHaveBeenCalledTimes(1);
      expect(mockRequestPopularitiesWithKwsRetry).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ y: 2 });
    });

    it("does not loop reauthentication when post-reauth response is still auth failure", async () => {
      mockRequestPopularitiesWithKwsRetry
        .mockResolvedValueOnce({
          statusCode: 401,
          attempts: 1,
          data: {},
        })
        .mockResolvedValueOnce({
          statusCode: 401,
          attempts: 1,
          data: {},
        });
      jest.mocked(asoAuthService.reAuthenticate).mockResolvedValue(
        "refreshed-cookie"
      );

      await expect(
        asoPopularityService.fetchKeywordPopularities(["y"])
      ).rejects.toThrow("Popularity API request failed with status 401");

      expect(asoAuthService.reAuthenticate).toHaveBeenCalledTimes(1);
      expect(mockRequestPopularitiesWithKwsRetry).toHaveBeenCalledTimes(2);
    });

    it("throws auth-required error without interactive recovery on auth failure response", async () => {
      mockRequestPopularitiesWithKwsRetry.mockResolvedValue({
        statusCode: 401,
        attempts: 1,
        data: {},
      });

      await expect(
        asoPopularityService.fetchKeywordPopularities(["y"], {
          allowInteractiveAuthRecovery: false,
        })
      ).rejects.toMatchObject({ code: "ASO_AUTH_REAUTH_REQUIRED" });
      expect(asoAuthService.reAuthenticate).not.toHaveBeenCalled();
      expect(mockRequestPopularitiesWithKwsRetry).toHaveBeenCalledTimes(1);
    });

    it("throws contextual KWS error for no-org code after retries are exhausted", async () => {
      mockRequestPopularitiesWithKwsRetry.mockResolvedValue({
        statusCode: 403,
        attempts: 1,
        data: {
          status: "error",
          error: {
            errors: [
              {
                messageCode: "KWS_NO_ORG_CONTENT_PROVIDERS",
                message: "No org content providers",
              },
            ],
          },
        },
      });

      await expect(
        asoPopularityService.fetchKeywordPopularities(["z"])
      ).rejects.toThrow("No org content providers");
      expect(asoAuthService.reAuthenticate).not.toHaveBeenCalled();
    });

    it("throws primary app id access error for no-user-owned-apps code without reauth", async () => {
      mockRequestPopularitiesWithKwsRetry.mockResolvedValue({
        statusCode: 403,
        attempts: 1,
        data: {
          status: "error",
          error: {
            errors: [
              {
                messageCode: "NO_USER_OWNED_APPS_FOUND_CODE",
                message: "No user owned apps found",
              },
            ],
          },
        },
      });

      await expect(
        asoPopularityService.fetchKeywordPopularities(["z"])
      ).rejects.toThrow(
        "Primary App ID 1234567890 is not accessible for this Apple Ads account."
      );
      expect(asoAuthService.reAuthenticate).not.toHaveBeenCalled();
    });

    it("does not reauthenticate for text-only no-user-owned-apps 403", async () => {
      mockRequestPopularitiesWithKwsRetry.mockResolvedValue({
        statusCode: 403,
        attempts: 1,
        data: {
          status: "error",
          error: {
            errors: [
              {
                message: "No user owned apps found",
              },
            ],
          },
        },
      });

      await expect(
        asoPopularityService.fetchKeywordPopularities(["z"])
      ).rejects.toThrow(
        "Primary App ID 1234567890 is not accessible for this Apple Ads account."
      );
      expect(asoAuthService.reAuthenticate).not.toHaveBeenCalled();
      expect(mockRequestPopularitiesWithKwsRetry).toHaveBeenCalledTimes(1);
    });

    it("isolates failed keywords after terminal batch failure", async () => {
      mockRequestPopularitiesWithKwsRetry
        .mockResolvedValueOnce({
          statusCode: 500,
          attempts: 3,
          data: { status: "error" },
        })
        .mockResolvedValueOnce({
          statusCode: 200,
          attempts: 1,
          data: { status: "success", data: [{ name: "good", popularity: 25 }] },
        })
        .mockResolvedValueOnce({
          statusCode: 500,
          attempts: 3,
          data: { status: "error" },
        });

      const result = await asoPopularityService.fetchKeywordPopularitiesWithFailures([
        "good",
        "bad",
      ]);

      expect(result.popularities).toEqual({ good: 25 });
      expect(result.failedKeywords).toHaveLength(1);
      expect(result.failedKeywords[0]).toMatchObject({
        keyword: "bad",
        stage: "popularity",
      });
      expect(mockRequestPopularitiesWithKwsRetry).toHaveBeenNthCalledWith(
        2,
        ["good"],
        "cookie=value",
        expect.any(String),
        { maxAttempts: 1, storefronts: [] }
      );
      expect(mockRequestPopularitiesWithKwsRetry).toHaveBeenNthCalledWith(
        3,
        ["bad"],
        "cookie=value",
        expect.any(String),
        { maxAttempts: 1, storefronts: [] }
      );
    });
  });

  describe("unattended reauthentication", () => {
    const originalAppleId = process.env.ASO_APPLE_ID;
    const originalPassword = process.env.ASO_APPLE_PASSWORD;

    beforeEach(() => {
      process.env.ASO_APPLE_ID = "user@example.com";
      process.env.ASO_APPLE_PASSWORD = "pw";
      jest.mocked(asoAuthService.getCookieHeader).mockReturnValue("");
    });

    afterEach(() => {
      if (originalAppleId === undefined) delete process.env.ASO_APPLE_ID;
      else process.env.ASO_APPLE_ID = originalAppleId;
      if (originalPassword === undefined) delete process.env.ASO_APPLE_PASSWORD;
      else process.env.ASO_APPLE_PASSWORD = originalPassword;
    });

    const fetchUnattended = () =>
      asoPopularityService.fetchKeywordPopularities(["x"], {
        allowInteractiveAuthRecovery: false,
      });

    it("stops signing in to Apple after a failure until the cooldown is reset", async () => {
      jest
        .mocked(asoAuthService.reAuthenticate)
        .mockRejectedValue(new Error("Apple login failed with status 503"));

      await expect(fetchUnattended()).rejects.toMatchObject({
        code: "ASO_AUTH_REAUTH_REQUIRED",
      });
      await expect(fetchUnattended()).rejects.toMatchObject({
        code: "ASO_AUTH_REAUTH_REQUIRED",
      });
      expect(asoAuthService.reAuthenticate).toHaveBeenCalledTimes(1);

      resetUnattendedReauthCooldown();
      await expect(fetchUnattended()).rejects.toMatchObject({
        code: "ASO_AUTH_REAUTH_REQUIRED",
      });
      expect(asoAuthService.reAuthenticate).toHaveBeenCalledTimes(2);
    });

    it("shares one sign-in between concurrent callers", async () => {
      jest
        .mocked(asoAuthService.reAuthenticate)
        .mockResolvedValue("new-cookie");
      mockRequestPopularitiesWithKwsRetry.mockResolvedValue({
        statusCode: 200,
        attempts: 1,
        data: { status: "success", data: [{ name: "x", popularity: 7 }] },
      });

      const results = await Promise.all([fetchUnattended(), fetchUnattended()]);

      expect(results).toEqual([{ x: 7 }, { x: 7 }]);
      expect(asoAuthService.reAuthenticate).toHaveBeenCalledTimes(1);
    });
  });
});

describe("probeAsoPopularitySession", () => {
  beforeEach(() => {
    jest.mocked(asoAuthService.getCookieHeader).mockReturnValue("cookie=value");
    jest.mocked(getConfiguredAsoAdamId).mockReturnValue("1234567890");
  });

  it.each([
    [200, {}, "ok"],
    [401, {}, "rejected"],
    [403, { internalErrorCode: "REFRESH" }, "rejected"],
    [429, {}, "unknown"],
    [503, {}, "unknown"],
  ])("classifies HTTP %s as %s", async (statusCode, data, expected) => {
    jest
      .mocked(requestPopularitiesWithKwsRetry)
      .mockResolvedValueOnce({ statusCode, data, attempts: 1 } as never);
    await expect(probeAsoPopularitySession()).resolves.toBe(expected);
  });

  it("treats a failed request as unknown, and missing cookies as rejected", async () => {
    jest
      .mocked(requestPopularitiesWithKwsRetry)
      .mockRejectedValueOnce(new Error("timeout of 30000ms exceeded") as never);
    await expect(probeAsoPopularitySession()).resolves.toBe("unknown");

    jest.mocked(asoAuthService.getCookieHeader).mockReturnValue("");
    await expect(probeAsoPopularitySession()).resolves.toBe("rejected");
  });
});

describe("per-storefront popularity", () => {
  const ok = (items: Array<{ name: string; popularity: number | null }>) =>
    ({ statusCode: 200, attempts: 1, data: { status: "success", data: items } }) as never;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(asoAuthService.getCookieHeader).mockReturnValue("cookie=value");
    jest.mocked(getConfiguredAsoAdamId).mockReturnValue("1234567890");
    __resetStorefrontPopularityRejectionsForTests();
    delete process.env.ASO_POPULARITY_PER_STOREFRONT;
  });

  it("asks for the storefront's score and reports it as the source", async () => {
    mockRequestPopularitiesWithKwsRetry.mockResolvedValueOnce(
      ok([{ name: "a", popularity: 30 }, { name: "b", popularity: 20 }])
    );

    const result = await asoPopularityService.fetchKeywordPopularitiesWithFailures(
      ["a", "b"],
      { country: "gb" }
    );

    expect(mockRequestPopularitiesWithKwsRetry).toHaveBeenCalledTimes(1);
    expect(mockRequestPopularitiesWithKwsRetry.mock.calls[0][3]).toEqual({
      storefronts: ["GB"],
    });
    expect(result.popularities).toEqual({ a: 30, b: 20 });
    expect(result.sourceByKeyword).toEqual({ a: "storefront", b: "storefront" });
  });

  it("falls back to account level for terms the storefront did not answer", async () => {
    mockRequestPopularitiesWithKwsRetry
      .mockResolvedValueOnce(ok([{ name: "a", popularity: 30 }]))
      .mockResolvedValueOnce(ok([{ name: "b", popularity: 12 }]));

    const result = await asoPopularityService.fetchKeywordPopularitiesWithFailures(
      ["a", "b"],
      { country: "GB" }
    );

    expect(mockRequestPopularitiesWithKwsRetry.mock.calls[1][0]).toEqual(["b"]);
    expect(mockRequestPopularitiesWithKwsRetry.mock.calls[1][3]).toEqual({
      storefronts: [],
    });
    expect(result.popularities).toEqual({ a: 30, b: 12 });
    expect(result.sourceByKeyword).toEqual({ a: "storefront", b: "account" });
    expect(result.failedKeywords).toEqual([]);
  });

  it("falls back when Apple rejects the storefront request, and stops asking for a day", async () => {
    mockRequestPopularitiesWithKwsRetry
      .mockResolvedValueOnce({ statusCode: 400, attempts: 1, data: { status: "error" } } as never)
      .mockResolvedValueOnce(ok([{ name: "a", popularity: 30 }]))
      .mockResolvedValueOnce(ok([{ name: "a", popularity: 31 }]));

    const first = await asoPopularityService.fetchKeywordPopularitiesWithFailures(
      ["a"],
      { country: "GB" }
    );
    const second = await asoPopularityService.fetchKeywordPopularitiesWithFailures(
      ["a"],
      { country: "GB" }
    );

    expect(first).toMatchObject({ popularities: { a: 30 }, failedKeywords: [] });
    expect(second.sourceByKeyword).toEqual({ a: "account" });
    expect(mockRequestPopularitiesWithKwsRetry.mock.calls.map((call) => call[3])).toEqual([
      { storefronts: ["GB"] },
      { storefronts: [] },
      { storefronts: [] },
    ]);
  });

  it("stops asking a storefront for a day once it answers with no scores at all", async () => {
    mockRequestPopularitiesWithKwsRetry
      .mockResolvedValueOnce(ok([{ name: "a", popularity: null }, { name: "b", popularity: null }]))
      .mockResolvedValueOnce(ok([{ name: "a", popularity: 30 }, { name: "b", popularity: 20 }]))
      .mockResolvedValueOnce(ok([{ name: "a", popularity: 31 }]));

    await asoPopularityService.fetchKeywordPopularitiesWithFailures(["a", "b"], { country: "DE" });
    await asoPopularityService.fetchKeywordPopularitiesWithFailures(["a"], { country: "DE" });

    expect(mockRequestPopularitiesWithKwsRetry.mock.calls.map((call) => call[3])).toEqual([
      { storefronts: ["DE"] },
      { storefronts: [] },
      { storefronts: [] },
    ]);
  });

  it("uses account level only when switched off", async () => {
    process.env.ASO_POPULARITY_PER_STOREFRONT = "0";
    mockRequestPopularitiesWithKwsRetry.mockResolvedValueOnce(ok([{ name: "a", popularity: 30 }]));

    const result = await asoPopularityService.fetchKeywordPopularitiesWithFailures(
      ["a"],
      { country: "GB" }
    );

    expect(mockRequestPopularitiesWithKwsRetry.mock.calls[0][3]).toEqual({ storefronts: [] });
    expect(result.sourceByKeyword).toEqual({ a: "account" });
    delete process.env.ASO_POPULARITY_PER_STOREFRONT;
  });
});
