import { parseLocalizedRatingCount } from "./aso-rating-count";

describe("parseLocalizedRatingCount", () => {
  it("passes numbers through", () => {
    expect(parseLocalizedRatingCount(1234, "US")).toBe(1234);
    expect(parseLocalizedRatingCount(4.6, "DE")).toBe(5);
    expect(parseLocalizedRatingCount(-5, "US")).toBe(0);
    expect(parseLocalizedRatingCount(Number.NaN, "US")).toBe(0);
  });

  it("returns 0 for empty or unparseable values", () => {
    expect(parseLocalizedRatingCount(undefined, "US")).toBe(0);
    expect(parseLocalizedRatingCount(null, "US")).toBe(0);
    expect(parseLocalizedRatingCount("", "US")).toBe(0);
    expect(parseLocalizedRatingCount("no ratings", "US")).toBe(0);
  });

  // Strings below were sampled from apps.apple.com/{cc}/iphone/search.
  it("parses US and GB formats", () => {
    expect(parseLocalizedRatingCount("417", "US")).toBe(417);
    expect(parseLocalizedRatingCount("6.2K", "US")).toBe(6200);
    expect(parseLocalizedRatingCount("64K", "US")).toBe(64000);
    expect(parseLocalizedRatingCount("1.2M", "US")).toBe(1200000);
    expect(parseLocalizedRatingCount("774", "GB")).toBe(774);
    expect(parseLocalizedRatingCount("9.3k", "GB")).toBe(9300);
    expect(parseLocalizedRatingCount("17k", "GB")).toBe(17000);
  });

  it("parses the English storefronts that share US-style formatting", () => {
    expect(parseLocalizedRatingCount("6.6K", "CA")).toBe(6600);
    expect(parseLocalizedRatingCount("5.9K", "AU")).toBe(5900);
    expect(parseLocalizedRatingCount("661", "CA")).toBe(661);
    expect(parseLocalizedRatingCount("8.8k", "IE")).toBe(8800);
    expect(parseLocalizedRatingCount("1.4M", "NZ")).toBe(1400000);
  });

  it("treats a dot as a thousands separator in German", () => {
    // The bug this parser exists for: parseFloat("428.932") is 428.932.
    expect(parseLocalizedRatingCount("428.932", "DE")).toBe(428932);
    expect(parseLocalizedRatingCount("1404", "DE")).toBe(1404);
    expect(parseLocalizedRatingCount("1,2 Mio.", "DE")).toBe(1200000);
    expect(parseLocalizedRatingCount("3,4 Tsd.", "DE")).toBe(3400);
  });

  it("handles the French non-breaking space before the suffix", () => {
    expect(parseLocalizedRatingCount("8,4 k", "FR")).toBe(8400);
    expect(parseLocalizedRatingCount("73 k", "FR")).toBe(73000);
    expect(parseLocalizedRatingCount("849", "FR")).toBe(849);
    expect(parseLocalizedRatingCount("1,2 M", "FR")).toBe(1200000);
  });

  it("handles the real non-breaking and narrow non-breaking spaces Apple emits", () => {
    expect(parseLocalizedRatingCount("8,4\u00a0k", "FR")).toBe(8400);
    expect(parseLocalizedRatingCount("73\u202fk", "FR")).toBe(73000);
    expect(parseLocalizedRatingCount("6,8\u00a0mil", "ES")).toBe(6800);
    expect(parseLocalizedRatingCount("1,3\u00a0mil", "PT")).toBe(1300);
  });

  it("handles Spanish and Portuguese 'mil'", () => {
    expect(parseLocalizedRatingCount("6,8 mil", "ES")).toBe(6800);
    expect(parseLocalizedRatingCount("2,5 mil", "ES")).toBe(2500);
    expect(parseLocalizedRatingCount("354", "ES")).toBe(354);
    expect(parseLocalizedRatingCount("1,3 mil", "PT")).toBe(1300);
    expect(parseLocalizedRatingCount("11 mil", "PT")).toBe(11000);
    expect(parseLocalizedRatingCount("47", "PT")).toBe(47);
  });

  it("handles Italian comma decimals", () => {
    expect(parseLocalizedRatingCount("5,9K", "IT")).toBe(5900);
    expect(parseLocalizedRatingCount("532", "IT")).toBe(532);
    expect(parseLocalizedRatingCount("1,2 Mln", "IT")).toBe(1200000);
  });

  it("uses the number locale, not the storefront language, for Vietnam", () => {
    // Apple serves Vietnamese titles but English-formatted numbers there.
    // Read as vi-VN, "8.1k" would strip the dot as a group separator and give
    // 81,000 - an order of magnitude out, straight into difficulty scoring.
    expect(parseLocalizedRatingCount("8.1k", "VN")).toBe(8100);
    expect(parseLocalizedRatingCount("1.2k", "VN")).toBe(1200);
    expect(parseLocalizedRatingCount("520k", "VN")).toBe(520000);
    expect(parseLocalizedRatingCount("302", "VN")).toBe(302);
  });

  it("returns 0 rather than a wrong magnitude for an unknown suffix", () => {
    expect(parseLocalizedRatingCount("6,8 zzz", "ES")).toBe(0);
  });

  it("falls back to en-US rules for a country with no storefront entry", () => {
    expect(parseLocalizedRatingCount("6.2K", "TR")).toBe(6200);
  });
});
