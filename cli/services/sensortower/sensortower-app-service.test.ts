import { jest } from "@jest/globals";
import {
  fetchSensorTowerAppMetrics,
  fetchSensorTowerMetricsForApps,
} from "./sensortower-app-service";

jest.mock("axios", () => {
  const get = jest.fn();
  return {
    __esModule: true,
    default: {
      create: jest.fn(() => ({ get })),
    },
    __mockGet: get,
  };
});

const mockGet = (jest.requireMock("axios") as { __mockGet: jest.Mock }).__mockGet as any;

describe("sensortower app service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("maps worldwide last-month display strings from the Sensor Tower response", async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        apps: [
          {
            app_id: 6759623397,
            humanized_worldwide_last_month_downloads: { string: "100k" },
            humanized_worldwide_last_month_revenue: { string: "$50k" },
          },
        ],
      },
    });

    await expect(fetchSensorTowerAppMetrics("6759623397")).resolves.toEqual({
      lastMonthDownloads: "100k",
      lastMonthRevenue: "$50k",
    });
    expect(mockGet).toHaveBeenCalledWith(
      "https://app.sensortower.com/api/ios/apps",
      {
        params: { app_ids: "6759623397" },
        timeout: 10_000,
      }
    );
  });

  it("isolates failures and skips non-iOS app IDs", async () => {
    const onError = jest.fn();
    mockGet
      .mockResolvedValueOnce({
        data: {
          apps: [
            {
              app_id: 1,
              humanized_worldwide_last_month_downloads: { string: "2k" },
            },
          ],
        },
      })
      .mockRejectedValueOnce(new Error("Sensor Tower unavailable"));

    await expect(
      fetchSensorTowerMetricsForApps(["1", "2", "com.example.app"], onError)
    ).resolves.toEqual(new Map([["1", { lastMonthDownloads: "2k" }]]));
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      "2"
    );
  });
});
