// Structured audit log, one JSON line per event on stdout (Companion copies the
// child's stdout into brains/<slug>/logs/brain.log; under systemd, journald
// collects it). Content is never logged: only ids, rule names and outcomes.

export interface AuditEvent {
  event: string;
  tool?: string;
  author?: string;
  mcp_session_id?: string;
  client?: string;
  ok?: boolean;
  ids?: string[];
  rules?: string[];
  errors?: number;
  ms?: number;
  detail?: string;
}

export type AuditSink = (e: AuditEvent & { ts: string; service: string }) => void;

export function stdoutSink(): AuditSink {
  return (e) => process.stdout.write(JSON.stringify(e) + "\n");
}

export class Audit {
  private sink: AuditSink;
  private now: () => Date;
  private service: string;
  constructor(sink: AuditSink = stdoutSink(), now: () => Date = () => new Date(), service = "brain") {
    this.sink = sink;
    this.now = now;
    this.service = service;
  }
  log(e: AuditEvent): void {
    this.sink({ ts: this.now().toISOString(), service: this.service, ...e });
  }
}
