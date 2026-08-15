import { useState } from "react";
import { api } from "../api";
import { Form, Field, Input, Btn, ErrorBox } from "../ui";

export function LoginPage({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="login">
      <div className="login-card">
        <h1>AgentOS</h1>
        <p>Personal control plane. Agents work, you decide.</p>
        <Form onSubmit={async () => {
          try {
            await api.login(token.trim());
            onDone();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}>
          <Field label="Operator token">
            <Input value={token} onChange={setToken} placeholder="paste the token printed on server start" type="password" />
          </Field>
          <ErrorBox error={error} />
          <Btn kind="primary" type="submit">Sign in</Btn>
        </Form>
      </div>
    </div>
  );
}
