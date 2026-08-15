import { useState } from "react";
import { api } from "../api";
import { Card, useApi, Btn, Field, Input, TextArea, Select, Modal, Form, ErrorBox, Empty } from "../ui";

type Kind = "mcps" | "repos" | "environments" | "secrets";

const TITLES: Record<Kind, string> = {
  mcps: "MCP connections",
  repos: "Repos",
  environments: "Environments",
  secrets: "Secrets",
};

export function InfraPage({ kind, projectId }: { kind: Kind; projectId: string }) {
  const mcps = useApi(() => (projectId ? api.mcps(projectId) : Promise.resolve([])), [projectId, kind === "mcps"]);
  const repos = useApi(() => (projectId ? api.repos(projectId) : Promise.resolve([])), [projectId, kind === "repos"]);
  const environments = useApi(() => (projectId ? api.environments(projectId) : Promise.resolve([])), [projectId, kind === "environments"]);
  const secrets = useApi(() => (projectId ? api.secrets(projectId) : Promise.resolve([])), [projectId, kind === "secrets"]);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="page">
      <h1>{TITLES[kind]}</h1>
      <Card actions={<Btn onClick={() => setShowCreate(true)}>New</Btn>}>
        {kind === "mcps" && (
          <table className="table">
            <thead><tr><th>Name</th><th>Provider</th><th>URL</th><th>Credential ref</th></tr></thead>
            <tbody>
              {(mcps.data ?? []).map((m) => (
                <tr key={m.id}><td><strong>{m.name}</strong></td><td>{String(m.config.provider ?? "")}</td><td className="mono small">{String(m.config.url ?? "")}</td><td>{m.credentialSecretId ?? "—"}</td></tr>
              ))}
              {(mcps.data ?? []).length === 0 && <tr><td colSpan={4}><Empty>No MCP connections.</Empty></td></tr>}
            </tbody>
          </table>
        )}
        {kind === "repos" && (
          <table className="table">
            <thead><tr><th>Name</th><th>Remote</th><th>Mount</th><th>Branch</th></tr></thead>
            <tbody>
              {(repos.data ?? []).map((r) => (
                <tr key={r.id}><td><strong>{r.name}</strong></td><td className="mono small">{r.remoteUrl}</td><td className="mono small">{r.mountPath}</td><td>{r.defaultBranch}</td></tr>
              ))}
              {(repos.data ?? []).length === 0 && <tr><td colSpan={4}><Empty>No repos.</Empty></td></tr>}
            </tbody>
          </table>
        )}
        {kind === "environments" && (
          <table className="table">
            <thead><tr><th>Name</th><th>Networking</th><th>Allowed hosts</th><th>Env secrets</th></tr></thead>
            <tbody>
              {(environments.data ?? []).map((e) => (
                <tr key={e.id}>
                  <td><strong>{e.name}</strong></td>
                  <td>{e.networking === "limited" ? "limited" : "open"}</td>
                  <td className="mono small">{e.allowedHosts.join(", ") || "—"}</td>
                  <td className="mono small">{e.envNames.join(", ") || "—"}</td>
                </tr>
              ))}
              {(environments.data ?? []).length === 0 && <tr><td colSpan={4}><Empty>No environments.</Empty></td></tr>}
            </tbody>
          </table>
        )}
        {kind === "secrets" && (
          <table className="table">
            <thead><tr><th>Name</th><th>Purpose</th><th>Provider ref</th></tr></thead>
            <tbody>
              {(secrets.data ?? []).map((s) => (
                <tr key={s.id}><td><strong>{s.name}</strong></td><td>{s.purpose}</td><td className="mono small">{s.providerRef}</td></tr>
              ))}
              {(secrets.data ?? []).length === 0 && <tr><td colSpan={3}><Empty>No secrets. Values are encrypted at rest (never stored raw).</Empty></td></tr>}
            </tbody>
          </table>
        )}
      </Card>
      {showCreate && <CreateForm kind={kind} projectId={projectId} onClose={() => setShowCreate(false)} onCreated={() => setShowCreate(false)} />}
    </div>
  );
}

function CreateForm({ kind, projectId, onClose, onCreated }: { kind: Kind; projectId: string; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [extra, setExtra] = useState("");
  const [error, setError] = useState<string | null>(null);
  const labels: Record<Kind, { name: string; extra: string }> = {
    mcps: { name: "Name (e.g. front)", extra: "Provider (JSON, e.g. {\"provider\":\"front\",\"url\":\"https://api.front.com\"})" },
    repos: { name: "Name", extra: "remoteUrl | mountPath | defaultBranch" },
    environments: { name: "Name", extra: "networking (open|limited), allowed hosts (comma), envNames (comma)" },
    secrets: { name: "Name", extra: "purpose (mcp|repo|env|webhook) | value" },
  };
  return (
    <Modal title={`New ${kind.slice(0, -1)}`} onClose={onClose}>
      <Form onSubmit={async () => {
        try {
          if (kind === "mcps") {
            let config: Record<string, unknown> = {};
            try { config = extra ? JSON.parse(extra) : {}; } catch { throw new Error("provider must be valid JSON"); }
            await api.createMcp(projectId, { name, config });
          } else if (kind === "repos") {
            const [remoteUrl, mountPath, defaultBranch] = extra.split("|").map((s) => s.trim());
            if (!remoteUrl || !mountPath) throw new Error("need remoteUrl | mountPath");
            await api.createRepo(projectId, { name, remoteUrl, mountPath, defaultBranch: defaultBranch || "main" });
          } else if (kind === "environments") {
            const [networking, hosts, envNames] = extra.split("|").map((s) => s.trim());
            await api.createEnvironment(projectId, {
              name,
              networking: networking === "open" ? "open" : "limited",
              allowedHosts: hosts ? hosts.split(",").map((s) => s.trim()).filter(Boolean) : [],
              envNames: envNames ? envNames.split(",").map((s) => s.trim()).filter(Boolean) : [],
            });
          } else {
            const [purpose, value] = extra.split("|").map((s) => s.trim());
            await api.createSecret(projectId, {
              name,
              purpose: (purpose as "mcp" | "repo" | "env" | "webhook") ?? "env",
              value: value || undefined,
            });
          }
          onCreated();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }}>
        <Field label={labels[kind].name}><Input value={name} onChange={setName} /></Field>
        <Field label={labels[kind].extra}><TextArea value={extra} onChange={setExtra} rows={3} /></Field>
        <ErrorBox error={error} />
        <Btn kind="primary" type="submit">Create</Btn>
      </Form>
    </Modal>
  );
}
