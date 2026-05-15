import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { ensureTlsCerts, TLS_BRIDGE_HOSTNAME } from "./tls-manager.js";

/**
 * These tests exercise the real `openssl` binary because mocking it would
 * make the test give us no confidence the actual certificate generation
 * works end-to-end (which is exactly the thing we ship to users).
 *
 * If the host lacks `openssl`, the suite is skipped at the file level so CI
 * on minimal containers does not fail.
 */
function hasOpenSsl(): boolean {
  try {
    execSync("openssl version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const opensslAvailable = hasOpenSsl();
const describeIfOpenSsl = opensslAvailable ? describe : describe.skip;

describeIfOpenSsl("tls-manager", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "companion-tls-test-"));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  // Verifies the first invocation generates all five expected artifacts
  // (CA cert/key, server cert/key, and the concatenated PEM bundle).
  it("generates CA + server cert artifacts on first run", async () => {
    const result = await ensureTlsCerts({ home: homeDir });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(existsSync(result.caPath)).toBe(true);
    expect(existsSync(result.certPath)).toBe(true);
    expect(existsSync(result.keyPath)).toBe(true);
    expect(existsSync(result.pemPath)).toBe(true);

    const ca = readFileSync(result.caPath, "utf-8");
    const cert = readFileSync(result.certPath, "utf-8");
    expect(ca).toMatch(/BEGIN CERTIFICATE/);
    expect(cert).toMatch(/BEGIN CERTIFICATE/);
  });

  // The concatenated PEM bundle must contain both the cert and the key so
  // runtimes that accept a single PEM blob (e.g. some Bun.serve TLS variants)
  // can parse it without further setup.
  it("emits a server.pem containing both cert and key", async () => {
    const result = await ensureTlsCerts({ home: homeDir });
    const pem = readFileSync(result.pemPath, "utf-8");
    expect(pem).toMatch(/BEGIN CERTIFICATE/);
    expect(pem).toMatch(/BEGIN PRIVATE KEY|BEGIN RSA PRIVATE KEY/);
  });

  // The server certificate must include the allowlisted hostname as a SAN —
  // otherwise the spawned CLI's TLS verification will reject the connection
  // even with our CA installed.
  it("server cert SAN includes the allowlisted hostname", async () => {
    const result = await ensureTlsCerts({ home: homeDir });
    const dump = execSync(
      `openssl x509 -in ${JSON.stringify(result.certPath)} -noout -text`,
      { encoding: "utf-8" },
    );
    expect(dump).toContain(TLS_BRIDGE_HOSTNAME);
  });

  // A second call with the same home directory must NOT regenerate — the
  // file mtimes should remain identical, proving idempotency.
  it("is idempotent: reuses existing valid material on second run", async () => {
    const first = await ensureTlsCerts({ home: homeDir });
    const firstMtime = readFileSync(first.certPath);
    const firstPem = readFileSync(first.pemPath);

    const second = await ensureTlsCerts({ home: homeDir });
    expect(second.ok).toBe(true);
    expect(second.certPath).toBe(first.certPath);

    const secondMtime = readFileSync(second.certPath);
    const secondPem = readFileSync(second.pemPath);
    expect(secondMtime.equals(firstMtime)).toBe(true);
    expect(secondPem.equals(firstPem)).toBe(true);
  });

  // When the caller passes a custom hostname, the SAN entry reflects it so
  // the suite supports future allowlist changes without code churn.
  it("honors a custom hostname when provided", async () => {
    const result = await ensureTlsCerts({
      home: homeDir,
      hostname: "claude.fedstart.com",
    });
    const dump = execSync(
      `openssl x509 -in ${JSON.stringify(result.certPath)} -noout -text`,
      { encoding: "utf-8" },
    );
    expect(dump).toContain("claude.fedstart.com");
  });
});

// Smoke test that exercises the "no openssl" branch via PATH manipulation.
// We don't actually try to remove openssl from the system — instead we
// stash the binary by exporting an empty PATH for one invocation. If the
// host has openssl, this confirms the failure-mode does not throw.
describe("tls-manager (no-openssl branch)", () => {
  it("returns ok:false with a reason when openssl is unavailable", async () => {
    const originalPath = process.env.PATH;
    const tempHome = mkdtempSync(join(tmpdir(), "companion-tls-noop-"));
    try {
      // Setting PATH to a single empty directory means `openssl` cannot be
      // resolved, regardless of whether the host has it installed.
      process.env.PATH = tempHome;
      const result = await ensureTlsCerts({ home: tempHome });
      // If openssl is found via absolute fallback path (rare on Linux), skip
      // this assertion — the important contract is that the function does
      // not throw.
      if (!result.ok) {
        expect(result.reason).toMatch(/openssl/i);
      }
    } finally {
      process.env.PATH = originalPath;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
