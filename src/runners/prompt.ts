/**
 * Shared agent-prompt assembly (§8.3 runtime inputs).
 *
 * Both the Claude cloud runner and the DeepSeek runner assemble the model's
 * system prompt the same way: foundational prompt + role prompt + the
 * sanitized session manifest (runtime inputs).
 */
import type { SessionManifest } from "../domain/types.js";

export function buildAgentPrompt(manifest: SessionManifest): string {
  const parts: string[] = [
    manifest.agent.foundationalPrompt,
    "",
    "## Your role",
    manifest.agent.rolePrompt,
    "",
    "## Session manifest (runtime inputs)",
    `- Agent: ${manifest.agent.name} (${manifest.agent.title})`,
    `- Model: ${manifest.agent.model}`,
    `- MCP connections: ${manifest.mcpConnections.join(", ") || "(none)"}`,
    `- Skills: ${manifest.agent.skills.map((s) => `/${s.slug}`).join(", ") || "(none)"}`,
    `- Filesystem grants: ${manifest.filesystemGrants
      .map((g) => `${g.folderPath} (read=${g.canRead}, write=${g.canWrite}, delete=${g.canDelete})`)
      .join("; ") || "(none)"}`,
    `- Repos: ${manifest.repos.map((r) => `${r.mountPath} (${r.permissions})`).join(", ") || "(none)"}`,
    `- Network: ${manifest.environment ? `${manifest.environment.networking} → ${manifest.environment.allowedHosts.join(", ") || "no hosts"}` : "(none)"}`,
    `- Collaboration list: ${manifest.collaborationList.join(", ") || "(none)"}`,
    `- Inbox access: ${manifest.inboxAccess ? "yes (use it only when stuck or a decision is needed)" : "no"}`,
    `- Env vars: ${manifest.envNames.join(", ") || "(none)"}`,
  ];
  if (manifest.task) {
    parts.push(
      "",
      "## Current task",
      `# ${manifest.task.name}`,
      manifest.task.description,
      `Status: ${manifest.task.status}`,
      `Approval gate: ${manifest.task.approvalGate ? "YES — never mark this task done; leave it in review and inbox the human" : "no"}`,
      `Attachments: ${manifest.task.attachments.map((a) => a.path).join(", ") || "(none)"}`,
    );
  }
  if (manifest.goal) {
    parts.push(
      "",
      "## Goal context",
      `# ${manifest.goal.title}`,
      manifest.goal.spec,
      "",
      "Definition of done (checkboxes):",
      ...manifest.goal.definitionOfDone.map((d) => `- [ ] ${d}`),
      "",
      "Progress log so far:",
      manifest.goal.progressLog || "(empty)",
    );
  }
  return parts.join("\n");
}
