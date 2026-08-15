import { useState } from "react";
import { api, type Agent } from "../api";
import { Card, useApi, Badge, Btn, Field, Input, TextArea, Select, Modal, Form, ErrorBox, Empty, shortId } from "../ui";

export function AgentsPage({ projectId }: { projectId: string }) {
  const agents = useApi(() => (projectId ? api.agents(projectId) : Promise.resolve([])), [projectId]);
  const [selected, setSelected] = useState<Agent | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="page">
      <h1>Agents</h1>
      <Card actions={<Btn onClick={() => setShowCreate(true)}>New agent</Btn>}>
        {agents.data?.length === 0 && <Empty>No agents.</Empty>}
        <table className="table">
          <thead><tr><th>Name</th><th>Title</th><th>Model</th><th>Runner</th><th>MCPs</th><th>Repos</th><th>Inbox</th></tr></thead>
          <tbody>
            {agents.data?.map((a) => (
              <tr key={a.id} onClick={() => setSelected(a)} className="clickable">
                <td><strong>{a.name}</strong></td>
                <td>{a.title}</td>
                <td>{a.model}</td>
                <td><Badge tone={a.runnerPreference === "local" ? "info" : a.runnerPreference === "cloud" ? "ok" : undefined}>{a.runnerPreference}</Badge></td>
                <td>{a.mcpConnectionIds.length}</td>
                <td>{a.repoAccess.length}</td>
                <td>{a.inboxAccess ? "✓" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {selected && <AgentDetail projectId={projectId} agent={selected} onClose={() => setSelected(null)} onSaved={() => agents.reload()} />}
      {showCreate && (
        <AgentCreate projectId={projectId} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); agents.reload(); }} />
      )}
    </div>
  );
}

function AgentDetail({ projectId, agent, onClose, onSaved }: { projectId: string; agent: Agent; onClose: () => void; onSaved: () => void }) {
  const [model, setModel] = useState(agent.model);
  const [runner, setRunner] = useState<Agent["runnerPreference"]>(agent.runnerPreference);
  const [inbox, setInbox] = useState(agent.inboxAccess);
  const [rolePrompt, setRolePrompt] = useState(agent.rolePrompt);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal title={`Agent: ${agent.name}`} onClose={onClose}>
      <div className="agent-detail">
        <p className="muted">{agent.title} · {agent.id}</p>
        <h4>Role prompt</h4>
        <p className="mono pre small">{agent.rolePrompt.slice(0, 400)}{agent.rolePrompt.length > 400 ? "…" : ""}</p>
        <h4>Filesystem grants</h4>
        <ul className="mono small">
          {agent.filesystemGrants.map((g) => (
            <li key={g.folderPath}>{g.folderPath} — read={String(g.canRead)} write={String(g.canWrite)} delete={String(g.canDelete)}</li>
          ))}
        </ul>
        <h4>Repo access</h4>
        <ul className="mono small">
          {agent.repoAccess.map((r) => <li key={r.repoId}>{r.mountPath} ({r.permissions})</li>)}
          {agent.repoAccess.length === 0 && <li className="muted">none</li>}
        </ul>
        <h4>Collaboration list</h4>
        <p className="small">{agent.collaborationList.join(", ") || "—"}</p>
        <h4>Skills</h4>
        <p className="small">{agent.skillIds.length} attached · mcp ids: {shortId(agent.mcpConnectionIds.join(",")) || "—"}</p>
        <hr />
        <Form onSubmit={async () => {
          try {
            await api.updateAgent(projectId, agent.name, { model, runnerPreference: runner, inboxAccess: inbox, rolePrompt });
            onSaved();
            onClose();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}>
          <Field label="Model"><Input value={model} onChange={setModel} list="model-options" /></Field>
          <datalist id="model-options">
            <option value="claude-opus-4" />
            <option value="deepseek-chat" />
            <option value="deepseek-reasoner" />
          </datalist>
          <Field label="Runner preference">
            <Select value={runner} onChange={setRunner} options={[
              { value: "inherit", label: "inherit" }, { value: "cloud", label: "cloud" }, { value: "local", label: "local" },
            ]} />
          </Field>
          <label className="checkbox"><input type="checkbox" checked={inbox} onChange={(e) => setInbox(e.target.checked)} /> inbox access</label>
          <Field label="Role prompt (reconstructed — edit at your own risk)">
            <TextArea value={rolePrompt} onChange={setRolePrompt} rows={8} />
          </Field>
          <ErrorBox error={error} />
          <Btn kind="primary" type="submit">Save</Btn>
        </Form>
      </div>
    </Modal>
  );
}

function AgentCreate({ projectId, onClose, onCreated }: { projectId: string; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [model, setModel] = useState("claude-opus-4");
  const [rolePrompt, setRolePrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="New agent" onClose={onClose}>
      <Form onSubmit={async () => {
        try {
          await api.createAgent(projectId, { name, title: title || name, model, rolePrompt });
          onCreated();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }}>
        <Field label="Name (slug)"><Input value={name} onChange={setName} placeholder="senior-dev" /></Field>
        <Field label="Title"><Input value={title} onChange={setTitle} /></Field>
        <Field label="Model"><Input value={model} onChange={setModel} list="model-options" /></Field>
        <Field label="Role prompt"><TextArea value={rolePrompt} onChange={setRolePrompt} rows={6} /></Field>
        <ErrorBox error={error} />
        <Btn kind="primary" type="submit">Create</Btn>
      </Form>
    </Modal>
  );
}
