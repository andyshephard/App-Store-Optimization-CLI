import { createSessionKeeper } from "./session-keeper";

describe("session-keeper", () => {
  it("records a healthy session", async () => {
    const keeper = createSessionKeeper({ reAuthenticate: async () => "cookie", onNeedsTwoFactor: jest.fn() });
    const state = await keeper.check();
    expect(state).toMatchObject({ ok: true, needsTwoFactor: false, lastError: null });
    expect(state.lastOkAt).toBe(state.lastCheckAt);
  });

  it("fails fast instead of waiting for a 2FA code, and alerts", async () => {
    const onNeedsTwoFactor = jest.fn();
    const keeper = createSessionKeeper({
      reAuthenticate: async (options) => options.promptHandler.prompt({ kind: "code" }),
      onNeedsTwoFactor,
    });
    const state = await keeper.check();
    expect(state).toMatchObject({ ok: false, needsTwoFactor: true });
    expect(onNeedsTwoFactor).toHaveBeenCalledTimes(1);
  });

  it("does not alert for ordinary failures", async () => {
    const onNeedsTwoFactor = jest.fn();
    const keeper = createSessionKeeper({
      reAuthenticate: async () => {
        throw new Error("ECONNRESET");
      },
      onNeedsTwoFactor,
    });
    const state = await keeper.check();
    expect(state).toMatchObject({ ok: false, needsTwoFactor: false });
    expect(onNeedsTwoFactor).not.toHaveBeenCalled();
  });

  it("times out a hung attempt", async () => {
    const keeper = createSessionKeeper({
      reAuthenticate: () => new Promise(() => {}),
      onNeedsTwoFactor: jest.fn(),
      timeoutMs: 20,
    });
    await expect(keeper.check()).resolves.toMatchObject({ ok: false, lastError: "session check timed out" });
  });
});

describe("session-keeper markOk", () => {
  it("clears needsTwoFactor after a dashboard login", async () => {
    const keeper = createSessionKeeper({
      reAuthenticate: async (options) => options.promptHandler.prompt({ kind: "code" }),
      onNeedsTwoFactor: jest.fn(),
    });
    await keeper.check();
    expect(keeper.getState().needsTwoFactor).toBe(true);
    keeper.markOk();
    expect(keeper.getState()).toMatchObject({ ok: true, needsTwoFactor: false, lastError: null });
  });
});

describe("session-keeper probe", () => {
  it("skips the full login when the probe says the session works", async () => {
    const reAuthenticate = jest.fn(async () => "cookie");
    const keeper = createSessionKeeper({
      probe: async () => "ok" as const,
      reAuthenticate,
      onNeedsTwoFactor: jest.fn(),
    });

    await expect(keeper.check()).resolves.toMatchObject({ ok: true });
    expect(reAuthenticate).not.toHaveBeenCalled();
  });

  it("logs in only when the probe is rejected", async () => {
    const reAuthenticate = jest.fn(async () => "cookie");
    const rejected = createSessionKeeper({
      probe: async () => "rejected" as const,
      reAuthenticate,
      onNeedsTwoFactor: jest.fn(),
    });

    await expect(rejected.check()).resolves.toMatchObject({ ok: true });
    expect(reAuthenticate).toHaveBeenCalledTimes(1);
  });

  it("does not log in when the probe is inconclusive (throttled, 5xx, timeout)", async () => {
    const reAuthenticate = jest.fn(async () => "cookie");
    const unknown = createSessionKeeper({
      probe: async () => "unknown" as const,
      reAuthenticate,
      onNeedsTwoFactor: jest.fn(),
    });
    const throwing = createSessionKeeper({
      probe: async () => {
        throw new Error("ECONNRESET");
      },
      reAuthenticate,
      onNeedsTwoFactor: jest.fn(),
    });
    const hung = createSessionKeeper({
      probe: () => new Promise(() => {}),
      reAuthenticate,
      onNeedsTwoFactor: jest.fn(),
      timeoutMs: 20,
    });

    await expect(unknown.check()).resolves.toMatchObject({
      lastError: expect.stringContaining("inconclusive"),
      needsTwoFactor: false,
    });
    await throwing.check();
    await hung.check();
    expect(reAuthenticate).not.toHaveBeenCalled();
  });

  it("shares one attempt between overlapping checks", async () => {
    let release: () => void = () => {};
    const reAuthenticate = jest.fn(
      () => new Promise<string>((resolve) => (release = () => resolve("cookie")))
    );
    const keeper = createSessionKeeper({
      probe: async () => "rejected" as const,
      reAuthenticate,
      onNeedsTwoFactor: jest.fn(),
    });

    const first = keeper.check();
    const second = keeper.check();
    await new Promise((resolve) => setImmediate(resolve));
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(reAuthenticate).toHaveBeenCalledTimes(1);
  });

  it("stays out of the way of an interactive login", async () => {
    const reAuthenticate = jest.fn(async () => "cookie");
    const probe = jest.fn(async () => "ok" as const);
    const keeper = createSessionKeeper({
      probe,
      isAuthInProgress: () => true,
      reAuthenticate,
      onNeedsTwoFactor: jest.fn(),
    });

    await keeper.check();
    expect(probe).not.toHaveBeenCalled();
    expect(reAuthenticate).not.toHaveBeenCalled();
  });
});
