import { useEffect, useState, useCallback, type ReactNode, type FormEvent } from "react";

/** Tiny data-fetching hook. */
export function useApi<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fn());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload };
}

export function Card({ title, children, actions }: { title?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="card">
      {(title || actions) && (
        <div className="card-head">
          <h3>{title}</h3>
          <div className="card-actions">{actions}</div>
        </div>
      )}
      {children}
    </div>
  );
}

export function Btn(props: { onClick?: () => void; children: ReactNode; kind?: "primary" | "ghost" | "danger"; disabled?: boolean; type?: "submit" | "button" }) {
  return (
    <button className={`btn ${props.kind ?? ""}`} onClick={props.onClick} disabled={props.disabled} type={props.type ?? "button"}>
      {props.children}
    </button>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Input(props: { value?: string; onChange?: (v: string) => void; placeholder?: string; type?: string; list?: string }) {
  return (
    <input
      className="input"
      value={props.value ?? ""}
      placeholder={props.placeholder}
      type={props.type ?? "text"}
      list={props.list}
      onChange={(e) => props.onChange?.(e.target.value)}
    />
  );
}

export function TextArea(props: { value?: string; onChange?: (v: string) => void; rows?: number; placeholder?: string }) {
  return (
    <textarea
      className="input textarea"
      value={props.value ?? ""}
      rows={props.rows ?? 4}
      placeholder={props.placeholder}
      onChange={(e) => props.onChange?.(e.target.value)}
    />
  );
}

export function Select<T extends string>(props: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <select className="input" value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: "ok" | "warn" | "bad" | "info" }) {
  return <span className={`badge ${tone ?? ""}`}>{children}</span>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn ghost" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Form({ onSubmit, children }: { onSubmit: (e: FormEvent) => void; children: ReactNode }) {
  return <form className="form" onSubmit={(e) => { e.preventDefault(); onSubmit(e); }}>{children}</form>;
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="error-box">{error}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Format a JSON value for display in tool logs / activity. */
export function pretty(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v.length > 500 ? v.slice(0, 500) + "…" : v;
  try {
    const s = JSON.stringify(v, null, 1);
    return s.length > 1200 ? s.slice(0, 1200) + "…" : s;
  } catch {
    return String(v);
  }
}
