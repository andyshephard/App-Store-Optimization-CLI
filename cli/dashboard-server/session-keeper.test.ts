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
