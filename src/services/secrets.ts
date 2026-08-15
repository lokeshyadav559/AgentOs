/**
 * Secret storage.
 *
 * Blueprint §3.4: secrets live in Google Secret Manager / Cloud KMS; the app
 * DB holds only references. NOTE (assumption): this environment has no Google
 * Cloud, so the stand-in is a local vault: values are AES-256-GCM encrypted at
 * rest with a key derived from the AgentOS HMAC secret, stored in the
 * `secrets.value_enc` column. The `providerRef` column still records the
 * provider ("local-vault://<id>") so moving to Secret Manager is a swap of
 * this class only. Never store raw tokens in plaintext columns.
 */
import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { secrets } from "../db/schema.js";
import type { DB } from "../db/client.js";
import type { SecretRef, SecretPurpose } from "../domain/types.js";

export class SecretService {
  constructor(
    private db: DB,
    private hmacSecret: string,
  ) {}

  private key(): Buffer {
    return createHash("sha256").update("agentos-vault:" + this.hmacSecret).digest();
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv.toString("base64url"), tag.toString("base64url"), enc.toString("base64url")].join(".");
  }

  decrypt(payload: string): string {
    const [ivB, tagB, encB] = payload.split(".");
    const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(ivB!, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB!, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encB!, "base64url")), decipher.final()]).toString("utf8");
  }

  async createRef(
    projectId: string,
    name: string,
    purpose: SecretPurpose,
    value?: string,
  ): Promise<SecretRef> {
    const id = randomUUID();
    const row: SecretRef = {
      id,
      projectId,
      name,
      providerRef: `local-vault://${id}`,
      purpose,
    };
    await this.db
      .insert(secrets)
      .values({
        ...row,
        valueEnc: value !== undefined ? this.encrypt(value) : null,
        createdAt: new Date().toISOString(),
      })
      .run();
    return row;
  }

  async setValue(id: string, value: string): Promise<void> {
    await this.db
      .update(secrets)
      .set({ valueEnc: this.encrypt(value) })
      .where(eq(secrets.id, id))
      .run();
  }

  /** Returns the decrypted value or null if the ref has no value stored. */
  async getValue(id: string): Promise<string | null> {
    const row = await this.db.select().from(secrets).where(eq(secrets.id, id)).get();
    if (!row || !row.valueEnc) return null;
    try {
      return this.decrypt(row.valueEnc);
    } catch {
      return null;
    }
  }

  async list(projectId: string): Promise<SecretRef[]> {
    const rows = await this.db.select().from(secrets).where(eq(secrets.projectId, projectId)).all();
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      name: r.name,
      providerRef: r.providerRef,
      purpose: r.purpose,
    }));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(secrets).where(eq(secrets.id, id)).run();
  }
}
