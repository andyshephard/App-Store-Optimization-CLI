import { assertSupportedNodeVersion } from "./node-version-guard";

describe("assertSupportedNodeVersion", () => {
  it("does not throw for supported versions", () => {
    expect(() => assertSupportedNodeVersion("v22.22.0")).not.toThrow();
    expect(() => assertSupportedNodeVersion("v22.23.3")).not.toThrow();
    expect(() => assertSupportedNodeVersion("v24.1.0")).not.toThrow();
  });

  it("throws for versions below the minimum", () => {
    expect(() => assertSupportedNodeVersion("v20.19.5")).toThrow(
      /requires Node\.js >= 22\.22\.0/i
    );
    expect(() => assertSupportedNodeVersion("v22.21.9")).toThrow(
      /requires Node\.js >= 22\.22\.0/i
    );
  });
});
