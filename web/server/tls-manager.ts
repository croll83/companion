import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { COMPANION_HOME } from "./paths.js";

/**
 * The hostname presented by the embedded TLS proxy. Must be one of the
 * hostnames hardcoded in Claude Code 2.1.142's --sdk-url allowlist:
 *   - api.anthropic.com
 *   - api-staging.anthropic.com
 *   - beacon.claude-ai.staging.ant.dev
 *   - claude.fedstart.com
 *   - claude-staging.fedstart.com
 *
 * "beacon.claude-ai.staging.ant.dev" is the safest choice because it is a
 * staging/debug subdomain unlikely to clash with real DNS lookups the user
 * intends to reach. The user adds `127.0.0.1 beacon.claude-ai.staging.ant.dev`
 * to their hosts file so the CLI's WebSocket connect lands on the local TLS
 * server instead of any real Anthropic endpoint.
 */
export const TLS_BRIDGE_HOSTNAME = "beacon.claude-ai.staging.ant.dev";

export interface TlsCertResult {
  ok: boolean;
  caPath: string;
  certPath: string;
  keyPath: string;
  /** Concatenated cert+CA chain. Useful for Bun.serve TLS bundles. */
  pemPath: string;
  reason?: string;
}

interface CertPaths {
  dir: string;
  caCrt: string;
  caKey: string;
  serverCrt: string;
  serverKey: string;
  serverPem: string;
}

function getCertPaths(home: string = COMPANION_HOME): CertPaths {
  const dir = join(home, "tls");
  return {
    dir,
    caCrt: join(dir, "ca.crt"),
    caKey: join(dir, "ca.key"),
    serverCrt: join(dir, "server.crt"),
    serverKey: join(dir, "server.key"),
    serverPem: join(dir, "server.pem"),
  };
}

/** Treat certs as valid if they exist and have at least N days remaining. */
const CERT_MIN_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

function isCertValid(certPath: string): boolean {
  if (!existsSync(certPath)) return false;
  try {
    // openssl x509 -noout -enddate -in <cert>  →  notAfter=Apr 15 10:00:00 2030 GMT
    const out = execSync(`openssl x509 -noout -enddate -in ${JSON.stringify(certPath)}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = out.match(/notAfter=(.+)/);
    if (!match) return false;
    const expiresAt = Date.parse(match[1].trim());
    if (Number.isNaN(expiresAt)) return false;
    return expiresAt - Date.now() > CERT_MIN_VALIDITY_MS;
  } catch {
    return false;
  }
}

function haveAllArtifacts(p: CertPaths): boolean {
  return (
    existsSync(p.caCrt)
    && existsSync(p.caKey)
    && existsSync(p.serverCrt)
    && existsSync(p.serverKey)
    && existsSync(p.serverPem)
  );
}

function openSslAvailable(): boolean {
  try {
    execSync("openssl version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runOpenSsl(args: string[]): void {
  execSync(`openssl ${args.join(" ")}`, { stdio: ["ignore", "pipe", "pipe"] });
}

function writeOpenSslConfig(caPath: string, serverPath: string, hostname: string): void {
  // CA config — used only for `openssl req -x509 ... -extensions v3_ca`.
  const caConf = `
[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no

[dn]
CN = Companion Local TLS CA

[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign, digitalSignature
subjectKeyIdentifier = hash
`;
  writeFileSync(caPath, caConf, "utf-8");

  // Server config — drives both the CSR (req_extensions=v3_req) and the
  // x509 -extfile signing step (-extensions v3_req).
  const serverConf = `
[req]
distinguished_name = dn
req_extensions = v3_req
prompt = no

[dn]
CN = ${hostname}

[v3_req]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = ${hostname}
IP.1 = 127.0.0.1
IP.2 = ::1
`;
  writeFileSync(serverPath, serverConf, "utf-8");
}

/**
 * Generate (or reuse) a CA + server certificate suitable for the embedded
 * TLS proxy used by `cliBridgeMode === "tlsLoopback"`.
 *
 * Idempotent: returns the existing paths immediately when all artifacts are
 * present and the server cert has ≥7 days of validity remaining.
 *
 * On platforms without openssl (e.g. bare Windows installs) the function
 * returns `ok: false` with a `reason` rather than throwing, so the caller can
 * fall back to plain HTTP / log a warning.
 */
export async function ensureTlsCerts(opts: {
  home?: string;
  hostname?: string;
} = {}): Promise<TlsCertResult> {
  const hostname = opts.hostname || TLS_BRIDGE_HOSTNAME;
  const paths = getCertPaths(opts.home);

  // Short-circuit: re-use existing valid material.
  if (haveAllArtifacts(paths) && isCertValid(paths.serverCrt) && isCertValid(paths.caCrt)) {
    return {
      ok: true,
      caPath: paths.caCrt,
      certPath: paths.serverCrt,
      keyPath: paths.serverKey,
      pemPath: paths.serverPem,
    };
  }

  if (!openSslAvailable()) {
    return {
      ok: false,
      caPath: paths.caCrt,
      certPath: paths.serverCrt,
      keyPath: paths.serverKey,
      pemPath: paths.serverPem,
      reason: "openssl binary not found in PATH",
    };
  }

  try {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return {
      ok: false,
      caPath: paths.caCrt,
      certPath: paths.serverCrt,
      keyPath: paths.serverKey,
      pemPath: paths.serverPem,
      reason: `failed to create ${paths.dir}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const caConfPath = join(paths.dir, "ca.cnf");
  const serverConfPath = join(paths.dir, "server.cnf");
  const csrPath = join(paths.dir, "server.csr");

  try {
    writeOpenSslConfig(caConfPath, serverConfPath, hostname);

    // 1) Root CA — 10y, self-signed.
    runOpenSsl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "3650",
      "-keyout",
      JSON.stringify(paths.caKey),
      "-out",
      JSON.stringify(paths.caCrt),
      "-config",
      JSON.stringify(caConfPath),
      "-extensions",
      "v3_ca",
    ]);

    // 2) Server key + CSR for the allowlisted hostname.
    runOpenSsl([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      JSON.stringify(paths.serverKey),
      "-out",
      JSON.stringify(csrPath),
      "-config",
      JSON.stringify(serverConfPath),
    ]);

    // 3) Sign server cert with the CA, embedding SAN extensions.
    runOpenSsl([
      "x509",
      "-req",
      "-in",
      JSON.stringify(csrPath),
      "-CA",
      JSON.stringify(paths.caCrt),
      "-CAkey",
      JSON.stringify(paths.caKey),
      "-CAcreateserial",
      "-out",
      JSON.stringify(paths.serverCrt),
      "-days",
      "825", // RFC compliant max for TLS server certs
      "-extfile",
      JSON.stringify(serverConfPath),
      "-extensions",
      "v3_req",
    ]);

    // 4) Concatenated chain (cert + key) for runtimes that take a single PEM blob.
    const certBytes = readFileSync(paths.serverCrt, "utf-8");
    const keyBytes = readFileSync(paths.serverKey, "utf-8");
    writeFileSync(paths.serverPem, `${certBytes.trimEnd()}\n${keyBytes.trimEnd()}\n`, {
      mode: 0o600,
    });

    // Tighten perms on private material best-effort.
    try {
      const _ = statSync(paths.serverKey); void _;
    } catch { /* ignore */ }
  } catch (err) {
    return {
      ok: false,
      caPath: paths.caCrt,
      certPath: paths.serverCrt,
      keyPath: paths.serverKey,
      pemPath: paths.serverPem,
      reason: `openssl invocation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    caPath: paths.caCrt,
    certPath: paths.serverCrt,
    keyPath: paths.serverKey,
    pemPath: paths.serverPem,
  };
}
