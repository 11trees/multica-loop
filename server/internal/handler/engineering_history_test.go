package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/testutil"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestEngineeringHistoryLocalOwner(t *testing.T) {
	for _, mode := range []string{"list", "task", "document", "packet", "machine", "cloud", "foreign-user", "foreign-workspace", "disabled", "missing-worker", "changed-hash", "not-historical", "bad-offset"} {
		t.Run(mode, func(t *testing.T) {
			h := *testHandler
			h.cfg.LocalAuthEnabled = true
			h.cfg.EngineeringHistoryHash = strings.Repeat("a", 64)
			calls := 0
			h.EngineeringHistoryWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
				calls++
				if input["expected_hash"] != h.cfg.EngineeringHistoryHash {
					t.Fatal("caller selected archive hash")
				}
				if mode == "document" && (input["task_id"] != "原任务" || input["document_id"] != "原报告") {
					t.Fatal("source IDs were rewritten")
				}
				if mode == "packet" && (input["task_id"] != "原任务" || input["action"] != "packet") {
					t.Fatal("packet identity was rewritten")
				}
				hash := h.cfg.EngineeringHistoryHash
				if mode == "changed-hash" {
					hash = strings.Repeat("b", 64)
				}
				return json.Marshal(map[string]any{"historical_only": mode != "not-historical", "source": map[string]string{"hash": hash}})
			}}
			req := newRequest(http.MethodGet, "/api/engineering/history?expected_hash=caller-controlled", nil)
			req.Header.Set("X-User-ID", localUserID)
			req.Header.Set("X-Workspace-ID", localWorkspaceID)
			if mode == "machine" {
				req.Header.Set("X-Actor-Source", "task_token")
			}
			if mode == "cloud" {
				req.Header.Set("X-Actor-Source", "cloud_pat")
			}
			if mode == "foreign-user" {
				req.Header.Set("X-User-ID", testUserID)
			}
			if mode == "foreign-workspace" {
				req.Header.Set("X-Workspace-ID", testWorkspaceID)
			}
			if mode == "disabled" {
				h.cfg.LocalAuthEnabled = false
			}
			if mode == "missing-worker" {
				h.EngineeringHistoryWorker = nil
			}
			allowed := mode == "list" || mode == "task" || mode == "document" || mode == "packet" || mode == "changed-hash" || mode == "not-historical" || mode == "bad-offset"
			var available struct {
				Enabled bool `json:"enabled"`
			}
			testutil.Call(t, h.EngineeringHistoryAvailability, req).Want(http.StatusOK).JSON(&available)
			if available.Enabled != allowed || calls != 0 {
				t.Fatal("availability read private archive or crossed ownership", available, calls)
			}
			handler := h.ListEngineeringHistory
			if mode == "task" || mode == "document" {
				req = withURLParam(req, "sourceTaskID", "原任务")
				handler = h.GetEngineeringHistoryTask
			}
			if mode == "document" {
				rctx := chi.NewRouteContext()
				rctx.URLParams.Add("sourceTaskID", "原任务")
				rctx.URLParams.Add("sourceDocumentID", "原报告")
				req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
				handler = h.GetEngineeringHistoryDocument
			}
			if mode == "packet" {
				req = withURLParam(req, "sourceTaskID", "原任务")
				handler = h.GetEngineeringHistoryPacket
			}
			if mode == "bad-offset" {
				req.URL.RawQuery = "offset=-1"
			}
			want := http.StatusOK
			if !allowed {
				want = http.StatusForbidden
			}
			if mode == "changed-hash" || mode == "not-historical" {
				want = http.StatusServiceUnavailable
			}
			if mode == "bad-offset" {
				want = http.StatusBadRequest
			}
			testutil.Call(t, handler, req).Want(want)
			expected := 1
			if !allowed || mode == "bad-offset" {
				expected = 0
			}
			if calls != expected {
				t.Fatal(fmt.Sprintf("private worker calls %d, want %d", calls, expected))
			}
		})
	}
}

func TestEngineeringHistoryPrivateWorker(t *testing.T) {
	root := t.TempDir()
	repo, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	setup := `import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {pathToFileURL} from 'node:url';import {execFileSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
 const [root,repo]=process.argv.slice(1),source=join(root,'source'),data=join(source,'data'),archive=join(root,'archive');mkdirSync(data,{recursive:true});
 const git=(...args)=>execFileSync('git',['-C',source,...args],{stdio:'ignore'});git('init','-q');git('config','user.name','History fixture');git('config','user.email','fixture@example.invalid');writeFileSync(join(source,'README.md'),'Original baseline');git('add','README.md');git('commit','-qm','Fixture');
 const app=new DatabaseSync(join(data,'loopwork.db'));app.exec("CREATE TABLE app_settings(setting_key TEXT PRIMARY KEY,setting_value TEXT)");app.close();
 const db=new DatabaseSync(join(data,'loop-ui.db'));db.exec("CREATE TABLE projects(project_id TEXT PRIMARY KEY,name TEXT,workspace_root TEXT,deleted_at TEXT);INSERT INTO projects VALUES('old-project','Archived project','/original',NULL);CREATE TABLE tasks(task_id TEXT PRIMARY KEY,project_id TEXT,title TEXT,item_type TEXT,description TEXT,agile_status TEXT,run_state TEXT,closure_status TEXT,current_subagent TEXT,next_step TEXT,blocked_reason TEXT,created_at TEXT,updated_at TEXT,completed_at TEXT);INSERT INTO tasks VALUES('REQ-original','old-project','Historical original task','requirement','Original contract','ready_to_close','idle','awaiting_read',NULL,NULL,NULL,NULL,'2026-01-01',NULL);ALTER TABLE tasks ADD COLUMN workflow_engine TEXT DEFAULT 'legacy';CREATE TABLE documents(document_id TEXT PRIMARY KEY,task_id TEXT,title TEXT,kind TEXT,content TEXT,format TEXT,source_agent TEXT,revision INTEGER,created_at TEXT,updated_at TEXT);INSERT INTO documents VALUES('DOC-original','REQ-original','Original report','review','Exact original evidence','markdown','review-agent',1,NULL,NULL)");db.close();
 const {createArchive}=await import(pathToFileURL(join(repo,'scripts/migration/loopwork-history-lib.mjs')));console.log(JSON.stringify(await createArchive({sourceRoot:source,dataRoot:data,output:archive})));`
	raw, err := exec.Command("node", "--input-type=module", "-e", setup, root, repo).Output()
	if err != nil {
		t.Fatalf("archive fixture: %v %s", err, raw)
	}
	var capture struct {
		Archive string `json:"archive"`
		Hash    string `json:"hash"`
	}
	if err = json.Unmarshal(raw, &capture); err != nil {
		t.Fatal(err, string(raw))
	}
	before, err := os.ReadFile(filepath.Join(capture.Archive, "loop-ui.db"))
	if err != nil {
		t.Fatal(err)
	}
	h := *testHandler
	h.cfg.LocalAuthEnabled = true
	h.cfg.EngineeringHistoryHash = capture.Hash
	h.EngineeringHistoryWorker = &engineering.Client{Worker: filepath.Join(repo, "packages/command-chain/dist/worker.mjs"), Database: capture.Archive, History: true}
	request := func() *http.Request {
		r := newRequest(http.MethodGet, "/api/engineering/history", nil)
		r.Header.Set("X-User-ID", localUserID)
		r.Header.Set("X-Workspace-ID", localWorkspaceID)
		return r
	}
	var list struct {
		Total int `json:"total"`
		Tasks []struct {
			ID string `json:"id"`
		} `json:"tasks"`
	}
	testutil.Call(t, h.ListEngineeringHistory, request()).Want(http.StatusOK).JSON(&list)
	if list.Total != 1 || len(list.Tasks) != 1 || list.Tasks[0].ID != "REQ-original" {
		t.Fatal("wrong original task", list)
	}
	r := request()
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("sourceTaskID", "REQ-original")
	rctx.URLParams.Add("sourceDocumentID", "DOC-original")
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
	var document struct {
		Document struct {
			Content string `json:"content"`
		} `json:"document"`
	}
	testutil.Call(t, h.GetEngineeringHistoryDocument, r).Want(http.StatusOK).JSON(&document)
	if document.Document.Content != "Exact original evidence" {
		t.Fatal("original evidence changed")
	}
	var packet struct {
		Packet struct {
			Format       string `json:"format"`
			Hash         string `json:"hash"`
			SourceTaskID string `json:"source_task_id"`
			Ownership    struct {
				NativeExecutionAuthorized bool `json:"native_execution_authorized"`
			} `json:"ownership"`
		} `json:"packet"`
	}
	testutil.Call(t, h.GetEngineeringHistoryPacket, r).Want(http.StatusOK).JSON(&packet)
	if packet.Packet.Format != "loopwork-task-handoff-v1" || len(packet.Packet.Hash) != 64 || packet.Packet.SourceTaskID != "REQ-original" || packet.Packet.Ownership.NativeExecutionAuthorized {
		t.Fatal("packet changed source ownership or identity", packet)
	}
	for _, actor := range []string{"task_token", "cloud_pat"} {
		denied := r.Clone(r.Context())
		denied.Header.Set("X-Actor-Source", actor)
		testutil.Call(t, h.GetEngineeringHistoryPacket, denied).Want(http.StatusForbidden)
	}
	if _, err = h.EngineeringHistoryWorker.Call(context.Background(), map[string]any{"action": "direct-run", "expected_hash": capture.Hash}); err == nil {
		t.Fatal("history worker accepted an execution command")
	}
	after, err := os.ReadFile(filepath.Join(capture.Archive, "loop-ui.db"))
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("historical read changed archive bytes", err)
	}
}
