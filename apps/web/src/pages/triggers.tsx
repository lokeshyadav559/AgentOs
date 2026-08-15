import { useState } from "react";
import { api, type Trigger, type Automation } from "../api";
import { Card, useApi, Btn, Field, Input, TextArea, Select, Modal, Form, ErrorBox, Empty } from "../ui";

export function TriggersPage({ projectId, automations = false }: { projectId: string; automations?: boolean }) {
  const triggers = useApi(() => (projectId ? api.triggers(projectId) : Promise.resolve([])), [projectId, !automations]);
  const automationsData = useApi(() => (projectId ? api.automations(projectId) : Promise.resolve([])), [projectId, automations]);
  const agents = useApi(() => (projectId ? api.agents(projectId) : Promise.resolve([])), [projectId]);
  const [showCreate, setShowCreate] = useState(false);

  if (!projectId) return <div className="page"><h1>{automations ? "Automations" : "Triggers"}</h1><Empty>Select a project.</Empty></div>;

  return (
    <div className="page">
      <h1>{automations ? "Automations" : "Triggers"}</h1>
      <Card actions={<Btn kind="primary" onClick={() => setShowCreate(true)}>{automations ? "New automation" : "New trigger"}</Btn>}>
        {automations ? (
          <table className="table">
            <thead><tr><th>Name</th><th>Cron</th><th>Timezone</th><th>Agent</th><th>Task</th></tr></thead>
            <tbody>
              {(automationsData.data ?? []).map((a) => (
                <tr key={a.id}>
                  <td><strong>{a.name}</strong></td>
                  <td><code>{a.cron}</code></td>
                  <td>{a.timezone}</td>
                  <td>{agents.data?.find((x) => x.id === a.agentId)?.name ?? a.agentId}</td>
                  <td className="small">{a.taskTemplateId ? "template" : (a.taskBody ?? "").slice(0, 40)}</td>
                </tr>
              ))}
              {(automationsData.data ?? []).length === 0 && <tr><td colSpan={5}><Empty>No automations. Cron jobs spawn tasks/agents on schedule (§15).</Empty></td></tr>}
            </tbody>
          </table>
        ) : (
          <table className="table">
            <thead><tr><th>Name</th><th>Agent</th><th>Webhook URL</th><th>Signature</th></tr></thead>
            <tbody>
              {(triggers.data ?? []).map((t) => <TriggerRow key={t.id} t={t} projectId={projectId} onRotated={() => triggers.reload()} agents={agents.data ?? []} />)}
              {(triggers.data ?? []).length === 0 && <tr><td colSpan={4}><Empty>No triggers. POST /hooks/:id with the signature header spawns a scoped job (§14).</Empty></td></tr>}
            </tbody>
          </table>
        )}
      </Card>
      {showCreate && (
        <CreateForm automations={automations} projectId={projectId} agents={agents.data ?? []}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); automations ? automationsData.reload() : triggers.reload(); }} />
      )}
    </div>
  );
}

function TriggerRow({ t, projectId, onRotated, agents }: { t: Trigger; projectId: string; onRotated: () => void; agents: { id: string; name: string }[] }) {
  const [copied, setCopied] = useState(false);
  const hookUrl = `${location.origin}/#/hooks/${t.id}`.replace("/#/", "/");
  const curl = `curl -X POST ${location.origin}/hooks/${t.id} \\\n  -H "content-type: application/json" \\\n  -H "x-agentos-signature: <sha256-hmac of body with secret>" \\\n  -d '{"event":"..."}'`;
  return (
    <tr>
      <td><strong>{t.name}</strong></td>
      <td>{agents.find((a) => a.id === t.agentId)?.name ?? t.agentId}</td>
      <td>
        <code className="small">POST /hooks/{t.id}</code>
        <div className="row">
          <Btn onClick={() => { void navigator.clipboard?.writeText(curl); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "copied" : "copy curl"}</Btn>
          <Btn onClick={async () => { await api.rotateTrigger(projectId, t.id); onRotated(); }}>rotate secret</Btn>
          <Btn onClick={async () => {
            if (!confirm("Start the bug-fix chain (implement → plan → review → fix → E2E → merge)?")) return;
            await api.bugfixChain(projectId, t.id, { branchName: "fix/" + Date.now().toString(36), featureTitle: "Webhook bug" });
            onRotated();
          }}>start fix chain</Btn>
        </div>
      </td>
      <td className="mono small">{t.webhookSecret ? t.webhookSecret.slice(0, 12) + "…" : "—"}</td>
    </tr>
  );
}

function CreateForm({ automations, projectId, agents, onClose, onCreated }: {
  automations: boolean; projectId: string; agents: { id: string; name: string }[]; onClose: () => void; onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [cron, setCron] = useState("0 9 * * 1");
  const [jobPrompt, setJobPrompt] = useState("New inbound event:\n{{payload}}");
  const [taskBody, setTaskBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={automations ? "New automation" : "New trigger"} onClose={onClose}>
      <Form onSubmit={async () => {
        try {
          if (automations) {
            await api.createAutomation(projectId, { name, cron, timezone: "UTC", agentId, taskBody });
          } else {
            await api.createTrigger(projectId, { name, agentId, jobPrompt });
          }
          onCreated();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }}>
        <Field label="Name"><Input value={name} onChange={setName} /></Field>
        <Field label="Agent">
          <Select value={agentId} onChange={setAgentId} options={agents.map((a) => ({ value: a.id, label: a.name }))} />
        </Field>
        {automations ? (
          <>
            <Field label="Cron (m h dom mon dow)"><Input value={cron} onChange={setCron} /></Field>
            <Field label="Task body"><TextArea value={taskBody} onChange={setTaskBody} rows={3} /></Field>
          </>
        ) : (
          <Field label="Job prompt ({{payload}} is the sanitized body)"><TextArea value={jobPrompt} onChange={setJobPrompt} rows={3} /></Field>
        )}
        <ErrorBox error={error} />
        <Btn kind="primary" type="submit">{automations ? "Create automation" : "Create trigger"}</Btn>
      </Form>
    </Modal>
  );
}
