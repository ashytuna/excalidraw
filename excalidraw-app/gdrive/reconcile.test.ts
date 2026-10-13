import { decideSync } from "./reconcile";

const base = {
  localHash: "L",
  remoteHash: "R" as string | null,
  lastSyncedHash: null as string | null,
  localIsEmpty: false,
};

describe("decideSync", () => {
  it("pushes when Drive has no copy yet", () => {
    expect(decideSync({ ...base, remoteHash: null })).toBe("push");
  });

  it("is in sync when hashes match", () => {
    expect(decideSync({ ...base, remoteHash: "L" })).toBe("in-sync");
  });

  it("pushes silently when only local changed since last sync", () => {
    expect(decideSync({ ...base, lastSyncedHash: "R" })).toBe("push");
  });

  it("asks when only Drive changed since last sync (paimon.moe style)", () => {
    expect(decideSync({ ...base, localHash: "S", lastSyncedHash: "S" })).toBe(
      "conflict",
    );
  });

  it("asks when both changed", () => {
    expect(decideSync({ ...base, lastSyncedHash: "X" })).toBe("conflict");
  });

  it("asks on first connect when both sides have different data", () => {
    expect(decideSync(base)).toBe("conflict");
  });

  it("takes Drive's copy when local is empty", () => {
    expect(decideSync({ ...base, localIsEmpty: true })).toBe("pull");
    expect(
      decideSync({ ...base, localIsEmpty: true, lastSyncedHash: "X" }),
    ).toBe("pull");
  });
});
