import { useState } from "react";
import { api, type Goal } from "../api";
import { Card, useApi, Btn, Field, Input, TextArea, Select, Modal, Form, ErrorBox, Empty, Badge, relativeTime } from "../ui";

export function GoalsPage({ projectId }: { projectId: string }) {
  const goals = useApi(() => (projectId ? api.goals(projectId) : Promise.resolve([])), [projectId]);
  const [showCreate, setShowCreate] = useState(false);
  const [detail, setDetail] = useState<Goal | null>(null);

  return (
    <div className="page">
      <h1>Goals</h1>
      <Card actions={<Btn kind="primary" onClick={() => setShowCreate(true)}>New goal</Btn>}>
        {goals.data?.length === 0 && <Empty>No goals. A goal runs the gauntlet loop: orchestrator keeps spawning specialists until the DoD is checked or a rail trips.</Empty>}
        <table className="table">
          <thead><tr><th>Title</th><th>Status</th><th>DoD</th><th>Spend</th><th>Runner</th><th>Sessions</th></tr></thead>
          <tbody>
            {goals.data?.map((g) => (
              <tr key={g.id} className="clickable" onClick={() => setDetail(g)}>
                <td><strong>{g.title}</strong></td>
                <td><GoalBadge status={g.status} /></td>
                <td>{g.definitionOfDone.filter((d) => d.done).length}/{g.definitionOfDone.length}</td>
                <td>{g.spendCapUsd === null ? "uncapped" : `$${g.spendUsd}/$${g.spendCapUsd}`}</td>
                <td>{g.runnerPreference}</td>
                <td>{g.sessionIds.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {showCreate && <GoalCreate projectId={projectId} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); goals.reload(); }} />}
      {detail && <GoalDetail projectId={projectId} goal={detail} onClose={() => setDetail(null)} onChanged={async () => { setDetail(await api.goal(projectId, detail.id)); goals.reload(); }} />}
    </div>
  );
}

export function GoalBadge({ status }: { status: Goal["status"] }) {
  const tone = status === "completed" ? "ok" : status === "active" ? "info" : status.startsWith("stopped") ? "bad" : "warn";
  return <Badge tone={tone as "ok" | "info" | "bad" | "warn"}>{status}</Badge>;
}

function GoalCreate({ projectId, onClose, onCreated }: { projectId: string; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState("");
  const [dod, setDod] = useState("");
  const [cap, setCap] = useState("10");
  const [confirmNoCap, setConfirmNoCap] = useState(false);
  const [maxMin, setMaxMin] = useState("");
  const [runner, setRunner] = useState<"auto" | "cloud" | "local">("auto");
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal title="New goal" onClose={onClose}>
      <Form onSubmit={async () => {
        try {
          const body: Record<string, unknown> = {
            title,
            spec,
            definitionOfDone: dod ? dod.split("\n").map((s) => s.trim()).filter(Boolean) : undefined,
            spendCapUsd: cap.trim() ? Number(cap) : null,
            maxDurationMinutes: maxMin.trim() ? Number(maxMin) : null,
            runnerPreference: runner,
          };
          if (body.spendCapUsd === null && confirmNoCap) body.confirmNoCap = true;
          await api.createGoal(projectId, body);
          onCreated();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }}>
        <Field label="Title"><Input value={title} onChange={setTitle} /></Field>
        <Field label="Spec (bullets become the drafted DoD)"><TextArea value={spec} onChange={setSpec} rows={6} /></Field>
        <Field label="Definition of done (one per line — optional, drafted from the spec otherwise)">
          <TextArea value={dod} onChange={setDod} rows={3} />
        </Field>
        <div className="grid2">
          <Field label="Spend cap (USD)"><Input value={cap} onChange={setCap} type="number" /></Field>
          <Field label="Max duration (minutes, optional)"><Input value={maxMin} onChange={setMaxMin} type="number" /></Field>
        </div>
        <Field label="Runner preference">
          <Select value={runner} onChange={setRunner} options={[
            { value: "auto", label: "auto (cloud when idle, local when busy)" },
            { value: "cloud", label: "cloud only" },
            { value: "local", label: "local only" },
          ]} />
        </Field>
        <label className="checkbox"><input type="checkbox" checked={confirmNoCap} onChange={(e) => setConfirmNoCap(e.target.checked)} /> confirm: run WITHOUT a spend cap (he ran one overnight and hit $1000)</label>
        <ErrorBox error={error} />
        <Btn kind="primary" type="submit">Create goal</Btn>
      </Form>
    </Modal>
  );
}

function GoalDetail({ projectId, goal, onClose, onChanged }: { projectId: string; goal: Goal; onClose: () => void; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Modal title={goal.title} onClose={onClose}>
      <div className="goal-detail">
        <p className="muted small">{goal.id} · created {relativeTime(goal.createdAt)} · {goal.runnerPreference} runner · spend ${goal.spendUsd}{goal.spendCapUsd !== null ? ` / cap $${goal.spendCapUsd}` : " (uncapped)"} · stuck threshold {goal.stuckThreshold}</p>
        <GoalBadge status={goal.status} />
        {!goal.dodApproved && (
          <div className="row">
            <Btn kind="primary" onClick={() => void act(() => api.approveDod(projectId, goal.id))}>Approve DoD & start loop</Btn>
            <p className="small muted">The loop does not start until the DoD is approved (§11).</p>
          </div>
        )}
        {goal.dodApproved && goal.status === "active" && (
          <div className="row">
            <Btn onClick={() => void act(() => api.pauseGoal(projectId, goal.id))}>Pause</Btn>
          </div>
        )}
        {goal.dodApproved && goal.status === "paused" && (
          <Btn onClick={() => void act(() => api.resumeGoal(projectId, goal.id))}>Resume</Btn>
        )}
        <ErrorBox error={error} />
        <h4>Definition of done</h4>
        <ul className="dod">
          {goal.definitionOfDone.map((d) => (
            <li key={d.id} className={d.done ? "done" : ""}>{d.done ? "☑" : "☐"} {d.text}</li>
          ))}
        </ul>
        <h4>Spec</h4>
        <pre className="pre small">{goal.spec}</pre>
        <h4>Progress log (append-only)</h4>
        <pre className="pre small">{goal.progressLog || "—"}</pre>
      </div>
    </Modal>
  );
}
