// A stand-in for dist/brain/brain.js in the supervisor tests, run by Node.
// Its behaviour comes from the file FAKE_MODE in BRAIN_WIKI_DIR (the
// supervisor passes only BRAIN_* variables to the child):
//   ok        listen, print the ready line, answer /healthz 200
//   unhealthy listen, print the ready line, answer /healthz 500
//   crash     print an error on stderr, exit 1
//   crash-once  crash the first time (leaves a CRASHED marker), then ok
//   protocol  print a BRAIN_PROTOCOL mismatch on stderr, exit 2
//   hang      never print the ready line
// It also prints one line with the env it received (names only for keys).
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = (() => {
  try {
    return readFileSync(join(process.env.BRAIN_WIKI_DIR ?? "", "FAKE_MODE"), "utf8").trim();
  } catch {
    return "ok";
  }
})();

const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("BRAIN_")) env[k] = /KEY/.test(k) ? `<${v.length} chars>` : v;
}
process.stdout.write(`${JSON.stringify({ fake_env: env, argv: process.argv.slice(2) })}\n`);

const marker = join(process.env.BRAIN_WIKI_DIR ?? "", "CRASHED");
if (mode === "crash" || (mode === "crash-once" && !existsSync(marker))) {
  if (mode === "crash-once") writeFileSync(marker, "1");
  process.stderr.write("brain: something broke at startup\n");
  process.exit(1);
}
if (mode === "protocol") {
  process.stderr.write("brain: BRAIN_PROTOCOL mismatch: Companion expects protocol 1, this brain bundle speaks 2\n");
  process.exit(2);
}
if (mode === "hang") {
  setInterval(() => {}, 1000);
} else {
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(mode === "unhealthy" ? 500 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: mode === "unhealthy" ? "broken" : "ok", content_hash: "fake", inbox: { pending: 2 } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, "127.0.0.1", () => {
    process.stdout.write("not json, an ordinary log line\n");
    process.stdout.write(`${JSON.stringify({ brain_ready: true, port: server.address().port, protocol: 1 })}\n`);
  });
  process.on("SIGTERM", () => {
    server.close();
    process.exit(0);
  });
}
if (process.env.BRAIN_EXIT_WITH_PARENT === "1") {
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
}
