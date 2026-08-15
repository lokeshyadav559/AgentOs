import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Session, type ToolCallLogEntry } from "../api";
import { Card, useApi, Btn, Badge, Empty, relativeTime, pretty, shortId } from "../ui";

export function SessionsPage({ projectId }: { projectId: string }) {
  const sessions = useApi(() => api.sessions(projectId || undefined), [projectId]);
  return (
    <div className="page">
      <h1>Sessions</h1>
      <Card actions={<Btn onClick={() => sessions.reload()}>Refresh</Btn>}>
        <table className="table">
          <thead><tr><th>Session</th><th>Agent</th><th>Runner</th><th>Status</th><th>Tool calls</th><th>Cost</th><th>Started</th></tr></thead>
          <tbody>
            {(sessions.data ?? []).map((s) => (
              <tr key={s.id} className="clickable">
                <td><Link to={`/sessions/${s.id}`}>{shortId(s.id)}</Link></td>
                <td>{s.agentId.slice(0, 8)}</td>
                <td>{s.runner}</td>
                <td><SessionBadge status={s.status} /></td>
                <td>{s.toolCallLog.length}</td>
                <td>{s.costUsd !== null ? `$${s.costUsd}` : "—"}</td>
                <td>{relativeTime(s.startedAt)}</td>
              </tr>
            ))}
            {(sessions.data ?? []).length === 0 && <tr><td colSpan={7}><Empty>No sessions yet.</Empty></td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function SessionBadge({ status }: { status: Session["status"] }) {
  const tone = status === "running" || status === "starting" ? "info" : status === "destroyed" ? "ok" : status === "failed" ? "bad" : status === "waiting-inbox" ? "warn" : undefined;
  return <Badge tone={tone as "info" | "ok" | "bad" | "warn" | undefined}>{status}</Badge>;
}

export function SessionViewerPage() {
  const id = location.hash.split("/").pop() ?? "";
  const session = useApi(() => api.session(id), [id]);
  const [liveCalls, setLiveCalls] = useState<ToolCallLogEntry[]>([]);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const liveRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = api.sessionLive(id);
    es.addEventListener("tool_call", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as ToolCallLogEntry;
      setLiveCalls((prev) => [...prev.slice(-499), data]);
    });
    es.addEventListener("status", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { status?: string };
      setLiveStatus(data.status ?? null);
    });
    liveRef.current = es;
    return () => es.close();
  }, [id]);

  const allCalls = [...(session.data?.toolCallLog ?? []), ...liveCalls].filter(
    (c, i, arr) => arr.findIndex((x) => x.ts === c.ts && x.name === c.name) === i,
  );

  return (
    <div className="page">
      <h1>Session {shortId(id)}</h1>
      <Card title="Live session viewer (§13)">
        {session.data && (
          <p className="small muted">
            status: <SessionBadge status={(liveStatus as Session["status"]) ?? session.data.status} /> · runner {session.data.runner} ·{" "}
            {session.data.costUsd !== null && `cost $${session.data.costUsd} · `}
            commits: {session.data.commitShas.length} · summary: {session.data.summary ?? "—"}
          </p>
        )}
        {allCalls.length === 0 && <Empty>No tool calls yet — watching live…</Empty>}
        <div className="tool-log">
          {allCalls.map((c, i) => (
            <details key={i} className="tool-call" open={c.error !== null && c.error !== undefined}>
              <summary>
                <span className={`tool-name ${c.error ? "err" : ""}`}>{c.name}</span>
                {c.error && <span className="tool-error">✗ {c.error}</span>}
              </summary>
              <div className="mono pre small">
                <div className="muted">in:</div>
                {pretty(c.input)}
                {c.output !== undefined && c.output !== null && (
                  <>
                    <div className="muted">out:</div>
                    {pretty(c.output)}
                  </>
                )}
              </div>
            </details>
          ))}
        </div>
      </Card>
    </div>
  );
}
