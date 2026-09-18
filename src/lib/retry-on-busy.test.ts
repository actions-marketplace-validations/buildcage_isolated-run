import { describe, it, expect } from "vitest";

import { retryOnBusy } from "./retry-on-busy.ts";

describe("retryOnBusy", () => {
  it("returns the result of a call that succeeds first time", () => {
    let calls = 0;
    const result = retryOnBusy(() => {
      calls++;
      return "done";
    });
    expect(result).toBe("done");
    expect(calls).toBe(1);
  });

  it("tries again until the call succeeds", () => {
    let calls = 0;
    const result = retryOnBusy(
      () => {
        calls++;
        if (calls < 3) throw new Error("busy");
        return "done";
      },
      { delayMs: 0 },
    );
    expect(result).toBe("done");
    expect(calls).toBe(3);
  });

  it("gives up after the last attempt, throwing what that attempt threw", () => {
    let calls = 0;
    expect(() =>
      retryOnBusy(
        () => {
          calls++;
          throw new Error(`failure ${calls}`);
        },
        { attempts: 3, delayMs: 0 },
      ),
    ).toThrow("failure 3");
    expect(calls).toBe(3);
  });

  it("throws a failure retryOn rejects without trying again", () => {
    let calls = 0;
    expect(() =>
      retryOnBusy(
        () => {
          calls++;
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        },
        { delayMs: 0, retryOn: (e) => (e as NodeJS.ErrnoException).code === "EBUSY" },
      ),
    ).toThrow("gone");
    expect(calls).toBe(1);
  });
});
