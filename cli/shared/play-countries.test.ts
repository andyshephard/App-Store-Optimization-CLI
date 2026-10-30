import {
  isPlayConfigured,
  listEnabledPlayCountries,
  withoutPlayHostsUnlessConfigured,
} from "./play-countries";

describe("play-countries", () => {
  afterEach(() => {
    delete process.env.ASO_PLAY_APP_ID;
    delete process.env.ASO_PLAY_COUNTRIES;
  });

  it("enables US and GB by default and drops unknown codes", () => {
    expect(listEnabledPlayCountries().map((c) => c.country)).toEqual(["US", "GB"]);
    process.env.ASO_PLAY_COUNTRIES = "au, XX, nz, AU";
    expect(listEnabledPlayCountries().map((c) => c.country)).toEqual(["AU", "NZ"]);
  });

  it("hides the Play host classes from reports unless ASO_PLAY_APP_ID is set", () => {
    const byHost = { mzsearch: 1, playsearch: 2, playsuggest: 3 };
    expect(isPlayConfigured()).toBe(false);
    expect(withoutPlayHostsUnlessConfigured(byHost)).toEqual({ mzsearch: 1 });
    process.env.ASO_PLAY_APP_ID = "com.andyshephard.chunks";
    expect(isPlayConfigured()).toBe(true);
    expect(withoutPlayHostsUnlessConfigured(byHost)).toEqual(byHost);
  });
});
