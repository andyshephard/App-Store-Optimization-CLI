import {
  clearReauthenticationAlertState,
  sendReauthenticationAlert,
} from "./reauth-alert-service";

const HOUR_MS = 60 * 60 * 1000;

describe("sendReauthenticationAlert", () => {
  const originalKey = process.env.ASO_RESEND_API_KEY;
  const originalTo = process.env.ASO_ALERT_EMAIL_TO;
  const originalFrom = process.env.ASO_ALERT_EMAIL_FROM;

  beforeEach(() => {
    process.env.ASO_RESEND_API_KEY = "re_test_key";
    process.env.ASO_ALERT_EMAIL_TO = "ops@example.com";
    process.env.ASO_ALERT_EMAIL_FROM = "keywords@example.com";
  });

  afterEach(() => {
    process.env.ASO_RESEND_API_KEY = originalKey;
    process.env.ASO_ALERT_EMAIL_TO = originalTo;
    process.env.ASO_ALERT_EMAIL_FROM = originalFrom;
  });

  it("sends and records when nothing was sent before", async () => {
    const sent: Array<Record<string, string>> = [];
    const written: string[] = [];
    const now = Date.parse("2026-08-27T22:00:00.000Z");

    const outcome = await sendReauthenticationAlert(
      { detail: "trust cookie expired" },
      {
        mailer: async (payload) => {
          sent.push(payload);
        },
        now: () => now,
        readLastSentAt: () => null,
        writeLastSentAt: (iso) => written.push(iso),
      }
    );

    expect(outcome).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("ops@example.com");
    expect(sent[0].from).toBe("keywords@example.com");
    expect(sent[0].subject).toContain("reauthentication");
    expect(sent[0].text).toContain("trust cookie expired");
    expect(written).toEqual(["2026-08-27T22:00:00.000Z"]);
  });

  it("suppresses a second alert for the same outage", async () => {
    const sent: unknown[] = [];
    const now = Date.parse("2026-08-28T02:00:00.000Z");

    const outcome = await sendReauthenticationAlert(
      {},
      {
        mailer: async (payload) => {
          sent.push(payload);
        },
        now: () => now,
        readLastSentAt: () => new Date(now - 4 * HOUR_MS).toISOString(),
        writeLastSentAt: () => {},
      }
    );

    expect(outcome).toBe("suppressed");
    expect(sent).toHaveLength(0);
  });

  it("alerts again once the suppression window has passed", async () => {
    const sent: unknown[] = [];
    const now = Date.parse("2026-08-29T02:00:00.000Z");

    const outcome = await sendReauthenticationAlert(
      {},
      {
        mailer: async (payload) => {
          sent.push(payload);
        },
        now: () => now,
        readLastSentAt: () => new Date(now - 25 * HOUR_MS).toISOString(),
        writeLastSentAt: () => {},
      }
    );

    expect(outcome).toBe("sent");
    expect(sent).toHaveLength(1);
  });

  it("ignores suppression when forced, so a test send always goes out", async () => {
    const sent: unknown[] = [];
    const now = Date.parse("2026-08-28T02:00:00.000Z");

    const outcome = await sendReauthenticationAlert(
      { force: true },
      {
        mailer: async (payload) => {
          sent.push(payload);
        },
        now: () => now,
        readLastSentAt: () => new Date(now - 1 * HOUR_MS).toISOString(),
        writeLastSentAt: () => {},
      }
    );

    expect(outcome).toBe("sent");
    expect(sent).toHaveLength(1);
  });

  it("does not arm suppression on a forced send, so a real failure later that day still alerts", async () => {
    const written: string[] = [];

    await sendReauthenticationAlert(
      { force: true },
      {
        mailer: async () => {},
        now: () => Date.parse("2026-08-28T02:00:00.000Z"),
        readLastSentAt: () => null,
        writeLastSentAt: (iso) => written.push(iso),
      }
    );

    expect(written).toEqual([]);
  });

  it("does not record a timestamp when sending failed, so the incident can still alert", async () => {
    const written: string[] = [];

    const outcome = await sendReauthenticationAlert(
      {},
      {
        mailer: async () => {
          throw new Error("Resend returned 422");
        },
        now: () => Date.now(),
        readLastSentAt: () => null,
        writeLastSentAt: (iso) => written.push(iso),
      }
    );

    expect(outcome).toBe("failed");
    expect(written).toEqual([]);
  });

  it("is a no-op with no API key, so an unconfigured install is unaffected", async () => {
    delete process.env.ASO_RESEND_API_KEY;
    const sent: unknown[] = [];

    const outcome = await sendReauthenticationAlert(
      {},
      {
        mailer: async (payload) => {
          sent.push(payload);
        },
      }
    );

    expect(outcome).toBe("not-configured");
    expect(sent).toHaveLength(0);
  });

  it("clears the suppression record after a healthy run", () => {
    const written: string[] = [];
    clearReauthenticationAlertState({
      writeLastSentAt: (iso) => written.push(iso),
    });
    expect(written).toEqual([""]);
  });
});
