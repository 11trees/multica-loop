import { initializeInterventions } from "./intervention-store";
import { DatabaseSync } from "node:sqlite";
import { draftSchema, DraftConflictError, type ChainDraft, type DraftStore } from "./runtime";

/** Local kernel storage, separate from both the legacy DB and Multica's DB. */
export class SqliteDraftStore implements DraftStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    initializeInterventions(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chain_drafts (
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        payload TEXT NOT NULL
      )
    `);
  }

  async read(id: string): Promise<ChainDraft | undefined> {
    const row = this.db.prepare("SELECT payload FROM chain_drafts WHERE id = ?").get(id);
    return row ? draftSchema.parse(JSON.parse(String(row.payload))) : undefined;
  }

  async create(draft: ChainDraft): Promise<void> {
    const value = draftSchema.parse(draft);
    const result = this.db.prepare("INSERT INTO chain_drafts (id, sequence, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING")
      .run(value.id, value.sequence, JSON.stringify(value));
    if (result.changes !== 1) throw new DraftConflictError(`Draft ${value.id} already exists`);
  }

  async save(draft: ChainDraft, expectedSequence: number): Promise<void> {
    const value = draftSchema.parse(draft);
    if (value.sequence !== expectedSequence + 1) throw new DraftConflictError("Invalid draft sequence");
    const result = this.db.prepare("UPDATE chain_drafts SET sequence = ?, payload = ? WHERE id = ? AND sequence = ? AND NOT EXISTS (SELECT 1 FROM engineering_intervention WHERE workspace_id=? AND issue_id=?)")
      .run(value.sequence, JSON.stringify(value), value.id, expectedSequence, value.binding.workspaceId, value.binding.issueId);
    if (result.changes !== 1) throw new DraftConflictError("Draft changed; reload before saving");
  }

  close(): void {
    this.db.close();
  }
}
