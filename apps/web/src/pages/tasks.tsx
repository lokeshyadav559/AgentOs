import { useState } from "react";
import { api, type Task, type TaskStatus, type Agent, type TaskTemplate } from "../api";
import { Card, useApi, Btn, Field, Input, TextArea, Select, Modal, Form, ErrorBox, Empty, Badge, relativeTime, shortId } from "../ui";

const COLUMNS: { key: TaskStatus; label: string }[] = [
  { key: "todo", label: "To do" },
  { key: "doing", label: "Doing" },
  { key: "review", label: "Review" },
  { key: "done", label: "Done" },
];

export function TasksPage({ projectId }: { projectId: string }) {
  const tasks = useApi(() => (projectId ? api.tasks(projectId) : Promise.resolve([])), [projectId]);
  const agents = useApi(() => (projectId ? api.agents(projectId) : Promise.resolve([])), [projectId]);
  const templates = useApi(() => (projectId ? api.templates(projectId) : Promise.resolve([])), [projectId]);
  const [showCreate, setShowCreate] = useState(false);
  const [detail, setDetail] = useState<Task | null>(null);

  if (!projectId) return <div className="page"><h1>Tasks</h1><Empty>Select a project.</Empty></div>;

  return (
    <div className="page">
      <h1>Tasks</h1>
      <div className="row">
        <Btn kind="primary" onClick={() => setShowCreate(true)}>New task</Btn>
        <Btn onClick={() => tasks.reload()}>Refresh</Btn>
      </div>
      <div className="kanban">
        {COLUMNS.map((col) => {
          const items = (tasks.data ?? []).filter((t) => t.status === col.key);
          return (
            <div className="kanban-col" key={col.key}>
              <div className="kanban-head">
                {col.label} <Badge tone="info">{items.length}</Badge>
              </div>
              {items.map((t) => (
                <div key={t.id} className="kanban-card" onClick={() => setDetail(t)}>
                  <strong>{t.name}</strong>
                  {t.approvalGate && <Badge tone="warn">gate</Badge>}
                  {t.chainIndex !== null && <span className="muted small">step {t.chainIndex! + 1}</span>}
                  <div className="muted small">{t.description.slice(0, 80)}</div>
                  <div className="muted small">{t.activity.length} activity · {t.sessionIds.length} sessions</div>
                </div>
              ))}
              {items.length === 0 && <div className="kanban-empty">—</div>}
            </div>
          );
        })}
      </div>
      {showCreate && (
        <TaskCreate projectId={projectId} agents={agents.data ?? []} templates={templates.data ?? []}
          onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); tasks.reload(); }} />
      )}
      {detail && (
        <TaskDetail projectId={projectId} task={detail} agents={agents.data ?? []}
          onClose={() => setDetail(null)} onChanged={async () => {
            const t = await api.task(projectId, detail.id);
            setDetail(t);
            tasks.reload();
          }} />
      )}
    </div>
  );
}

function TaskCreate({ projectId, agents, templates, onClose, onCreated }: {
  projectId: string; agents: Agent[]; templates: TaskTemplate[]; onClose: () => void; onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [gate, setGate] = useState(false);
  const [schedule, setSchedule] = useState<"now" | "at" | "cron">("now");
  const [runAt, setRunAt] = useState("");
  const [cron, setCron] = useState("0 9 * * 1");
  const [templateId, setTemplateId] = useState("");
  const [branch, setBranch] = useState("agentos");
  const [feature, setFeature] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal title="New task" onClose={onClose}>
      <Form onSubmit={async () => {
        try {
          const body: Record<string, unknown> = {
            name, description,
            assigneeAgentId: agentId || null,
            approvalGate: gate,
            scheduleKind: schedule,
            runAt: schedule === "at" ? new Date(runAt).toISOString() : null,
            cron: schedule === "cron" ? cron : null,
            timezone: schedule === "cron" ? "UTC" : null,
          };
          if (templateId) {
            body.templateId = templateId;
            body.variables = { branchName: branch, featureTitle: feature || name };
          }
          await api.createTask(projectId, body);
          onCreated();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }}>
        <Field label="Name"><Input value={name} onChange={setName} /></Field>
        <Field label="Description"><TextArea value={description} onChange={setDescription} rows={3} /></Field>
        <Field label="Agent">
          <Select value={agentId} onChange={setAgentId} options={agents.map((a) => ({ value: a.id, label: a.name }))} />
        </Field>
        <label className="checkbox"><input type="checkbox" checked={gate} onChange={(e) => setGate(e.target.checked)} /> approval gate (only the human can mark done)</label>
        <Field label="Run">
          <Select value={schedule} onChange={setSchedule} options={[
            { value: "now", label: "immediately" }, { value: "at", label: "at a time" }, { value: "cron", label: "recurring (cron)" },
          ]} />
        </Field>
        {schedule === "at" && <Field label="Run at"><Input value={runAt} onChange={setRunAt} type="datetime-local" /></Field>}
        {schedule === "cron" && <Field label="Cron (m h dom mon dow)"><Input value={cron} onChange={setCron} /></Field>}
        {templates.length > 0 && (
          <Field label="Start from template">
            <Select value={templateId} onChange={setTemplateId} options={[
              { value: "", label: "— no template —" },
              ...templates.map((t) => ({ value: t.id, label: t.name })),
            ]} />
          </Field>
        )}
        {templateId && (
          <>
            <Field label="Branch name"><Input value={branch} onChange={setBranch} /></Field>
            <Field label="Feature title"><Input value={feature} onChange={setFeature} /></Field>
          </>
        )}
        <ErrorBox error={error} />
        <Btn kind="primary" type="submit">Create</Btn>
      </Form>
    </Modal>
  );
}

function TaskDetail({ projectId, task, agents, onClose, onChanged }: {
  projectId: string; task: Task; agents: Agent[]; onClose: () => void; onChanged: () => void;
}) {
  const agent = agents.find((a) => a.id === task.assigneeAgentId);
  const [error, setError] = useState<string | null>(null);
  const move = async (status: TaskStatus) => {
    try {
      await api.setTaskStatus(projectId, task.id, status);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const run = async () => {
    try {
      await api.runTask(projectId, task.id);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Modal title={task.name} onClose={onClose}>
      <div className="task-detail">
        <p className="muted small">{task.id} · assigned to {agent?.name ?? "human"} · created {relativeTime(task.createdAt)}</p>
        {task.approvalGate && <Badge tone="warn">Approval gate — only the human can mark this done</Badge>}
        <p>{task.description}</p>
        {task.attachmentIds.length > 0 && <p className="small">attachments: {task.attachmentIds.length}</p>}
        <div className="row">
          {(["todo", "doing", "review", "done"] as TaskStatus[]).map((s) => (
            <Btn key={s} kind={s === task.status ? "primary" : "ghost"} disabled={s === task.status} onClick={() => void move(s)}>{s}</Btn>
          ))}
          {task.assigneeType === "agent" && task.status === "todo" && <Btn onClick={() => void run()}>Run now</Btn>}
        </div>
        <ErrorBox error={error} />
        <h4>Activity</h4>
        <ul className="feed">
          {task.activity.map((a, i) => (
            <li key={i}><div><strong>{a.actor}</strong> · {relativeTime(a.at)}</div><div>{a.message}</div></li>
          ))}
          {task.activity.length === 0 && <li className="muted">no activity yet</li>}
        </ul>
        <h4>Sessions</h4>
        <p className="mono small">{task.sessionIds.map((s) => shortId(s)).join(", ") || "—"}</p>
      </div>
    </Modal>
  );
}
