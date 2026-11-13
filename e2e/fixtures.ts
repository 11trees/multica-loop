/**
 * TestApiClient — lightweight API helper for E2E test data setup/teardown.
 *
 * Uses raw fetch so E2E tests have zero build-time coupling to the web app.
 */

import "./env";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

// `||` (not `??`) so an empty `NEXT_PUBLIC_API_URL=` in .env still falls
// back to localhost. dotenv sets unset-vs-empty both as "" — treating them
// the same matches user intent.
const API_BASE = process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT || "8080"}`;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://multica:multica@localhost:5432/multica?sslmode=disable";

interface TestWorkspace {
  id: string;
  name: string;
  slug: string;
}

export type TestIssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled";

export type TestIssuePriority = "urgent" | "high" | "medium" | "low" | "none";

export interface TestTableIssueSeed {
  title: string;
  status?: TestIssueStatus;
  priority?: TestIssuePriority;
  parentIssueId?: string | null;
  position?: number;
}

export interface TestTableIssue {
  id: string;
  title: string;
  status: TestIssueStatus;
  number: number;
}

export class TestApiClient {
  private token: string | null = null;
  private workspaceSlug: string | null = null;
  private workspaceId: string | null = null;
  private email: string | null = null;
  private createdIssueIds: string[] = [];
  private createdProjectIds: string[] = [];
  private seededIssueIds: string[] = [];
  private createdPropertyIds: string[] = [];
  private engineeringRuns: { taskId: string; agentId: string; runtimeId: string }[] = [];

  async loginLocally() {
    const response = await fetch(`${API_BASE}/auth/local`, { method: "POST" });
    if (!response.ok) throw new Error(`local login failed: ${response.status}`);
    const data = await response.json();
    this.token = data.token;
    this.email = data.user.email;
    return data;
  }

  async login(email: string, name: string) {
    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      // Keep each E2E login isolated so previous test runs do not trip the
      // per-email send-code rate limit.
      await client.query("DELETE FROM verification_code WHERE email = $1", [email]);

      // Step 1: Send verification code
      const sendRes = await fetch(`${API_BASE}/auth/send-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!sendRes.ok) {
        throw new Error(`send-code failed: ${sendRes.status}`);
      }

      // Step 2: Read code from database
      const result = await client.query(
        "SELECT code FROM verification_code WHERE email = $1 AND used = FALSE AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
        [email],
      );
      if (result.rows.length === 0) {
        throw new Error(`No verification code found for ${email}`);
      }

      const configuredDevCode = process.env.MULTICA_DEV_VERIFICATION_CODE?.trim();
      const code = configuredDevCode || result.rows[0].code;

      // Step 3: Verify code to get JWT
      const verifyRes = await fetch(`${API_BASE}/auth/verify-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      if (!verifyRes.ok) {
        throw new Error(`verify-code failed: ${verifyRes.status}`);
      }
      const data = await verifyRes.json();

      this.token = data.token;
      this.email = email;

      // Update user name if needed
      if (name && data.user?.name !== name) {
        await this.authedFetch("/api/me", {
          method: "PATCH",
          body: JSON.stringify({ name }),
        });
      }

      await client.query("DELETE FROM verification_code WHERE email = $1", [email]);

      return data;
    } finally {
      await client.end();
    }
  }

  async getWorkspaces(): Promise<TestWorkspace[]> {
    const res = await this.authedFetch("/api/workspaces");
    return res.json();
  }

  setWorkspaceId(id: string) {
    this.workspaceId = id;
  }

  setWorkspaceSlug(slug: string) {
    this.workspaceSlug = slug;
  }

  async ensureWorkspace(name = "E2E Workspace", slug = "e2e-workspace") {
    const workspaces = await this.getWorkspaces();
    const workspace = workspaces.find((item) => item.slug === slug) ?? workspaces[0];
    if (workspace) {
      this.workspaceId = workspace.id;
      this.workspaceSlug = workspace.slug;
      return workspace;
    }

    const res = await this.authedFetch("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name, slug }),
    });
    if (res.ok) {
      const created = (await res.json()) as TestWorkspace;
      this.workspaceId = created.id;
      this.workspaceSlug = created.slug;
      return created;
    }

    const refreshed = await this.getWorkspaces();
    const created = refreshed.find((item) => item.slug === slug) ?? refreshed[0];
    if (created) {
      this.workspaceId = created.id;
      this.workspaceSlug = created.slug;
      return created;
    }

    throw new Error(`Failed to ensure workspace ${slug}: ${res.status} ${res.statusText}`);
  }

  async markUserOnboarded() {
    if (!this.email) {
      throw new Error("Cannot mark E2E user onboarded before login");
    }

    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      const result = await client.query(
        `
          UPDATE "user"
          SET
            onboarded_at = COALESCE(onboarded_at, now()),
            onboarding_questionnaire = COALESCE(onboarding_questionnaire, '{}'::jsonb)
              || '{"source":["friends_colleagues"],"source_other":null,"source_skipped":false}'::jsonb
          WHERE email = $1
        `,
        [this.email],
      );
      if (result.rowCount !== 1) {
        throw new Error(`Failed to mark E2E user onboarded: ${this.email}`);
      }
    } finally {
      await client.end();
    }
  }

  /** Create a project and register it for cleanup. */
  async createProject(title: string, opts?: Record<string, unknown>) {
    const res = await this.authedFetch("/api/projects", {
      method: "POST",
      body: JSON.stringify({ title, ...opts }),
    });
    if (!res.ok) {
      throw new Error(`create project failed: ${res.status} ${await res.text()}`);
    }
    const project = await res.json();
    this.createdProjectIds.push(project.id);
    return project as { id: string; title: string; status: string };
  }

  /** Create a workspace custom property definition; archived on cleanup. */
  async createProperty(name: string, type = "text", config?: { options: { name: string; color: string }[] }) {
    const res = await this.authedFetch("/api/properties", {
      method: "POST",
      body: JSON.stringify({ name, type, config }),
    });
    if (!res.ok) {
      throw new Error(`create property failed: ${res.status} ${await res.text()}`);
    }
    const property = await res.json();
    this.createdPropertyIds.push(property.id);
    return property as { id: string; name: string; config: { options?: { id: string; name: string; color: string }[] } };
  }

  async updateProject(id: string, updates: Record<string, unknown>) {
    const res = await this.authedFetch(`/api/projects/${id}`, {
      method: "PUT",
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      throw new Error(`update project failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  async deleteProject(id: string) {
    await this.authedFetch(`/api/projects/${id}`, { method: "DELETE" });
  }

  async createIssue(title: string, opts?: Record<string, unknown>) {
    const res = await this.authedFetch("/api/issues", {
      method: "POST",
      body: JSON.stringify({ title, ...opts }),
    });
    const issue = await res.json();
    this.createdIssueIds.push(issue.id);
    return issue;
  }

  /** Seeds a running task credential; never starts a daemon, model, or agent CLI. */
  async seedEngineeringRun(existingIssueId?: string) {
    if (!this.workspaceId || !this.email || !process.env.DATABASE_URL) throw new Error("Engineering fixtures require the managed workspace/database");
    if (existingIssueId && !this.createdIssueIds.includes(existingIssueId)) throw new Error("Not an owned engineering fixture issue");
    const issue = existingIssueId ? { id: existingIssueId } : await this.createIssue(`Engineering integration ${randomUUID()}`);
    const runtimeId = randomUUID(), agentId = randomUUID(), taskId = randomUUID();
    const taskToken = `mat_e2e_${randomUUID()}`;
    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [this.email]);
      const userId = owner.rows[0]?.id;
      if (!userId) throw new Error("Engineering fixture owner is missing");
      await client.query(`INSERT INTO agent_runtime (id, workspace_id, name, runtime_mode, provider, status, owner_id, last_seen_at, daemon_id)
        VALUES ($1, $2, 'Engineering fixture', 'local', 'missing-engineering-test-executor', 'online', $3, now(), $4)`, [runtimeId, this.workspaceId, userId, `engineering-fixture-${runtimeId}`]);
      await client.query(`INSERT INTO agent (id, workspace_id, name, description, runtime_mode, runtime_id, owner_id)
        VALUES ($1, $2, $5, '', 'local', $3, $4)`, [agentId, this.workspaceId, runtimeId, userId, `Engineering fixture ${agentId}`]);
      await client.query(`INSERT INTO agent_task_queue (id, agent_id, issue_id, runtime_id, status, attempt, dispatched_at, started_at)
        VALUES ($1, $2, $3, $4, 'running', 1, now() - interval '1 second', now())`, [taskId, agentId, issue.id, runtimeId]);
      await client.query(`INSERT INTO task_token (token_hash, task_id, agent_id, workspace_id, user_id, expires_at)
        VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour')`, [createHash("sha256").update(taskToken).digest("hex"), taskId, agentId, this.workspaceId, userId]);
      await client.query("COMMIT");
      this.engineeringRuns.push({ taskId, agentId, runtimeId });
      return { taskId, agentId, runtimeId, issueId: issue.id as string, userId, workspaceId: this.workspaceId, taskToken, apiBase: API_BASE };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.end();
    }
  }

  /** Simulates a new claim for a fixture task so old-credential fencing is exercised. */
  async reclaimEngineeringRun(taskId: string) {
    if (!this.engineeringRuns.some(run => run.taskId === taskId)) throw new Error("Not an owned engineering fixture");
    const taskToken = `mat_e2e_${randomUUID()}`;
    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE agent_task_queue SET dispatched_at = now(), started_at = now(), attempt = attempt + 1 WHERE id = $1`, [taskId]);
      await client.query(`INSERT INTO task_token (token_hash, task_id, agent_id, workspace_id, user_id, expires_at)
        SELECT $1, task_id, agent_id, workspace_id, user_id, now() + interval '1 hour'
        FROM task_token WHERE task_id = $2 ORDER BY created_at DESC LIMIT 1`, [createHash("sha256").update(taskToken).digest("hex"), taskId]);
      await client.query("COMMIT");
      return taskToken;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.end();
    }
  }

  async queuedEngineeringRun(issueId: string, agentId: string): Promise<string | null> {
    if (!this.createdIssueIds.includes(issueId) || !this.engineeringRuns.some(run => run.agentId === agentId)) throw new Error("Not an owned engineering fixture");
    const client = new pg.Client(DATABASE_URL); await client.connect();
    try {
      const result = await client.query<{id:string}>("SELECT id FROM agent_task_queue WHERE issue_id=$1 AND agent_id=$2 AND status='queued' ORDER BY created_at DESC LIMIT 1", [issueId,agentId]);
      return result.rows[0]?.id ?? null;
    } finally { await client.end(); }
  }

  async finishEngineeringRun(taskId: string) {
    if (!this.engineeringRuns.some(run => run.taskId === taskId)) throw new Error("Not an owned engineering fixture");
    const client = new pg.Client(DATABASE_URL); await client.connect();
    try { await client.query("UPDATE agent_task_queue SET status = 'completed', completed_at = now() WHERE id = $1", [taskId]); }
    finally { await client.end(); }
  }

  async attachEngineeringProject(taskId: string, projectId: string, repository: string) {
    const run = this.engineeringRuns.find(value => value.taskId === taskId);
    if (!run || !this.createdProjectIds.includes(projectId)) throw new Error("Not an owned engineering fixture project");
    const client = new pg.Client(DATABASE_URL); await client.connect();
    let issueId: string;
    try {
      const result = await client.query<{ issue_id:string; daemon_id:string }>(`SELECT q.issue_id,r.daemon_id FROM agent_task_queue q JOIN agent_runtime r ON r.id=q.runtime_id WHERE q.id=$1`, [taskId]);
      const row = result.rows[0]; if (!row || !this.createdIssueIds.includes(row.issue_id)) throw new Error("Fixture issue missing");
      issueId = row.issue_id;
      await client.query(`INSERT INTO project_resource (project_id,workspace_id,resource_type,resource_ref,position) VALUES ($1,$2,'local_directory',$3,0)`, [projectId,this.workspaceId,JSON.stringify({ local_path:repository,daemon_id:row.daemon_id,execution_mode:"in_place" })]);
    } finally { await client.end(); }
    await this.updateIssue(issueId!, { project_id: projectId, suppress_run: true });
  }

  /** Claims only a queued run of an agent created by this fixture; never launches a provider. */
  async claimEngineeringRun(taskId: string) {
    if (!this.engineeringRuns.length || !this.workspaceId || !this.email) throw new Error("No owned engineering fixture");
    const client = new pg.Client(DATABASE_URL); await client.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string; agent_id: string; runtime_id: string; issue_id: string }>(`UPDATE agent_task_queue SET status='running', attempt=1, dispatched_at=now(), started_at=now() WHERE id=$1 AND agent_id=ANY($2::uuid[]) AND status='queued' RETURNING id,agent_id,runtime_id,issue_id`, [taskId, this.engineeringRuns.map(run => run.agentId)]);
      const run = result.rows[0]; if (!run || !this.createdIssueIds.includes(run.issue_id)) throw new Error("Not an owned queued engineering fixture");
      const owner = await client.query<{id:string}>(`SELECT id FROM "user" WHERE email=$1`, [this.email]);
      const userId = owner.rows[0]?.id; if (!userId) throw new Error("Fixture owner missing");
      const taskToken = `mat_e2e_${randomUUID()}`;
      await client.query(`INSERT INTO task_token (token_hash,task_id,agent_id,workspace_id,user_id,expires_at) VALUES ($1,$2,$3,$4,$5,now()+interval '1 hour')`, [createHash("sha256").update(taskToken).digest("hex"), taskId, run.agent_id, this.workspaceId, userId]);
      await client.query("COMMIT");
      this.engineeringRuns.push({ taskId, agentId: run.agent_id, runtimeId: run.runtime_id });
      return { taskId, agentId: run.agent_id, runtimeId: run.runtime_id, issueId: run.issue_id, userId, workspaceId: this.workspaceId, taskToken, apiBase: API_BASE };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { await client.end(); }
  }

  async engineeringVerification(issueId: string, action: "configure" | "inspect" | "answer" | "abandon", payload?: unknown) {
    const suffix = action === "answer" ? "answers" : action === "abandon" ? "abandon" : "";
    const response = await this.authedFetch(`/api/issues/${issueId}/engineering/verification/${suffix}`, action === "inspect" ? undefined : { method: "POST", body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`engineering ${action} failed: ${response.status} ${await response.text()}`);
    return response.json();
  }

  async captureEngineeringReceipt(taskId: string, receipt: unknown) {
    return this.engineeringRuntimeRequest(taskId, "engineering-receipts", receipt);
  }

  async bindEngineeringRepository(taskId: string, workDir: string, mode: "in_place" | "worktree" = "in_place", overlays: { path: string; hash: string }[] = []) {
    return this.engineeringRuntimeRequest(taskId, "engineering-repository", { work_dir: workDir, mode, overlays });
  }

  private async engineeringRuntimeRequest(taskId: string, operation: string, payload: unknown) {
    if (!this.engineeringRuns.some(run => run.taskId === taskId)) throw new Error("Not an owned engineering fixture");
    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      const row = await client.query(`SELECT to_char(dispatched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS generation FROM agent_task_queue WHERE id = $1`, [taskId]);
      const result = await this.authedFetch(`/api/daemon/tasks/${taskId}/${operation}`, { method: "POST", body: JSON.stringify({ dispatched_at: row.rows[0].generation, ...payload as object }) });
      if (!result.ok) throw new Error(`${operation} failed: ${result.status} ${await result.text()}`);
      return result.json();
    } finally { await client.end(); }
  }

  /**
   * Insert a large, deterministic issue fixture in one transaction.
   *
   * Browser E2E coverage for cursor-backed Table views needs 1,000+ rows,
   * which would make setup itself dominate the test if every row went through
   * the HTTP create endpoint. These rows intentionally contain no dependent
   * records; cleanup deletes exactly the returned IDs from the isolated E2E
   * workspace.
   */
  async seedTableIssues(rows: TestTableIssueSeed[]): Promise<TestTableIssue[]> {
    if (rows.length === 0) return [];
    if (!this.workspaceId || !this.email) {
      throw new Error("Cannot seed table issues before login and workspace setup");
    }

    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      await client.query("BEGIN");
      const userResult = await client.query<{ id: string }>(
        `SELECT id FROM "user" WHERE email = $1`,
        [this.email],
      );
      const creatorId = userResult.rows[0]?.id;
      if (!creatorId) {
        throw new Error(`Cannot resolve E2E creator for ${this.email}`);
      }

      const counterResult = await client.query<{ issue_counter: number }>(
        `
          UPDATE workspace
          SET issue_counter = issue_counter + $2
          WHERE id = $1
          RETURNING issue_counter
        `,
        [this.workspaceId, rows.length],
      );
      const finalCounter = Number(counterResult.rows[0]?.issue_counter);
      if (!Number.isFinite(finalCounter)) {
        throw new Error(`Cannot reserve issue numbers for workspace ${this.workspaceId}`);
      }
      const firstNumber = finalCounter - rows.length + 1;

      const inserted = await client.query<TestTableIssue>(
        `
          INSERT INTO issue (
            workspace_id,
            title,
            status,
            priority,
            creator_type,
            creator_id,
            parent_issue_id,
            position,
            number
          )
          SELECT
            $1::uuid,
            fixture.title,
            fixture.status,
            fixture.priority,
            'member',
            $2::uuid,
            fixture.parent_issue_id,
            fixture.position,
            fixture.number
          FROM unnest(
            $3::text[],
            $4::text[],
            $5::text[],
            $6::uuid[],
            $7::double precision[],
            $8::integer[]
          ) WITH ORDINALITY AS fixture(
            title,
            status,
            priority,
            parent_issue_id,
            position,
            number,
            ordinal
          )
          ORDER BY fixture.ordinal
          RETURNING id, title, status, number
        `,
        [
          this.workspaceId,
          creatorId,
          rows.map((row) => row.title),
          rows.map((row) => row.status ?? "backlog"),
          rows.map((row) => row.priority ?? "none"),
          rows.map((row) => row.parentIssueId ?? null),
          rows.map((row, index) => row.position ?? index + 1),
          rows.map((_row, index) => firstNumber + index),
        ],
      );
      await client.query("COMMIT");
      this.seededIssueIds.push(...inserted.rows.map((row) => row.id));
      return inserted.rows;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.end();
    }
  }

  async deleteIssue(id: string) {
    await this.authedFetch(`/api/issues/${id}`, { method: "DELETE" });
  }

  async createComment(issueId: string, content: string) {
    const res = await this.authedFetch(`/api/issues/${issueId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      throw new Error(`create comment failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as { id: string };
  }

  /** Seed an owned runtime without launching an actual agent tool. */
  async seedRuntime(name: string): Promise<string> {
    if (!this.workspaceId || !this.email) throw new Error("Select a workspace before seeding a runtime");
    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      const result = await client.query(
        `INSERT INTO agent_runtime (workspace_id, name, runtime_mode, provider, status, owner_id, last_seen_at)
         SELECT $1, $2, 'local', 'claude', 'online', id, now() FROM "user" WHERE email = $3 RETURNING id`,
        [this.workspaceId, name, this.email],
      );
      return result.rows[0].id as string;
    } finally {
      await client.end();
    }
  }

  /** Adds an existing user to this client's workspace and returns the member id. */
  async addMemberByEmail(email: string, role: "admin" | "member" = "member"): Promise<string> {
    if (!this.workspaceId) throw new Error("Cannot add a member before a workspace is selected");
    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      const result = await client.query(
        `INSERT INTO member (workspace_id, user_id, role)
         SELECT $1, id, $3 FROM "user" WHERE email = $2
         RETURNING id`,
        [this.workspaceId, email, role],
      );
      if (result.rowCount !== 1) throw new Error(`No user with email ${email}`);
      return result.rows[0].id as string;
    } finally {
      await client.end();
    }
  }

  async removeMember(memberId: string) {
    const res = await this.authedFetch(`/api/workspaces/${this.workspaceId}/members/${memberId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      throw new Error(`remove member failed: ${res.status} ${await res.text()}`);
    }
  }

  /** Deletes this client's workspace; only for workspaces a test created. */
  async deleteWorkspace() {
    if (!this.workspaceId) return;
    await this.authedFetch(`/api/workspaces/${this.workspaceId}`, { method: "DELETE" });
  }

  /** Server-side issue search, for comparing against what the UI shows. */
  async searchIssues(q: string, opts: { includeClosed?: boolean; limit?: number } = {}) {
    const params = new URLSearchParams({ q, limit: String(opts.limit ?? 20) });
    if (opts.includeClosed) params.set("include_closed", "true");
    const res = await this.authedFetch(`/api/issues/search?${params}`);
    if (!res.ok) {
      throw new Error(`search issues failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as { issues: { id: string; identifier: string; title: string }[] };
  }

  async updateIssue(id: string, updates: Record<string, unknown>) {
    const res = await this.authedFetch(`/api/issues/${id}`, {
      method: "PUT",
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      throw new Error(`update issue failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  async publishEngineeringUnits(parentId:string,payload:unknown){
    if(!this.createdIssueIds.includes(parentId))throw new Error("Not an owned requirement fixture");const response=await this.authedFetch(`/api/issues/${parentId}/engineering/publication`,{method:"POST",body:JSON.stringify(payload)});if(!response.ok)throw new Error(`Publication failed: ${response.status} ${await response.text()}`);return response.json();
  }

  async getOwnedEngineeringIssue(issueId:string){
    if(!this.createdIssueIds.includes(issueId))throw new Error("Not an owned engineering fixture");const response=await this.authedFetch(`/api/issues/${issueId}`);if(!response.ok)throw new Error("Unable to read owned engineering issue");return response.json();
  }

  async engineeringOverview(issueId:string){
    if(!this.createdIssueIds.includes(issueId))throw new Error("Not an owned engineering fixture");
    const response=await this.authedFetch(`/api/issues/${issueId}/engineering`);
    if(!response.ok)throw new Error(`Engineering overview failed: ${response.status}`);
    return response.json();
  }

  async publishedEngineeringIssues(parentId:string){
    if(!this.createdIssueIds.includes(parentId) || !process.env.MULTICA_ENGINEERING_DATABASE)throw new Error("Not an owned requirement fixture");
    const {DatabaseSync}=await import("node:sqlite"),database=new DatabaseSync(process.env.MULTICA_ENGINEERING_DATABASE);let ids:string[];
    try{ids=database.prepare("SELECT issue_id FROM requirement_unit WHERE workspace_id=? AND parent_issue_id=?").all(this.workspaceId,parentId).map(row=>String(row.issue_id));}finally{database.close();}
    const response=await this.authedFetch(`/api/issues/${parentId}/children`);if(!response.ok)throw new Error("Unable to read native child issues");
    const body=await response.json() as {issues:{id:string;title:string;status:string;parent_issue_id:string;assignee_id:string|null;metadata:Record<string,unknown>}[]};
    const issues=body.issues.filter(issue=>ids.includes(issue.id) && issue.parent_issue_id === parentId);
    for(const issue of issues)if(!this.createdIssueIds.includes(issue.id))this.createdIssueIds.push(issue.id);
    return issues;
  }

  /** Clean up all issues created during this test. */
  async cleanup() {
    if (process.env.MULTICA_ENGINEERING_DATABASE && this.createdIssueIds.length && this.workspaceId) {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new DatabaseSync(process.env.MULTICA_ENGINEERING_DATABASE);
      try {
        if(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='engineering_feedback_batch'").get())for(const issueId of this.createdIssueIds){
          for(const row of database.prepare("SELECT payload FROM engineering_feedback_batch WHERE workspace_id=? AND issue_id=?").all(this.workspaceId,issueId)){const batch=JSON.parse(String(row.payload));const ids=[batch.triageDraftId,...batch.groups.flatMap((group:{verifications:Record<string,{draftId:string}>})=>Object.values(group.verifications).map(item=>item.draftId))];for(const id of ids)database.prepare("DELETE FROM chain_drafts WHERE id=?").run(id);}
          for(const table of ["engineering_feedback_comment","engineering_feedback_batch"])database.prepare(`DELETE FROM ${table} WHERE workspace_id=? AND issue_id=?`).run(this.workspaceId,issueId);
        }
        if(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='requirement_contract'").get())for(const issueId of this.createdIssueIds){
          const rows=database.prepare("SELECT payload FROM requirement_contract WHERE workspace_id=? AND issue_id=?").all(this.workspaceId,issueId);
          for(const row of rows){const record=JSON.parse(String(row.payload));for(const id of [record.contextDraftId,record.planDraftId,...(record.reproduction ? [record.reproduction.draftId] : []),...(record.reviews ?? []).map((review:{draftId:string})=>review.draftId),...(record.feedbackWork ?? []).flatMap((work:{groups:{draftId:string;reproduction?:{draftId:string}}[]})=>work.groups.flatMap(group=>[group.draftId,...(group.reproduction ? [group.reproduction.draftId] : [])]))])database.prepare("DELETE FROM chain_drafts WHERE id=?").run(id);}
          database.prepare("DELETE FROM requirement_unit WHERE workspace_id=? AND (issue_id=? OR parent_issue_id=?)").run(this.workspaceId,issueId,issueId);
          for(const table of ["requirement_execution","requirement_acceptance","requirement_contract"])database.prepare(`DELETE FROM ${table} WHERE workspace_id=? AND issue_id=?`).run(this.workspaceId,issueId);
        }
        if (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'engineering_contract'").get()) for (const issueId of this.createdIssueIds) {
          const rows = database.prepare("SELECT payload FROM engineering_contract WHERE workspace_id = ? AND issue_id = ?").all(this.workspaceId, issueId);
          for (const row of rows) database.prepare("DELETE FROM chain_drafts WHERE id = ?").run(JSON.parse(String(row.payload)).draftId);
          if (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'engineering_execution'").get()) database.prepare("DELETE FROM engineering_execution WHERE workspace_id = ? AND issue_id = ?").run(this.workspaceId, issueId);
          for (const row of rows) {
            const record = JSON.parse(String(row.payload));
            if(record.analysis) database.prepare("DELETE FROM chain_drafts WHERE id = ?").run(record.analysis.draftId);
            const development = record.development;
            if (development) {
              database.prepare("DELETE FROM engineering_receipt WHERE draft_id = ?").run(development.draftId);
              database.prepare("DELETE FROM chain_drafts WHERE id = ?").run(development.draftId);
            }
          }
          database.prepare("DELETE FROM engineering_contract WHERE workspace_id = ? AND issue_id = ?").run(this.workspaceId, issueId);
        }
      } finally { database.close(); }
    }
    if (this.engineeringRuns.length) {
      const client = new pg.Client(DATABASE_URL);
      await client.connect();
      try {
        await client.query("BEGIN");
        for (const run of this.engineeringRuns) {
          await client.query("DELETE FROM task_token WHERE agent_id = $1", [run.agentId]);
          await client.query("DELETE FROM agent_task_queue WHERE agent_id = $1", [run.agentId]);
          await client.query("DELETE FROM agent WHERE id = $1", [run.agentId]);
          await client.query("DELETE FROM agent_runtime WHERE id = $1", [run.runtimeId]);
        }
        await client.query("COMMIT");
        this.engineeringRuns = [];
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        await client.end();
      }
    }
    if (this.seededIssueIds.length > 0 && this.workspaceId) {
      const client = new pg.Client(DATABASE_URL);
      await client.connect();
      try {
        await client.query(
          `DELETE FROM issue WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
          [this.workspaceId, this.seededIssueIds],
        );
      } finally {
        await client.end();
      }
      this.seededIssueIds = [];
    }
    for (const id of this.createdIssueIds) {
      try {
        await this.deleteIssue(id);
      } catch {
        /* ignore — may already be deleted */
      }
    }
    this.createdIssueIds = [];
    // Projects last: an issue delete leaves no project reference behind, and
    // dropping the project first would strand the issues in the list.
    for (const id of this.createdProjectIds) {
      try {
        await this.deleteProject(id);
      } catch {
        /* ignore — may already be deleted */
      }
    }
    this.createdProjectIds = [];
    // Definitions cannot be deleted, only archived; archiving takes them out
    // of every picker so later tests see the catalog they expect.
    for (const id of this.createdPropertyIds) {
      try {
        await this.authedFetch(`/api/properties/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ archived: true }),
        });
      } catch {
        /* ignore */
      }
    }
    this.createdPropertyIds = [];
  }

  getToken() {
    return this.token;
  }

  getEmail() {
    if (!this.email) {
      throw new Error("Test API client is not logged in");
    }
    return this.email;
  }

  private async authedFetch(path: string, init?: RequestInit) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    if (this.workspaceSlug) headers["X-Workspace-Slug"] = this.workspaceSlug;
    else if (this.workspaceId) headers["X-Workspace-ID"] = this.workspaceId;
    return fetch(`${API_BASE}${path}`, { ...init, headers });
  }
}
