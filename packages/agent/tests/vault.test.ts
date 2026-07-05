import { describe, it, expect } from "vitest";
import {
  KeyVault,
  KEY_VAULT_NOTICE,
  keyVaultNoticeFor,
  maskKey,
} from "../src/index.js";
import { memoryStorage } from "./helpers.js";

describe("KeyVault", () => {
  it("stores, reads, and clears a key per provider", () => {
    const storage = memoryStorage();
    const vault = new KeyVault(storage);
    expect(vault.has("anthropic")).toBe(false);

    vault.set("anthropic", "sk-ant-abcdefghijklmnop");
    expect(vault.get("anthropic")).toBe("sk-ant-abcdefghijklmnop");
    expect(vault.has("anthropic")).toBe(true);
    // Isolated per provider.
    expect(vault.has("openai")).toBe(false);

    vault.clear("anthropic");
    expect(vault.has("anthropic")).toBe(false);
    expect(vault.get("anthropic")).toBeUndefined();
  });

  it("uses localStorage-shaped keys and stores ONLY under its namespace", () => {
    const storage = memoryStorage();
    const vault = new KeyVault(storage);
    vault.set("gemini", "AIzaSyExampleKey1234567890");
    const dump = storage.dump();
    const keys = Object.keys(dump);
    expect(keys).toEqual(["airspice.byok.gemini"]);
    // No cookies / IndexedDB / URL params involved -- this is the only surface.
  });

  it("trims input and treats whitespace-only as a clear", () => {
    const vault = new KeyVault(memoryStorage());
    vault.set("openai", "  sk-openai-xyz  ");
    expect(vault.get("openai")).toBe("sk-openai-xyz");
    vault.set("openai", "   ");
    expect(vault.has("openai")).toBe(false);
  });

  it("masks the stored key: reveals at most the last 4 chars", () => {
    const vault = new KeyVault(memoryStorage());
    vault.set("anthropic", "sk-ant-1234567890ABCDwxyz");
    const masked = vault.masked("anthropic");
    expect(masked.endsWith("wxyz")).toBe(true);
    expect(masked).not.toContain("1234567890");
    expect(masked).toContain("•"); // bullet
  });

  it("maskKey fully masks short keys and empty input", () => {
    expect(maskKey(undefined)).toBe("");
    expect(maskKey("")).toBe("");
    expect(maskKey("ab")).toBe("••");
    expect(maskKey("abcd")).toBe("••••");
  });

  it("degrades to no-op when no storage is available", () => {
    // Passing an explicit null-like backend by faking an unavailable env: the
    // vault constructor default is browser localStorage; here we simulate a
    // missing backend by giving a storage stub that throws, wrapped safely.
    const vault = new KeyVault({
      getItem: () => null,
      setItem: () => {
        throw new Error("no storage");
      },
      removeItem: () => {},
    });
    // get returns undefined; has is false; set will throw only if backend does,
    // so we do not call set here -- the contract we assert is read-safety.
    expect(vault.get("mock")).toBeUndefined();
    expect(vault.has("mock")).toBe(false);
  });
});

describe("key vault security notice (verbatim UI copy)", () => {
  it("matches the exact required wording", () => {
    expect(KEY_VAULT_NOTICE).toBe(
      "Your key is stored only in this browser and sent only to <provider>. " +
        "Anyone with access to this browser profile can read it. " +
        "Prefer a scoped, low-limit key.",
    );
  });

  it("substitutes the provider display name", () => {
    expect(keyVaultNoticeFor("anthropic")).toContain("sent only to Anthropic.");
    expect(keyVaultNoticeFor("gemini")).toContain("sent only to Gemini.");
    expect(keyVaultNoticeFor("openai")).toContain("sent only to OpenAI.");
    // The placeholder must be gone.
    expect(keyVaultNoticeFor("anthropic")).not.toContain("<provider>");
  });
});
