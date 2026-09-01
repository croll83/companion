import { describe, it, expect } from "vitest";
import { establishedExternalInodes } from "./cli-liveness.js";

// /proc/net/tcp columns: sl local_address rem_address st ... inode ...
// st 01 = ESTABLISHED. rem_address is "IP:PORT" little-endian hex.
const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
function row(rem: string, st: string, inode: string) {
  return `   0: 0100007F:0CEA ${rem} ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000 0`;
}

describe("establishedExternalInodes", () => {
  it("keeps ESTABLISHED connections to a real remote host", () => {
    // 160.79.104.10 -> little-endian hex 0A684FA0 ; port 443 = 01BB
    const s = [HEADER, row("0A684FA0:01BB", "01", "131230317")].join("\n");
    expect(establishedExternalInodes(s).has("131230317")).toBe(true);
  });
  it("drops loopback remotes (local MCP / companion WS)", () => {
    const s = [HEADER, row("0100007F:0D80", "01", "999")].join("\n");
    expect(establishedExternalInodes(s).has("999")).toBe(false);
  });
  it("drops non-ESTABLISHED sockets (listen/time-wait)", () => {
    const s = [HEADER, row("0A684FA0:01BB", "0A", "888"), row("0A684FA0:01BB", "06", "777")].join("\n");
    const r = establishedExternalInodes(s);
    expect(r.has("888")).toBe(false);
    expect(r.has("777")).toBe(false);
  });
  it("drops all-zero remote (unconnected)", () => {
    const s = [HEADER, row("00000000:0000", "01", "555")].join("\n");
    expect(establishedExternalInodes(s).has("555")).toBe(false);
  });
  it("handles empty / header-only input", () => {
    expect(establishedExternalInodes("").size).toBe(0);
    expect(establishedExternalInodes(HEADER).size).toBe(0);
  });
});
