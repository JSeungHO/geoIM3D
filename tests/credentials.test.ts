import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  CREDENTIAL_IDS,
  createCredentialBackend,
  credentialDiagnostics,
  credentialErrorCode,
  isCredentialId,
  type CredentialInvoke,
} from "../apps/geolibre-desktop/src/lib/credentials";

/** Records the commands the desktop backend invokes. */
function recordingInvoke(result: unknown = null) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke: CredentialInvoke = async (command, args) => {
    calls.push({ command, args });
    return result as never;
  };
  return { calls, invoke };
}

const rejectingInvoke: CredentialInvoke = () =>
  Promise.reject(new Error("credential_backend_unavailable"));

describe("credential id allowlist", () => {
  it("stays in sync with the Rust allowlist", () => {
    // The two lists gate the same commands from opposite sides. If only one is
    // updated, the frontend either offers an id Rust rejects or silently stops
    // loading one the store still holds.
    const rust = readFileSync(
      new URL("../apps/geolibre-desktop/src-tauri/src/credential_store.rs", import.meta.url),
      "utf8",
    );
    const block = /ALLOWED_CREDENTIAL_IDS: \[&str; (\d+)\] = \[([\s\S]*?)\];/.exec(rust);
    assert.ok(block, "ALLOWED_CREDENTIAL_IDS not found in credential_store.rs");
    const rustIds = [...block[2].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(rustIds, [...CREDENTIAL_IDS]);
    // The declared array length must match too, or the Rust file will not compile.
    assert.equal(Number(block[1]), CREDENTIAL_IDS.length);
  });

  it("rejects anything outside the allowlist", () => {
    assert.equal(isCredentialId("vworld:api-key"), true);
    assert.equal(isCredentialId("../../arbitrary"), false);
    assert.equal(isCredentialId("AWS_PROFILE"), false);
    assert.equal(isCredentialId(""), false);
  });
});

describe("memory backend (web)", () => {
  it("keeps values only in memory and starts empty", async () => {
    const backend = createCredentialBackend({ desktop: false, invoke: rejectingInvoke });
    assert.equal(backend.kind, "memory");
    assert.deepEqual((await backend.load()).values, {});

    await backend.set("vworld:api-key", "  key-value  ");
    assert.deepEqual((await backend.load()).values, { "vworld:api-key": "key-value" });

    // A fresh backend is a fresh session: nothing persisted anywhere.
    const reloaded = createCredentialBackend({ desktop: false, invoke: rejectingInvoke });
    assert.deepEqual((await reloaded.load()).values, {});
  });

  it("refuses an empty write instead of treating it as a delete", async () => {
    const backend = createCredentialBackend({ desktop: false, invoke: rejectingInvoke });
    await backend.set("vworld:api-key", "key-value");
    await assert.rejects(
      () => backend.set("vworld:api-key", "   "),
      (error: Error) => error.message === "credential_invalid_value",
    );
    // The stored credential survives the rejected write.
    assert.deepEqual((await backend.load()).values, { "vworld:api-key": "key-value" });
  });

  it("deletes explicitly and clears everything on demand", async () => {
    const backend = createCredentialBackend({ desktop: false, invoke: rejectingInvoke });
    await backend.set("vworld:api-key", "key-value");
    await backend.delete("vworld:api-key");
    assert.deepEqual((await backend.load()).values, {});

    await backend.set("vworld:api-key", "key-value");
    await backend.clear();
    assert.deepEqual((await backend.load()).values, {});
  });
});

describe("OS backend (desktop)", () => {
  it("routes through the Tauri commands with the credential id", async () => {
    const { calls, invoke } = recordingInvoke();
    const backend = createCredentialBackend({ desktop: true, invoke });
    assert.equal(backend.kind, "os");

    await backend.set("vworld:api-key", " key-value ");
    await backend.delete("vworld:api-key");
    await backend.clear();

    assert.deepEqual(calls, [
      { command: "credential_set", args: { credentialId: "vworld:api-key", value: "key-value" } },
      { command: "credential_delete", args: { credentialId: "vworld:api-key" } },
      { command: "credential_clear", args: undefined },
    ]);
  });

  it("keeps the values a partial load did return alongside the error code", async () => {
    // One unreadable entry must not blank out the rest, or a single corrupt
    // item would make every credential look unset.
    const { invoke } = recordingInvoke({
      values: { "vworld:api-key": "key-value" },
      errorCode: "credential_read_failed",
    });
    const backend = createCredentialBackend({ desktop: true, invoke });
    const result = await backend.load();
    assert.deepEqual(result.values, { "vworld:api-key": "key-value" });
    assert.equal(result.errorCode, "credential_read_failed");
  });

  it("drops unknown ids and non-string values from a load", async () => {
    const { invoke } = recordingInvoke({
      values: { "vworld:api-key": "key-value", "evil:id": "x", "cesium:ion-token": 42 },
    });
    const backend = createCredentialBackend({ desktop: true, invoke });
    assert.deepEqual((await backend.load()).values, { "vworld:api-key": "key-value" });
  });

  it("refuses an empty write before reaching the command", async () => {
    const { calls, invoke } = recordingInvoke();
    const backend = createCredentialBackend({ desktop: true, invoke });
    await assert.rejects(
      () => backend.set("vworld:api-key", ""),
      (error: Error) => error.message === "credential_invalid_value",
    );
    assert.equal(calls.length, 0);
  });
});

describe("credentialErrorCode", () => {
  it("passes through known codes and collapses anything else", () => {
    assert.equal(
      credentialErrorCode(new Error("credential_write_failed"), "credential_read_failed"),
      "credential_write_failed",
    );
    // An unexpected message must not reach the UI: it could echo an argument
    // (and therefore part of a credential) back onto the screen.
    assert.equal(
      credentialErrorCode(new Error("key ABC123 rejected"), "credential_write_failed"),
      "credential_write_failed",
    );
    assert.equal(credentialErrorCode(undefined, "credential_read_failed"), "credential_read_failed");
  });
});

describe("credentialDiagnostics", () => {
  it("reports which ids are set and never the values", () => {
    const report = credentialDiagnostics({
      backend: "os",
      loaded: true,
      values: { "vworld:api-key": "super-secret-value" },
      errorCode: null,
    });
    assert.deepEqual(report, {
      backend: "os",
      loaded: true,
      configuredIds: ["vworld:api-key"],
      errorCode: null,
    });
    assert.ok(!JSON.stringify(report).includes("super-secret-value"));
  });
});
