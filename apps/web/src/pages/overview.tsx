import { useState } from "react";
import { api, type ActivityEvent } from "../api";
import { Card, useApi, relativeTime, Empty, Form, Field, Input, Btn } from "../ui";

export function OverviewPage({ projectId }: { projectId: string }) {
  const projects = useApi(() => api.projects(), []);
  const config = useApi(() => api.adminConfig(), []);
  const activity = useApi(() => api.activity(), []);
  const tasks = useApi(() => (projectId ? api.tasks(projectId) : Promise.resolve([])), [projectId]);
  const goals = useApi(() => (projectId ? api.goals(projectId) : Promise.resolve([])), [projectId]);

  const activeProject = projects.data?.find((p) => p.id === projectId);

  return (
    <div className="page">
      <h1>Overview</h1>
      {projects.data && projects.data.length === 0 && (
        <Card title="Welcome">
          <p>No projects yet. Create one to seed the default catalog (agents, environments, skills, the compound-engineer template).</p>
          <CreateProjectCard onCreated={() => projects.reload()} />
        </Card>
      )}
      <div className="grid2">
        <Card title="Project">
          {activeProject ? (
            <>
              <p><strong>{activeProject.name}</strong> ({activeProject.slug})</p>
              <p>
                Tasks: {tasks.data?.filter((t) => t.status === "todo").length ?? "…"} todo ·{" "}
                {tasks.data?.filter((t) => t.status === "doing").length ?? "…"} doing ·{" "}
                {tasks.data?.filter((t) => t.status === "review").length ?? "…"} review ·{" "}
                {tasks.data?.filter((t) => t.status === "done").length ?? "…"} done
              </p>
              <p>Goals: {goals.data?.length ?? "…"} ({goals.data?.filter((g) => g.status === "active").length ?? "…"} active)</p>
            </>
          ) : (
            <p>Select a project in the sidebar.</p>
          )}
        </Card>
        <Card title="Runtime">
          {config.data && (
            <>
              <p>Claude: {config.data.hasApiKey ? "cloud enabled" : "simulated (no ANTHROPIC_API_KEY)"}</p>
              <p>DeepSeek: {config.data.hasDeepseekKey ? "cloud enabled (BYOK)" : "simulated (no DEEPSEEK_API_KEY)"}</p>
              <p>Cloud busy: {config.data.cloudBusy ? "yes" : "no"} · Local runner: {config.data.localRunnerEnabled ? "enabled" : "disabled"}</p>
              <p>Public URL: {config.data.publicUrl}</p>
            </>
          )}
        </Card>
      </div>
      <Card title="Recent activity">
        <ActivityList events={activity.data ?? []} limit={10} />
      </Card>
    </div>
  );
}

export function ActivityList({ events, limit }: { events: ActivityEvent[]; limit?: number }) {
  if (events.length === 0) return <Empty>Nothing yet — create a task or a goal and watch the feed.</Empty>;
  return (
    <ul className="feed">
      {events.slice(0, limit ?? events.length).map((e) => (
        <li key={e.id}>
          <span className={`feed-dot ${e.type}`} />
          <div>
            <div><strong>{e.actor}</strong> · <span className="muted">{relativeTime(e.at)}</span></div>
            <div>{e.message}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function CreateProjectCard({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  return (
    <Form onSubmit={async () => {
      if (!name.trim()) return;
      await api.createProject(name.trim());
      setName("");
      onCreated();
    }}>
      <Field label="Project name">
        <Input value={name} onChange={setName} placeholder="acme" />
      </Field>
      <Btn kind="primary" type="submit">Create project</Btn>
    </Form>
  );
}
