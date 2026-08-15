/**
 * Goals service + gauntlet orchestrator (§11).
 *
 * The orchestrator is CONTROL-PLANE CODE, not a user-facing agent. After
 * every goal session it reads the progress log + DoD + last session summary,
 * marks satisfied DoD checkboxes, checks the safety rails (spend / time /
 * stuck-at-19), and either completes the goal or spawns the next specialist.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { goals, agents, kv } from "../db/schema.js";
import type { DB } from "../db/client.js";
import type { Goal, DoDItem, GoalStatus } from "../domain/types.js";
import { HttpError } from "../api/errors.js";

export interface CreateGoalInput {
  projectId: string;
  title: string;
  spec: string;
  definitionOfDone?: string[];
  spendCapUsd?: number | null;
  maxDurationMinutes?: number | null;
  runnerPreference?: "cloud" | "local" | "auto";
  stuckThreshold?: number;
}

export interface OrchestratorDecision {
  action: "complete" | "continue" | "stop";
  stopReason?: GoalStatus;
  nextAgentId?: string | null;
  nextAgentName?: string | null;
  summary: string;
}

const STUCK_KEY = (goalId: string) => `goal:stuck:${goalId}`;

export class GoalService {
  constructor(private db: DB) {}

  async get(goalId: string): Promise<Goal | null> {
    const row = await this.db.select().from(goals).where(eq(goals.id, goalId)).get();
    if (!row) return null;
    return { ...row, definitionOfDone: row.definitionOfDone ?? [], sessionIds: row.sessionIds ?? [] };
  }

  async list(projectId: string): Promise<Goal[]> {
    const rows = await this.db.select().from(goals).where(eq(goals.projectId, projectId)).all();
    return rows
      .map((r) => ({ ...r, definitionOfDone: r.definitionOfDone ?? [], sessionIds: r.sessionIds ?? [] }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * §11.2: draft a Definition of Done from the spec sheet when the human did
   * not write one. Heuristic stand-in: bullet items from the spec, else
   * sentence splits. (A planner model call can replace this; labeled.)
   */
  static draftDoD(spec: string): string[] {
    const lines = spec.split("\n").map((l) => l.trim()).filter(Boolean);
    const bullets = lines
      .filter((l) => /^[-*•]|\d+[.)]/.test(l))
      .map((l) => l.replace(/^[-*•]\s*|\d+[.)]\s*/, ""));
    if (bullets.length >= 2) return bullets;
    const sentences = spec
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 8);
    return sentences.slice(0, 5);
  }

  async create(input: CreateGoalInput): Promise<Goal> {
    const dodTexts = input.definitionOfDone && input.definitionOfDone.length > 0
      ? input.definitionOfDone
      : GoalService.draftDoD(input.spec);
    if (dodTexts.length === 0) {
      throw new HttpError(400, "could not draft a definition of done — write DoD items explicitly");
    }
    const now = new Date().toISOString();
    const row: Goal = {
      id: randomUUID(),
      projectId: input.projectId,
      title: input.title,
      spec: input.spec,
      definitionOfDone: dodTexts.map((t) => ({ id: randomUUID(), text: t, done: false }) satisfies DoDItem),
      dodApproved: false,
      status: "active",
      spendCapUsd: input.spendCapUsd ?? null,
      spendUsd: 0,
      maxDurationMinutes: input.maxDurationMinutes ?? null,
      stuckThreshold: input.stuckThreshold ?? 19,
      runnerPreference: input.runnerPreference ?? "auto",
      progressLog: "",
      startedAt: null,
      sessionIds: [],
      createdAt: now,
    };
    await this.db.insert(goals).values(row).run();
    return row;
  }

  async approveDoD(goalId: string): Promise<Goal> {
    const g = await this.get(goalId);
    if (!g) throw new HttpError(404, "goal not found");
    if (g.definitionOfDone.every((d) => !d.done) && g.definitionOfDone.length === 0) {
      throw new HttpError(400, "goal has an empty definition of done");
    }
    // §11: a goal without a spend cap is allowed only with explicit human
    // confirmation — the API layer requires `confirmNoCap: true`.
    const updated = {
      ...g,
      dodApproved: true,
      startedAt: g.startedAt ?? new Date().toISOString(),
    };
    await this.db.update(goals).set(updated).where(eq(goals.id, goalId)).run();
    return updated;
  }

  async setStatus(goalId: string, status: GoalStatus): Promise<Goal> {
    const g = await this.get(goalId);
    if (!g) throw new HttpError(404, "goal not found");
    const updated = { ...g, status };
    await this.db.update(goals).set(updated).where(eq(goals.id, goalId)).run();
    return updated;
  }

  /** Append-only progress log. */
  async appendProgress(goalId: string, entry: string): Promise<Goal> {
    const g = await this.get(goalId);
    if (!g) throw new HttpError(404, "goal not found");
    const stamp = `[${new Date().toISOString()}] ${entry}`;
    const progressLog = g.progressLog ? g.progressLog + "\n" + stamp : stamp;
    await this.db.update(goals).set({ progressLog }).where(eq(goals.id, goalId)).run();
    return { ...g, progressLog };
  }

  async addSession(goalId: string, sessionId: string): Promise<void> {
    const g = await this.get(goalId);
    if (!g) return;
    await this.db
      .update(goals)
      .set({ sessionIds: [...g.sessionIds, sessionId] })
      .where(eq(goals.id, goalId))
      .run();
  }

  async addSpend(goalId: string, usd: number): Promise<Goal> {
    const g = await this.get(goalId);
    if (!g) throw new HttpError(404, "goal not found");
    const spendUsd = Math.round((g.spendUsd + usd) * 10000) / 10000;
    await this.db.update(goals).set({ spendUsd }).where(eq(goals.id, goalId)).run();
    return { ...g, spendUsd };
  }

  async setDoDItems(goalId: string, items: DoDItem[]): Promise<Goal> {
    const g = await this.get(goalId);
    if (!g) throw new HttpError(404, "goal not found");
    const updated = { ...g, definitionOfDone: items };
    await this.db.update(goals).set(updated).where(eq(goals.id, goalId)).run();
    return updated;
  }

  /**
   * Mark ONE definition-of-done item satisfied. This is the only way an item
   * becomes done: a specialist calls it after actually finishing and
   * verifying the item — the orchestrator never infers completion from
   * progress-log text. Matching is exact first, then containment, then word
   * overlap; a non-matching call fails instead of guessing.
   */
  async completeDoDItem(goalId: string, itemText: string): Promise<Goal> {
    const g = await this.get(goalId);
    if (!g) throw new HttpError(404, "goal not found");
    const target = normalizeText(itemText);
    if (!target) throw new HttpError(400, "empty definition-of-done item");
    const items = g.definitionOfDone.map((d) => ({ ...d }));

    let idx = items.findIndex((d) => !d.done && normalizeText(d.text) === target);
    if (idx === -1) {
      idx = items.findIndex(
        (d) => !d.done && (normalizeText(d.text).includes(target) || target.includes(normalizeText(d.text))),
      );
    }
    if (idx === -1) {
      let best = -1;
      let bestScore = 0;
      items.forEach((d, i) => {
        if (d.done) return;
        const s = missionScore(d.text, target) + missionScore(target, d.text);
        if (s > bestScore) {
          bestScore = s;
          best = i;
        }
      });
      idx = bestScore > 0 ? best : -1;
    }
    if (idx === -1) {
      throw new HttpError(400, `no unsatisfied definition-of-done item matches "${itemText}"`);
    }
    items[idx] = { ...items[idx]!, done: true };
    return this.setDoDItems(goalId, items);
  }

  // -------------------------------------------------------------------------
  // Orchestrator
  // -------------------------------------------------------------------------

  /** §11.6: run after every goal session. Returns the decision taken. */
  async orchestrate(
    goalId: string,
    opts: { allowList: { id: string; name: string }[] },
  ): Promise<OrchestratorDecision> {
    const g = await this.get(goalId);
    if (!g) throw new HttpError(404, "goal not found");
    if (!g.dodApproved) {
      return { action: "stop", stopReason: "stopped-stuck", summary: "goal not approved; orchestrator refuses to spawn" };
    }
    if (g.status !== "active") return { action: "stop", summary: `goal status ${g.status}` };

    // --- Safety rails (§11) ------------------------------------------------
    if (g.spendCapUsd !== null && g.spendUsd >= g.spendCapUsd) {
      await this.setStatus(goalId, "stopped-spend");
      return { action: "stop", stopReason: "stopped-spend", summary: `spend ${g.spendUsd} >= cap ${g.spendCapUsd}` };
    }
    if (g.maxDurationMinutes !== null && g.startedAt) {
      const elapsed = (Date.now() - new Date(g.startedAt).getTime()) / 60000;
      if (elapsed >= g.maxDurationMinutes) {
        await this.setStatus(goalId, "stopped-time");
        return { action: "stop", stopReason: "stopped-time", summary: `elapsed ${Math.round(elapsed)}m >= ${g.maxDurationMinutes}m` };
      }
    }

    // --- DoD satisfaction (explicit, agent-marked) ---------------------------
    // An item is done only when the specialist marked it via
    // goals.complete_dod_item — never inferred from free-text progress logs.
    const items = g.definitionOfDone;
    const allDone = items.every((d) => d.done);
    if (allDone) {
      await this.setStatus(goalId, "completed");
      return { action: "complete", summary: "all DoD checkboxes satisfied" };
    }

    // --- Stuck detection: same specialist + no progress delta, N times -------
    const last = await this.lastSessionInfo(g);
    const stuckRow = await this.db.select().from(kv).where(eq(kv.key, STUCK_KEY(goalId))).get();
    const stuck = stuckRow ? JSON.parse(stuckRow.value) : { lastAgent: null as string | null, lastProgressLen: 0, count: 0 };
    const progressLen = g.progressLog.length;
    const sameAgent = stuck.lastAgent === last.agentName;
    const noDelta = progressLen === stuck.lastProgressLen;
    let count = 0;
    if (sameAgent && noDelta && last.agentName) count = stuck.count + 1;
    else count = sameAgent ? stuck.count : 0;
    const threshold = g.stuckThreshold;
    await this.db
      .insert(kv)
      .values({ key: STUCK_KEY(goalId), value: JSON.stringify({ lastAgent: last.agentName, lastProgressLen: progressLen, count }) })
      .onConflictDoUpdate({ target: kv.key, set: { value: JSON.stringify({ lastAgent: last.agentName, lastProgressLen: progressLen, count }) } })
      .run();
    if (count >= threshold) {
      await this.setStatus(goalId, "stopped-stuck");
      return { action: "stop", stopReason: "stopped-stuck", summary: `${count} identical iterations without progress` };
    }

    // --- Pick next specialist ------------------------------------------------
    // DoD-aware dispatch: score each specialist's mission against the first
    // unsatisfied DoD item; fall back to round-robin when nothing matches
    // (keeps the loop deterministic and test-stable).
    const firstOpenItem = items.find((d) => !d.done)?.text ?? "";
    const missionByAgent = await this.missionsFor(opts.allowList);
    const next = this.pickNextAgent(opts.allowList, last.agentName, firstOpenItem, missionByAgent);
    if (!next) {
      await this.setStatus(goalId, "stopped-stuck");
      return { action: "stop", stopReason: "stopped-stuck", summary: "no specialist available on the allow list" };
    }
    return { action: "continue", nextAgentId: next.id, nextAgentName: next.name, summary: `spawn ${next.name}` };
  }

  /** Role-prompt mission + deliverable sections per allow-listed agent (dispatch input). */
  private async missionsFor(
    allowList: { id: string; name: string }[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (allowList.length === 0) return map;
    const rows = await this.db
      .select()
      .from(agents)
      .where(inArray(agents.id, allowList.map((a) => a.id)))
      .all();
    for (const a of rows) {
      map.set(a.name, `${a.name} ${a.title} ${promptSection(a.rolePrompt, "## Mission")} ${promptSection(a.rolePrompt, "## Deliverable")}`);
    }
    return map;
  }

  /**
   * §8.2: choose the next specialist. Prefer the specialist whose profile
   * (name, title, mission, deliverable) best covers the first unsatisfied
   * DoD item's significant words; ties rotate by recency, and no match
   * falls back to the full round-robin so a 2-item DoD spawns ≥2 sessions.
   */
  private pickNextAgent(
    allowList: { id: string; name: string }[],
    lastAgentName: string | null,
    firstOpenItem: string,
    profileByAgent: Map<string, string>,
  ): { id: string; name: string } | null {
    let bestScore = 0;
    const tied: { id: string; name: string }[] = [];
    if (firstOpenItem) {
      for (const a of allowList) {
        const score = missionScore(profileByAgent.get(a.name) ?? "", firstOpenItem);
        if (score > bestScore) {
          bestScore = score;
          tied.length = 0;
          tied.push(a);
        } else if (score > 0 && score === bestScore) {
          tied.push(a);
        }
      }
    }
    if (bestScore > 0) return rotate(tied, lastAgentName);

    // Round-robin through the whole allow list (no keyword match).
    return rotate(allowList, lastAgentName);
  }

  private async lastSessionInfo(g: Goal): Promise<{ agentName: string | null; progressLen: number }> {
    const id = g.sessionIds[g.sessionIds.length - 1];
    if (!id) return { agentName: null, progressLen: 0 };
    const row = await this.db.query.sessions.findFirst({ where: (s, { eq: e }) => e(s.id, id) });
    if (!row) return { agentName: null, progressLen: 0 };
    const agent = row.agentId ? await this.db.select().from(agents).where(eq(agents.id, row.agentId)).get() : null;
    return { agentName: agent?.name ?? null, progressLen: g.progressLog.length };
  }
}

/** The text of one "## Section" of a structured role prompt (dispatch input). */
function promptSection(rolePrompt: string, marker: string): string {
  const i = rolePrompt.indexOf(marker);
  if (i < 0) return "";
  const rest = rolePrompt.slice(i + marker.length);
  const j = rest.indexOf("##");
  return (j >= 0 ? rest.slice(0, j) : rest).trim();
}

/** Lowercase + collapse non-alphanumerics to single spaces. */
function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Rotate a list so the agent that ran last is moved to the back, then take the head. */
function rotate<T extends { name: string }>(list: T[], lastAgentName: string | null): T | null {
  const out = [...list];
  if (lastAgentName) {
    const idx = out.findIndex((a) => a.name === lastAgentName);
    if (idx >= 0) out.push(out.splice(0, idx + 1).shift()!);
  }
  return out.length ? out[0]! : null;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "this", "that", "your", "you",
  "are", "not", "when", "will", "then", "each", "only", "can", "its",
  "item", "a", "an", "of", "to", "in", "on", "by", "at", "or", "as", "be",
  "it", "is", "one", "any", "all", "but", "has", "have", "was", "were",
]);

/** Coverage of a DoD item's significant words by a mission text (0..1). */
export function missionScore(mission: string, itemText: string): number {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  const words = norm(itemText).filter((w) => w.length > 3 && !STOPWORDS.has(w));
  if (words.length === 0) return 0;
  const wanted = new Set(words);
  const missionWords = norm(mission);
  let hits = 0;
  for (const w of missionWords) if (wanted.has(w)) hits++;
  return hits / words.length;
}
