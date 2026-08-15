import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Routes, Route, Navigate, NavLink, useNavigate } from "react-router-dom";
import { api, setOnUnauthorized } from "./api";
import { LoginPage } from "./pages/login";
import { OverviewPage } from "./pages/overview";
import { AgentsPage } from "./pages/agents";
import { SkillsPage } from "./pages/skills";
import { FilesPage } from "./pages/files";
import { InfraPage } from "./pages/infra";
import { TasksPage } from "./pages/tasks";
import { GoalsPage } from "./pages/goals";
import { InboxPage } from "./pages/inbox";
import { TriggersPage } from "./pages/triggers";
import { SessionsPage, SessionViewerPage } from "./pages/sessions";
import { ActivityPage } from "./pages/activity";
import "./styles.css";

const NAV = [
  { to: "/overview", label: "Overview" },
  { to: "/tasks", label: "Tasks" },
  { to: "/goals", label: "Goals" },
  { to: "/inbox", label: "Inbox" },
  { to: "/agents", label: "Agents" },
  { to: "/skills", label: "Skills" },
  { to: "/files", label: "Files" },
  { to: "/mcps", label: "MCPs" },
  { to: "/repos", label: "Repos" },
  { to: "/environments", label: "Environments" },
  { to: "/secrets", label: "Secrets" },
  { to: "/triggers", label: "Triggers" },
  { to: "/automations", label: "Automations" },
  { to: "/sessions", label: "Sessions" },
  { to: "/activity", label: "Activity" },
];

function Shell() {
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectId, setProjectId] = useState<string>(() => localStorage.getItem("agentos.project") ?? "");
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [openInbox, setOpenInbox] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    api.me().then(() => setAuthed(true)).catch(() => setAuthed(false));
    setOnUnauthorized(() => setAuthed(false));
  }, []);

  useEffect(() => {
    if (!authed) return;
    api.projects().then((ps) => {
      setProjects(ps);
      if (!projectId && ps[0]) {
        setProjectId(ps[0].id);
        localStorage.setItem("agentos.project", ps[0].id);
      }
    }).catch(() => undefined);
    const t = setInterval(() => {
      api.inbox().then((msgs) => setOpenInbox(msgs.filter((m) => m.status === "open").length)).catch(() => undefined);
    }, 5000);
    return () => clearInterval(t);
  }, [authed]);

  if (authed === null) return <div className="boot">AgentOS…</div>;
  if (!authed) return <LoginPage onDone={() => setAuthed(true)} />;

  const selectProject = (id: string) => {
    setProjectId(id);
    localStorage.setItem("agentos.project", id);
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">AgentOS</div>
        <select className="input project-select" value={projectId} onChange={(e) => selectProject(e.target.value)}>
          {projects.length === 0 && <option value="">no project — create one in Overview</option>}
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <nav>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? "active" : "")}>
              {n.label}
              {n.to === "/inbox" && openInbox > 0 && <span className="nav-badge">{openInbox}</span>}
            </NavLink>
          ))}
        </nav>
        <button
          className="btn ghost logout"
          onClick={() => { void api.logout().finally(() => { setAuthed(false); navigate("/"); }); }}
        >
          Log out
        </button>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/overview" replace />} />
          <Route path="/overview" element={<OverviewPage projectId={projectId} />} />
          <Route path="/tasks" element={<TasksPage projectId={projectId} />} />
          <Route path="/goals" element={<GoalsPage projectId={projectId} />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/agents" element={<AgentsPage projectId={projectId} />} />
          <Route path="/skills" element={<SkillsPage projectId={projectId} />} />
          <Route path="/files" element={<FilesPage projectId={projectId} />} />
          <Route path="/mcps" element={<InfraPage kind="mcps" projectId={projectId} />} />
          <Route path="/repos" element={<InfraPage kind="repos" projectId={projectId} />} />
          <Route path="/environments" element={<InfraPage kind="environments" projectId={projectId} />} />
          <Route path="/secrets" element={<InfraPage kind="secrets" projectId={projectId} />} />
          <Route path="/triggers" element={<TriggersPage projectId={projectId} />} />
          <Route path="/automations" element={<TriggersPage automations projectId={projectId} />} />
          <Route path="/sessions" element={<SessionsPage projectId={projectId} />} />
          <Route path="/sessions/:id" element={<SessionViewerPage />} />
          <Route path="/activity" element={<ActivityPage />} />
        </Routes>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <Shell />
    </HashRouter>
  </StrictMode>,
);
