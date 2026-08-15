/**
 * Persistent filesystem service.
 *
 * Cloudflare R2 is the blueprint's persistence layer; in this environment the
 * stand-in is a local blob directory (`data/blobs`) + the `files` table.
 * NOTE (assumption): swap `writeBlob`/`readBlob` for an R2 client to move to
 * real R2 — the `bucketKey` column is already modeled for it.
 * Agents NEVER touch this service directly; they go through the r2-fs MCP
 * which enforces folder ACLs server-side (§7).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { eq, and, like } from "drizzle-orm";
import { files } from "../db/schema.js";
import type { DB } from "../db/client.js";
import type { Config } from "../config.js";
import type { FileObject } from "../domain/types.js";
import { normalizePath } from "../acl/grants.js";

export interface FileEntry {
  path: string; // "/" for root
  type: "dir" | "file";
  size: number;
  updatedAt: string | null;
  file?: FileObject;
}

export class FileService {
  constructor(
    private db: DB,
    private config: Config,
  ) {}

  private blobPath(bucketKey: string): string {
    return path.join(this.config.blobDir, bucketKey);
  }

  /** Operator-level write (UI / attach). Paths normalized, no traversal. */
  async write(projectId: string, rawPath: string, content: Buffer | string, mime?: string): Promise<FileObject> {
    const p = normalizePath(rawPath);
    if (!p) throw new Error(`invalid path: ${rawPath}`);
    const bucketKey = randomUUID();
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    mkdirSync(this.config.blobDir, { recursive: true });
    writeFileSync(this.blobPath(bucketKey), buf);
    const now = new Date().toISOString();
    const existing = await this.db
      .select()
      .from(files)
      .where(and(eq(files.projectId, projectId), eq(files.path, p)))
      .get();
    if (existing) {
      // Replace: remove old blob, keep id.
      try {
        unlinkSync(this.blobPath(existing.bucketKey));
      } catch {
        /* ignore missing */
      }
      await this.db
        .update(files)
        .set({ bucketKey, mime: mime ?? guessMime(p), size: buf.length, updatedAt: now })
        .where(eq(files.id, existing.id))
        .run();
      return { ...existing, bucketKey, mime: mime ?? guessMime(p), size: buf.length, updatedAt: now };
    }
    const row: FileObject = {
      id: randomUUID(),
      projectId,
      path: p,
      bucketKey,
      mime: mime ?? guessMime(p),
      size: buf.length,
      updatedAt: now,
    };
    await this.db.insert(files).values(row).run();
    return row;
  }

  async read(projectId: string, rawPath: string): Promise<{ file: FileObject; content: Buffer }> {
    const p = normalizePath(rawPath);
    if (!p) throw new Error(`invalid path: ${rawPath}`);
    const row = await this.db
      .select()
      .from(files)
      .where(and(eq(files.projectId, projectId), eq(files.path, p)))
      .get();
    if (!row) throw new Error(`file not found: ${p}`);
    const content = existsSync(this.blobPath(row.bucketKey))
      ? readFileSync(this.blobPath(row.bucketKey))
      : Buffer.alloc(0);
    return { file: row, content };
  }

  async getById(id: string): Promise<FileObject | null> {
    const row = await this.db.select().from(files).where(eq(files.id, id)).get();
    return row ?? null;
  }

  async delete(projectId: string, rawPath: string): Promise<void> {
    const p = normalizePath(rawPath);
    if (!p) throw new Error(`invalid path: ${rawPath}`);
    const row = await this.db
      .select()
      .from(files)
      .where(and(eq(files.projectId, projectId), eq(files.path, p)))
      .get();
    if (!row) return;
    try {
      unlinkSync(this.blobPath(row.bucketKey));
    } catch {
      /* ignore missing */
    }
    await this.db.delete(files).where(eq(files.id, row.id)).run();
  }

  /** Directory listing with implicit virtual folders. */
  async list(projectId: string, rawPath: string): Promise<FileEntry[]> {
    const p = normalizePath(rawPath) ?? "/";
    const prefix = p === "/" ? "/" : p + "/";
    const rows = await this.db
      .select()
      .from(files)
      .where(eq(files.projectId, projectId))
      .all();
    const out = new Map<string, FileEntry>();
    for (const row of rows) {
      if (p === "/" || row.path.startsWith(prefix)) {
        const rest = p === "/" ? row.path.slice(1) : row.path.slice(prefix.length);
        if (rest === "") continue;
        const seg = rest.split("/")[0]!;
        const full = p === "/" ? "/" + seg : p + "/" + seg;
        if (rest.includes("/")) {
          if (!out.has(full)) {
            out.set(full, { path: full, type: "dir", size: 0, updatedAt: null });
          }
        } else {
          out.set(full, { path: full, type: "file", size: row.size, updatedAt: row.updatedAt, file: row });
        }
      }
    }
    return [...out.values()].sort((a, b) =>
      a.type === b.type ? a.path.localeCompare(b.path) : a.type === "dir" ? -1 : 1,
    );
  }

  async all(projectId: string): Promise<FileObject[]> {
    return this.db.select().from(files).where(eq(files.projectId, projectId)).all();
  }
}

function guessMime(p: string): string {
  const ext = path.extname(p).toLowerCase();
  const map: Record<string, string> = {
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".js": "text/javascript",
    ".py": "text/x-python",
    ".html": "text/html",
    ".css": "text/css",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
  };
  return map[ext] ?? "application/octet-stream";
}
