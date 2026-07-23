import * as path from "path";
import { ASO_DEFAULTS, ASO_ENV } from "./aso-env";

describe("aso-env", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("uses centralized defaults when env is missing", () => {
    delete process.env.ASO_DB_PATH;
    delete process.env.ASO_PRIMARY_APP_ID;
    delete process.env.ASO_AUTH_MODE;
    delete process.env.ASO_APPLE_WIDGET_KEY;
    delete process.env.ASO_SIRP_RUBY_ORACLE;
    delete process.env.ASO_SIRP_USE_RUBY_PROOF;
    delete process.env.ASO_KEYWORD_ORDER_TTL_HOURS;
    delete process.env.ASO_APP_CACHE_TTL_HOURS;
    delete process.env.ASO_OWNED_APP_DOC_REFRESH_MAX_AGE_HOURS;
    delete process.env.ASO_DASHBOARD_HOST;
    delete process.env.ASO_DASHBOARD_PORT;

    expect(ASO_ENV.dbPath).toBe(ASO_DEFAULTS.dbPath);
    expect(ASO_ENV.primaryAppId).toBeNull();
    expect(ASO_ENV.authMode).toBe("auto");
    expect(ASO_ENV.appleWidgetKey).toBeNull();
    expect(ASO_ENV.sirpRubyOracle).toBe(false);
    expect(ASO_ENV.sirpUseRubyProof).toBe(false);
    expect(ASO_ENV.keywordOrderTtlHours).toBe(ASO_DEFAULTS.keywordOrderTtlHours);
    expect(ASO_ENV.appCacheTtlHours).toBe(ASO_DEFAULTS.appCacheTtlHours);
    expect(ASO_ENV.ownedAppDocRefreshMaxAgeMs).toBe(
      ASO_DEFAULTS.ownedAppDocRefreshMaxAgeHours * 60 * 60 * 1000
    );
    expect(ASO_ENV.dashboardHost).toBe("127.0.0.1");
    expect(ASO_ENV.dashboardPort).toBe(3456);
  });

  it("parses optional ASO runtime env settings", () => {
    process.env.ASO_DB_PATH = " ./tmp/aso.sqlite ";
    process.env.ASO_PRIMARY_APP_ID = " 123456789 ";
    process.env.ASO_AUTH_MODE = "sirp";
    process.env.ASO_APPLE_WIDGET_KEY = " widget-key ";
    process.env.ASO_SIRP_RUBY_ORACLE = "1";
    process.env.ASO_SIRP_USE_RUBY_PROOF = "1";

    expect(ASO_ENV.dbPath).toBe(path.resolve("./tmp/aso.sqlite"));
    expect(ASO_ENV.primaryAppId).toBe("123456789");
    expect(ASO_ENV.authMode).toBe("sirp");
    expect(ASO_ENV.appleWidgetKey).toBe("widget-key");
    expect(ASO_ENV.sirpRubyOracle).toBe(true);
    expect(ASO_ENV.sirpUseRubyProof).toBe(true);
  });

  it("falls back for invalid auth mode", () => {
    process.env.ASO_AUTH_MODE = "invalid";
    expect(ASO_ENV.authMode).toBe("auto");
  });

  it("parses dashboard host and port from env", () => {
    process.env.ASO_DASHBOARD_HOST = " [::1] ";
    process.env.ASO_DASHBOARD_PORT = "4807";

    expect(ASO_ENV.dashboardHost).toBe("::1");
    expect(ASO_ENV.dashboardPort).toBe(4807);
  });

  it.each(["4807oops", "12.5", "0x10", "-1", "65536", ""])(
    "falls back for invalid dashboard port %p",
    (value) => {
      process.env.ASO_DASHBOARD_PORT = value;
      expect(ASO_ENV.dashboardPort).toBe(ASO_DEFAULTS.dashboardPort);
    }
  );

  it("allows port zero for an automatically assigned port", () => {
    process.env.ASO_DASHBOARD_PORT = "0";
    expect(ASO_ENV.dashboardPort).toBe(0);
  });

  it("parses owned app refresh max age hours and falls back for invalid values", () => {
    process.env.ASO_OWNED_APP_DOC_REFRESH_MAX_AGE_HOURS = "1";
    expect(ASO_ENV.ownedAppDocRefreshMaxAgeMs).toBe(60 * 60 * 1000);

    process.env.ASO_OWNED_APP_DOC_REFRESH_MAX_AGE_HOURS = "0";
    expect(ASO_ENV.ownedAppDocRefreshMaxAgeMs).toBe(
      ASO_DEFAULTS.ownedAppDocRefreshMaxAgeHours * 60 * 60 * 1000
    );

    process.env.ASO_OWNED_APP_DOC_REFRESH_MAX_AGE_HOURS = "abc";
    expect(ASO_ENV.ownedAppDocRefreshMaxAgeMs).toBe(
      ASO_DEFAULTS.ownedAppDocRefreshMaxAgeHours * 60 * 60 * 1000
    );
  });
});
