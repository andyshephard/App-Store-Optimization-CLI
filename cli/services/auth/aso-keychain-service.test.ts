import { jest } from "@jest/globals";
import { execFileSync } from "child_process";
import {
  AsoKeychainService,
  hasEnvAppleCredentials,
} from "./aso-keychain-service";

jest.mock("child_process", () => ({
  execFileSync: jest.fn(),
}));

/**
 * The keychain is macOS-only, so these suites pin `process.platform` rather
 * than inheriting the host's. Without that, the whole file behaves differently
 * on a Linux CI runner than on a developer's Mac.
 */
function setPlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
  return () => {
    if (original) Object.defineProperty(process, "platform", original);
  };
}

describe("AsoKeychainService on macOS", () => {
  const mockExecFileSync = jest.mocked(execFileSync);
  const service = new AsoKeychainService();
  let restorePlatform: () => void = () => {};

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ASO_DISABLE_CREDENTIAL_STORE;
    restorePlatform = setPlatform("darwin");
  });

  afterEach(() => {
    restorePlatform();
  });

  it("loads credentials from keychain when payload is valid", () => {
    mockExecFileSync.mockReturnValue(
      JSON.stringify({ appleId: "user@example.com", password: "pw" }) as any
    );

    const credentials = service.loadCredentials();

    expect(credentials).toEqual({
      appleId: "user@example.com",
      password: "pw",
    });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "security",
      [
        "find-generic-password",
        "-s",
        "aso.cli.apple",
        "-a",
        "default",
        "-w",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
  });

  it("returns null when payload is malformed or missing fields", () => {
    mockExecFileSync.mockReturnValue("{}" as any);
    expect(service.loadCredentials()).toBeNull();

    mockExecFileSync.mockReturnValue("not-json" as any);
    expect(service.loadCredentials()).toBeNull();
  });

  it("returns null when keychain lookup fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    expect(service.loadCredentials()).toBeNull();
  });

  it("saves credentials to keychain", () => {
    mockExecFileSync.mockReturnValue("" as any);

    service.saveCredentials({
      appleId: "user@example.com",
      password: "pw",
    });

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "security",
      [
        "add-generic-password",
        "-U",
        "-s",
        "aso.cli.apple",
        "-a",
        "default",
        "-w",
        JSON.stringify({ appleId: "user@example.com", password: "pw" }),
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
  });

  it("swallows clear errors", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("delete failed");
    });

    expect(() => service.clearCredentials()).not.toThrow();
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "security",
      [
        "delete-generic-password",
        "-s",
        "aso.cli.apple",
        "-a",
        "default",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
  });
});

describe("AsoKeychainService without an OS credential store", () => {
  const mockExecFileSync = jest.mocked(execFileSync);
  const service = new AsoKeychainService();
  let restorePlatform: () => void = () => {};

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ASO_DISABLE_CREDENTIAL_STORE;
    restorePlatform = setPlatform("linux");
  });

  afterEach(() => {
    restorePlatform();
  });

  it("reports itself unavailable and never shells out", () => {
    expect(service.isAvailable()).toBe(false);
    expect(service.loadCredentials()).toBeNull();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  // The regression this guards: saveCredentials runs *after* a successful
  // Apple login, so throwing ENOENT here would discard a session the user had
  // just completed two-factor authentication for.
  it("does not throw when saving credentials", () => {
    expect(() =>
      service.saveCredentials({ appleId: "user@example.com", password: "pw" })
    ).not.toThrow();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("does not throw when clearing credentials", () => {
    expect(() => service.clearCredentials()).not.toThrow();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("never fails a login even if the store throws", () => {
    const restore = setPlatform("darwin");
    mockExecFileSync.mockImplementation(() => {
      throw new Error("keychain locked");
    });
    try {
      expect(() =>
        service.saveCredentials({ appleId: "user@example.com", password: "pw" })
      ).not.toThrow();
    } finally {
      restore();
    }
  });

  it("can be disabled explicitly on macOS", () => {
    const restore = setPlatform("darwin");
    process.env.ASO_DISABLE_CREDENTIAL_STORE = "1";
    try {
      expect(service.isAvailable()).toBe(false);
      expect(service.loadCredentials()).toBeNull();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    } finally {
      delete process.env.ASO_DISABLE_CREDENTIAL_STORE;
      restore();
    }
  });
});

describe("environment credentials", () => {
  const previousId = process.env.ASO_APPLE_ID;
  const previousPassword = process.env.ASO_APPLE_PASSWORD;

  afterEach(() => {
    for (const [key, value] of [
      ["ASO_APPLE_ID", previousId],
      ["ASO_APPLE_PASSWORD", previousPassword],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("reports none when either value is missing", () => {
    delete process.env.ASO_APPLE_ID;
    delete process.env.ASO_APPLE_PASSWORD;
    expect(hasEnvAppleCredentials()).toBe(false);

    process.env.ASO_APPLE_ID = "user@example.com";
    expect(hasEnvAppleCredentials()).toBe(false);
  });

  // This is what lets a server re-authenticate unattended, so it must work on
  // Linux where there is no OS credential store at all.
  it("supplies credentials on a platform with no credential store", () => {
    process.env.ASO_APPLE_ID = "user@example.com";
    process.env.ASO_APPLE_PASSWORD = "pw";
    const restore = setPlatform("linux");
    try {
      expect(hasEnvAppleCredentials()).toBe(true);
      expect(new AsoKeychainService().loadCredentials()).toEqual({
        appleId: "user@example.com",
        password: "pw",
      });
    } finally {
      restore();
    }
  });

  it("takes precedence over the OS credential store", () => {
    process.env.ASO_APPLE_ID = "env@example.com";
    process.env.ASO_APPLE_PASSWORD = "env-pw";
    const restore = setPlatform("darwin");
    try {
      expect(new AsoKeychainService().loadCredentials()).toEqual({
        appleId: "env@example.com",
        password: "env-pw",
      });
      } finally {
      restore();
    }
  });
});
