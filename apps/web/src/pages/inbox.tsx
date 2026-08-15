import { useEffect, useState } from "react";
import { api, type InboxMessage } from "../api";
import { Card, Btn, ErrorBox, Empty, relativeTime, shortId } from "../ui";

export function InboxPage() {
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pushState, setPushState] = useState<"unknown" | "on" | "off" | "unsupported">("unknown");

  const load = async () => {
    try {
      setMessages(await api.inbox());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, []);

  // Web Push (PWA) — §12: push when something is done or needs help.
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setPushState("unsupported");
      return;
    }
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setPushState(sub ? "on" : "off"))
      .catch(() => setPushState("off"));
  }, []);

  const enablePush = async () => {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return;
      const vapid = await api.pushVapid();
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid.publicKey) as unknown as BufferSource,
      });
      await api.subscribePush(sub.endpoint, {
        p256dh: btoa(String.fromCharCode(...new Uint8Array(sub.getKey("p256dh")!))),
        auth: btoa(String.fromCharCode(...new Uint8Array(sub.getKey("auth")!))),
      });
      setPushState("on");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const disablePush = async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api.unsubscribePush(sub.endpoint);
        await sub.unsubscribe();
      }
      setPushState("off");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const open = messages.filter((m) => m.status === "open");
  const rest = messages.filter((m) => m.status !== "open");

  return (
    <div className="page">
      <h1>Inbox</h1>
      <div className="row">
        {pushState === "off" && <Btn onClick={() => void enablePush()}>Enable push notifications</Btn>}
        {pushState === "on" && <Btn onClick={() => void disablePush()}>Disable push</Btn>}
        {pushState === "unsupported" && <span className="muted small">push not supported in this browser</span>}
      </div>
      <ErrorBox error={error} />
      <Card title={`Needs you (${open.length})`}>
        {open.length === 0 && <Empty>Nothing needs you right now.</Empty>}
        {open.map((m) => <MessageCard key={m.id} msg={m} onAnswered={load} />)}
      </Card>
      <Card title="History">
        {rest.length === 0 && <Empty>No messages yet.</Empty>}
        {rest.map((m) => (
          <div key={m.id} className="inbox-message">
            <div className="inbox-meta"><strong>{m.from === "agent" ? m.agentId ?? "agent" : "you"}</strong> · {relativeTime(m.createdAt)} · {m.status}</div>
            <div>{m.body}</div>
            {m.kind === "multiple-choice" && m.selectedChoiceId && (
              <div className="muted small">answered: {m.choices.find((c) => c.id === m.selectedChoiceId)?.label ?? m.selectedChoiceId}</div>
            )}
            {m.sessionId && <div className="muted small">session {shortId(m.sessionId)}</div>}
          </div>
        ))}
      </Card>
    </div>
  );
}

function MessageCard({ msg, onAnswered }: { msg: InboxMessage; onAnswered: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reply = async (body: { body?: string; selectedChoiceId?: string }) => {
    setBusy(true);
    try {
      await api.reply(msg.id, body);
      onAnswered();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="inbox-message open">
      <div className="inbox-meta">
        <strong>{msg.agentId ?? "agent"}</strong> · {relativeTime(msg.createdAt)}
        {msg.taskId && <span className="muted"> · task {shortId(msg.taskId)}</span>}
      </div>
      <div>{msg.body}</div>
      {msg.kind === "multiple-choice" ? (
        <div className="row">
          {msg.choices.map((c) => (
            <Btn key={c.id} kind="primary" disabled={busy} onClick={() => void reply({ selectedChoiceId: c.id })}>
              {c.label}
            </Btn>
          ))}
        </div>
      ) : (
        <div className="row">
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="reply…" />
          <Btn kind="primary" disabled={busy || !text.trim()} onClick={() => { void reply({ body: text }); setText(""); }}>Send</Btn>
        </div>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
