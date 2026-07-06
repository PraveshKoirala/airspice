/**
 * Unit tests for the signed daily-budget token (issue #20).
 *
 * A token is a BUDGET RECEIPT, not a user id: verify that a fresh mint
 * round-trips, that the wrong day rejects, that a tampered signature
 * rejects, and that a malformed input never throws.
 */

import { describe, it, expect } from "vitest";
import { mintToken, verifyToken, utcDay } from "../src/token.js";

const SECRET = "test_signing_secret_do_not_use";

describe("token", () => {
  it("utcDay returns YYYY-MM-DD in UTC", () => {
    expect(utcDay(new Date("2026-07-05T23:59:00Z"))).toBe("2026-07-05");
    expect(utcDay(new Date("2026-01-01T00:00:01Z"))).toBe("2026-01-01");
  });

  it("mint + verify round-trips on the same day", async () => {
    const day = utcDay(new Date("2026-07-05T12:00:00Z"));
    const { token } = await mintToken(SECRET, day, 50000);
    const payload = await verifyToken(SECRET, token, day);
    expect(payload).not.toBeNull();
    expect(payload!.day).toBe(day);
    expect(payload!.budget).toBe(50000);
    expect(typeof payload!.nonce).toBe("string");
  });

  it("rejects a token whose day is not today", async () => {
    const { token } = await mintToken(SECRET, "2026-07-05", 10000);
    const payload = await verifyToken(SECRET, token, "2026-07-06");
    expect(payload).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const { token } = await mintToken(SECRET, "2026-07-05", 10000);
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]!.slice(0, -1)}A`;
    const payload = await verifyToken(SECRET, tampered, "2026-07-05");
    expect(payload).toBeNull();
  });

  it("rejects with a wrong secret", async () => {
    const { token } = await mintToken(SECRET, "2026-07-05", 10000);
    const payload = await verifyToken("different_secret", token, "2026-07-05");
    expect(payload).toBeNull();
  });

  it("returns null (never throws) on garbage input", async () => {
    for (const bad of ["", "no-dot", "a.b", ".sig", "header.", "not.base64!@#"]) {
      const payload = await verifyToken(SECRET, bad, "2026-07-05");
      expect(payload).toBeNull();
    }
  });

  it("mints unique nonces across successive tokens", async () => {
    const day = "2026-07-05";
    const { payload: a } = await mintToken(SECRET, day, 100);
    const { payload: b } = await mintToken(SECRET, day, 100);
    expect(a.nonce).not.toBe(b.nonce);
  });
});
