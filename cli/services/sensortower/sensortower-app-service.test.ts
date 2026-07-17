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

  afterEach(() => {
    jest.useRealTimers();
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

  it("fetches valid app IDs in one batch and maps an unordered partial response", async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        apps: [
          {
            app_id: 2,
            humanized_worldwide_last_month_revenue: { string: "$8k" },
          },
          {
            app_id: 1,
            humanized_worldwide_last_month_downloads: { string: "2k" },
          },
        ],
      },
    });

    await expect(
      fetchSensorTowerMetricsForApps(["1", "2", "com.example.app", "1"])
    ).resolves.toEqual(
      new Map([
        ["2", { lastMonthRevenue: "$8k" }],
        ["1", { lastMonthDownloads: "2k" }],
      ])
    );
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith(
      "https://app.sensortower.com/api/ios/apps",
      {
        params: { app_ids: "1,2" },
        timeout: 10_000,
      }
    );
  });

  it("retries a rate-limited batch once", async () => {
    jest.useFakeTimers();
    mockGet
      .mockRejectedValueOnce({
        response: { status: 429, headers: { "retry-after": "0" } },
      })
      .mockResolvedValueOnce({
        data: {
          apps: [
            {
              app_id: 1,
              humanized_worldwide_last_month_downloads: { string: "2k" },
            },
          ],
        },
      });

    const result = fetchSensorTowerMetricsForApps(["1"]);
    await jest.runOnlyPendingTimersAsync();

    await expect(result).resolves.toEqual(
      new Map([["1", { lastMonthDownloads: "2k" }]])
    );
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("reports one terminal batch failure without retrying non-429 errors", async () => {
    const onError = jest.fn();
    const error = { response: { status: 503 } };
    mockGet.mockRejectedValueOnce(error);

    await expect(
      fetchSensorTowerMetricsForApps(["1", "2", "com.example.app"], onError)
    ).resolves.toEqual(new Map());
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error, ["1", "2"]);
  });
});
