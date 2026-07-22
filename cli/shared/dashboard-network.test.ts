import {
  formatDashboardHttpUrl,
  getDashboardBrowserUrl,
  getDashboardExposureWarning,
  isLoopbackDashboardHost,
  normalizeDashboardBindHost,
} from "./dashboard-network";

describe("dashboard-network", () => {
  it("normalizes bracketed IPv6 bind hosts", () => {
    expect(normalizeDashboardBindHost(" [::] ")).toBe("::");
    expect(normalizeDashboardBindHost("[::1]")).toBe("::1");
    expect(normalizeDashboardBindHost("dashboard.internal")).toBe(
      "dashboard.internal"
    );
  });

  it("formats IPv4, hostname, and IPv6 dashboard URLs", () => {
    expect(formatDashboardHttpUrl("127.0.0.1", 3456)).toBe(
      "http://127.0.0.1:3456"
    );
    expect(formatDashboardHttpUrl("dashboard.internal", 4807)).toBe(
      "http://dashboard.internal:4807"
    );
    expect(formatDashboardHttpUrl("::1", 3456)).toBe("http://[::1]:3456");
  });

  it("uses matching loopback addresses for wildcard browser URLs", () => {
    expect(getDashboardBrowserUrl("0.0.0.0", 3456)).toBe(
      "http://127.0.0.1:3456"
    );
    expect(getDashboardBrowserUrl("::", 3456)).toBe("http://[::1]:3456");
    expect(getDashboardBrowserUrl("::1", 3456)).toBe("http://[::1]:3456");
  });

  it("recognizes loopback hosts", () => {
    expect(isLoopbackDashboardHost("localhost")).toBe(true);
    expect(isLoopbackDashboardHost("dashboard.localhost")).toBe(true);
    expect(isLoopbackDashboardHost("127.0.0.2")).toBe(true);
    expect(isLoopbackDashboardHost("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isLoopbackDashboardHost("0.0.0.0")).toBe(false);
    expect(isLoopbackDashboardHost("dashboard.internal")).toBe(false);
  });

  it("warns only for non-loopback dashboard hosts", () => {
    expect(getDashboardExposureWarning("127.0.0.1", 3456)).toBeNull();
    expect(getDashboardExposureWarning("::1", 3456)).toBeNull();
    expect(getDashboardExposureWarning("0.0.0.0", 3456)).toContain(
      "without authentication"
    );
    expect(getDashboardExposureWarning("::", 3456)).toContain(
      "http://[::]:3456"
    );
  });
});
