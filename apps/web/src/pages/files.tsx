import { useState } from "react";
import { api, type FileEntry } from "../api";
import { Card, useApi, Btn, Field, Input, TextArea, Modal, Form, ErrorBox, Empty, relativeTime } from "../ui";

export function FilesPage({ projectId }: { projectId: string }) {
  const [path, setPath] = useState("/");
  const list = useApi(() => (projectId ? api.files(projectId, path) : Promise.resolve([] as unknown as { path: string; entries: FileEntry[] })), [projectId, path]);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [newFile, setNewFile] = useState(false);

  const segments = path.split("/").filter(Boolean);

  return (
    <div className="page">
      <h1>Files</h1>
      <Card
        title={
          <span className="crumbs">
            <a onClick={() => setPath("/")}>/</a>
            {segments.map((s, i) => (
              <span key={i}>
                <a onClick={() => setPath("/" + segments.slice(0, i + 1).join("/"))}>{s}</a>/
              </span>
            ))}
          </span>
        }
        actions={<Btn onClick={() => setNewFile(true)}>New file</Btn>}
      >
        {list.error && <ErrorBox error={list.error} />}
        <table className="table">
          <thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Updated</th></tr></thead>
          <tbody>
            {(list.data?.entries ?? []).map((e) => (
              <tr key={e.path} className="clickable" onClick={() => (e.type === "dir" ? setPath(e.path) : setOpenFile(e.path))}>
                <td>{e.type === "dir" ? "📁 " : "📄 "}{e.path.split("/").pop()}</td>
                <td>{e.type}</td>
                <td>{e.size}</td>
                <td>{relativeTime(e.updatedAt)}</td>
              </tr>
            ))}
            {(list.data?.entries ?? []).length === 0 && (
              <tr><td colSpan={4}><Empty>Empty folder.</Empty></td></tr>
            )}
          </tbody>
        </table>
      </Card>
      {openFile && <FileViewer projectId={projectId} filePath={openFile} onClose={() => setOpenFile(null)} onChanged={() => list.reload()} />}
      {newFile && <NewFile projectId={projectId} dir={path} onClose={() => setNewFile(false)} onCreated={() => { setNewFile(false); list.reload(); }} />}
    </div>
  );
}

function FileViewer({ projectId, filePath, onClose, onChanged }: { projectId: string; filePath: string; onClose: () => void; onChanged: () => void }) {
  const content = useApi(() => api.fileContent(projectId, filePath), [projectId, filePath]);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isText = content.data?.text !== null && content.data?.text !== undefined;

  return (
    <Modal title={`File: ${filePath}`} onClose={onClose}>
      {content.error && <ErrorBox error={content.error} />}
      {content.data && (
        <>
          <p className="muted small">{content.data.mime} · {content.data.size} bytes</p>
          {isText ? (
            <TextArea value={text ?? content.data.text ?? ""} onChange={setText} rows={16} />
          ) : (
            <p>Binary file — download not available in this view.</p>
          )}
          <div className="row">
            {isText && (
              <Btn kind="primary" onClick={async () => {
                try {
                  await api.writeFile(projectId, filePath, text ?? content.data!.text ?? "");
                  onChanged();
                  onClose();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}>Save</Btn>
            )}
            <Btn kind="danger" onClick={async () => {
              if (!confirm(`Delete ${filePath}?`)) return;
              await api.deleteFile(projectId, filePath);
              onChanged();
              onClose();
            }}>Delete</Btn>
            <ErrorBox error={error} />
          </div>
        </>
      )}
    </Modal>
  );
}

function NewFile({ projectId, dir, onClose, onCreated }: { projectId: string; dir: string; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="New file" onClose={onClose}>
      <Form onSubmit={async () => {
        try {
          const p = (dir === "/" ? "" : dir) + "/" + name;
          await api.writeFile(projectId, p, content);
          onCreated();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }}>
        <Field label="Path"><Input value={name} onChange={setName} placeholder="notes/feature.md" /></Field>
        <Field label="Content"><TextArea value={content} onChange={setContent} rows={8} /></Field>
        <ErrorBox error={error} />
        <Btn kind="primary" type="submit">Create</Btn>
      </Form>
    </Modal>
  );
}

