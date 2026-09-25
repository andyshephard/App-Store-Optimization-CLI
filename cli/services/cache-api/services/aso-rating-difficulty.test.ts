import { calculateRatingDifficulty } from "./aso-rating-difficulty";

describe("calculateRatingDifficulty", () => {
  it("floors at 5 when the top results have almost no ratings", () => {
    expect(
      calculateRatingDifficulty({ topRatingCounts: [0, 1, 2, 0, 0], resultCount: 20 })
    ).toBe(5);
  });

  it("rises with the rating counts of the top apps", () => {
    const weak = calculateRatingDifficulty({
      topRatingCounts: Array(10).fill(1_000),
      resultCount: 240,
    });
    const strong = calculateRatingDifficulty({
      topRatingCounts: Array(10).fill(100_000),
      resultCount: 240,
    });
    expect(strong).toBeGreaterThan(weak);
  });

  it("stops rewarding rating counts above one million", () => {
    const million = calculateRatingDifficulty({
      topRatingCounts: Array(10).fill(1_000_000),
      resultCount: 240,
    });
    const tenMillion = calculateRatingDifficulty({
      topRatingCounts: Array(10).fill(10_000_000),
      resultCount: 240,
    });
    expect(tenMillion).toBe(million);
  });

  it("scores the same apps the same whatever order they rank in", () => {
    const counts = [5, 900_000, 12, 40_000, 0, 7, 3_000, 1, 60, 250_000];
    expect(
      calculateRatingDifficulty({ topRatingCounts: counts, resultCount: 200 })
    ).toBe(
      calculateRatingDifficulty({ topRatingCounts: [...counts].reverse(), resultCount: 200 })
    );
  });
});
