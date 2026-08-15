import { useState } from "react";
import { api } from "../api";
import { Card, useApi, Btn, Field, Input, TextArea, Select, Modal, Form, ErrorBox, Empty } from "../ui";

export function SkillsPage({ projectId }: { projectId: string }) {
  const skills = useApi(() => (projectId ? api.skills(projectId) : Promise.resolve([])), [projectId]);
  const [showCreate, setShowCreate] = useState(false);
  return (
    <div className="page">
      <h1>Skills</h1>
      <Card actions={<Btn onClick={() => setShowCreate(true)}>New skill</Btn>}>
        {skills.data?.length === 0 && <Empty>No skills.</Empty>}
        <table className="table">
          <thead><tr><th>Invocation</th><th>Name</th><th>Kind</th><th>Body / file</th></tr></thead>
          <tbody>
            {skills.data?.map((s) => (
              <tr key={s.id}>
                <td><code>/{s.slug}</code></td>
                <td>{s.name}</td>
                <td>{s.kind}</td>
                <td className="mono small">{s.kind === "file" ? s.filePath : (s.body ?? "").slice(0, 80)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {showCreate && (
        <SkillCreate projectId={projectId} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); skills.reload(); }} />
      )}
    </div>
  );
}

function SkillCreate({ projectId, onClose, onCreated }: { projectId: string; onClose: () => void; onCreated: () => void }) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"prompt" | "file">("prompt");
  const [body, setBody] = useState("");
  const [filePath, setFilePath] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="New skill" onClose={onClose}>
      <Form onSubmit={async () => {
        try {
          await api.createSkill(projectId, { slug, name: name || slug, kind, body: kind === "prompt" ? body : null, filePath: kind === "file" ? filePath : null });
          onCreated();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }}>
        <Field label="Slug (invoked as /slug)"><Input value={slug} onChange={setSlug} placeholder="plan-mode" /></Field>
        <Field label="Name"><Input value={name} onChange={setName} /></Field>
        <Field label="Kind">
          <Select value={kind} onChange={setKind} options={[{ value: "prompt", label: "prompt" }, { value: "file", label: "file (script)" }]} />
        </Field>
        {kind === "prompt" ? (
          <Field label="Body"><TextArea value={body} onChange={setBody} rows={5} /></Field>
        ) : (
          <Field label="File path (on the R2-style filesystem)"><Input value={filePath} onChange={setFilePath} /></Field>
        )}
        <ErrorBox error={error} />
        <Btn kind="primary" type="submit">Create</Btn>
      </Form>
    </Modal>
  );
}
