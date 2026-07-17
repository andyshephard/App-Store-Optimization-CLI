import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getSensorTowerAppMetrics,
  upsertSensorTowerAppMetrics,
} from "./sensor-tower-app-metrics";
import { closeDbForTests } from "./store";

const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `aso-sensor-tower-metrics-${process.pid}-${Date.now()}.sqlite`
);

function cleanDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("sensor tower app metrics", () => {
  beforeAll(() => {
    process.env.ASO_DB_PATH = TEST_DB_PATH;
  });

  beforeEach(() => {
    closeDbForTests();
    cleanDbFiles();
  });

  afterAll(() => {
    closeDbForTests();
    cleanDbFiles();
    delete process.env.ASO_DB_PATH;
  });

  it("stores metrics globally by app ID and returns them in requested order", () => {
    upsertSensorTowerAppMetrics(
      [
        {
          appId: "2",
          lastMonthDownloads: "20k",
          lastMonthRevenue: "$8k",
        },
        {
          appId: "1",
          lastMonthDownloads: "10k",
          lastMonthRevenue: "$5k",
        },
      ],
      "2026-07-01T00:00:00.000Z"
    );

    expect(getSensorTowerAppMetrics(["1", "missing", "2"])).toEqual([
      {
        appId: "1",
        lastMonthDownloads: "10k",
        lastMonthRevenue: "$5k",
        fetchedAt: "2026-07-01T00:00:00.000Z",
      },
      {
        appId: "2",
        lastMonthDownloads: "20k",
        lastMonthRevenue: "$8k",
        fetchedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
  });

  it("updates metrics and their fetch timestamp for an existing app", () => {
    upsertSensorTowerAppMetrics(
      [
        {
          appId: "1",
          lastMonthDownloads: "10k",
          lastMonthRevenue: "$5k",
        },
      ],
      "2026-07-01T00:00:00.000Z"
    );
    upsertSensorTowerAppMetrics(
      [
        {
          appId: "1",
          lastMonthDownloads: "30k",
          lastMonthRevenue: "$12k",
        },
      ],
      "2026-07-08T00:00:00.000Z"
    );

    expect(getSensorTowerAppMetrics(["1"])).toEqual([
      {
        appId: "1",
        lastMonthDownloads: "30k",
        lastMonthRevenue: "$12k",
        fetchedAt: "2026-07-08T00:00:00.000Z",
      },
    ]);
  });
});
