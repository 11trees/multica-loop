package handler

import (
	"context"
	"encoding/json"
	"github.com/multica-ai/multica/server/internal/engineering"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestEngineeringSupplementLocalHumanScope(t *testing.T) {
	for _, mode := range []string{"catalog", "tasks", "task", "document", "file", "machine", "foreign-user", "foreign-workspace", "disabled", "missing-worker", "changed-hash", "execution", "bad-range"} {
		t.Run(mode, func(t *testing.T) {
			h := *testHandler
			h.cfg.LocalAuthEnabled = true
			h.cfg.EngineeringHistoryHash = strings.Repeat("a", 64)
			h.cfg.EngineeringHistorySupplementHash = strings.Repeat("b", 64)
			h.EngineeringHistoryWorker = engineeringAdminTestWorker{}
			calls := 0
			h.EngineeringSupplementWorker = engineeringAdminTestWorker{call: func(input map[string]any) (json.RawMessage, error) {
				calls++
				if input["expected_hash"] != h.cfg.EngineeringHistorySupplementHash || input["expected_archive_hash"] != h.cfg.EngineeringHistoryHash || input["path"] != nil {
					t.Error("caller controlled supplementary source")
				}
				hash := h.cfg.EngineeringHistorySupplementHash
				if mode == "changed-hash" {
					hash = strings.Repeat("d", 64)
				}
				return json.Marshal(map[string]any{"historical_only": true, "execution_authorized": mode == "execution", "archive_hash": h.cfg.EngineeringHistoryHash, "hash": hash})
			}}
			r := newRequest(http.MethodGet, "/history/supplement?expected_hash=caller&path=/caller/private", nil)
			r.Header.Set("X-User-ID", localUserID)
			r.Header.Set("X-Workspace-ID", localWorkspaceID)
			r = withURLParam(r, "databaseID", strings.Repeat("c", 64))
			handler := h.GetEngineeringSupplementCatalog
			switch mode {
			case "tasks":
				handler = h.ListEngineeringSupplementTasks
			case "task":
				handler = h.GetEngineeringSupplementTask
				chi.RouteContext(r.Context()).URLParams.Add("sourceTaskID", "原任务")
			case "document":
				handler = h.GetEngineeringSupplementDocument
			case "file", "bad-range":
				handler = h.GetEngineeringSupplementFile
				r = withURLParam(r, "fileID", strings.Repeat("e", 64))
			}
			want := 200
			switch mode {
			case "machine":
				r.Header.Set("X-Actor-Source", "task_token")
				want = 403
			case "foreign-user":
				r.Header.Set("X-User-ID", testUserID)
				want = 403
			case "foreign-workspace":
				r.Header.Set("X-Workspace-ID", testWorkspaceID)
				want = 403
			case "disabled":
				h.cfg.LocalAuthEnabled = false
				want = 403
			case "missing-worker":
				h.EngineeringSupplementWorker = nil
				want = 403
			case "changed-hash", "execution":
				want = 503
			case "bad-range":
				r.URL.RawQuery = "length=1048577"
				want = 400
			}
			testutil.Call(t, handler, r).Want(want)
			expected := 1
			if want == 403 || want == 400 {
				expected = 0
			}
			if calls != expected {
				t.Fatal("unauthorized or malformed request read private material", calls)
			}
		})
	}
}

func TestEngineeringSupplementPrivateWorker(t *testing.T) {
	root := t.TempDir()
	repo, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	setup := `import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {pathToFileURL} from 'node:url';import {DatabaseSync} from 'node:sqlite';
 const [root,repo]=process.argv.slice(1);process.env.TMPDIR=root;
 const {cutoverFixture}=await import(pathToFileURL(join(repo,'scripts/migration/loopwork-cutover-fixture.mjs')));const f=await cutoverFixture({after(){}});mkdirSync(join(f.dataRoot,'old'));const db=new DatabaseSync(join(f.dataRoot,'old/loop-ui.db'));db.exec("CREATE TABLE tasks(task_id TEXT PRIMARY KEY,title TEXT);INSERT INTO tasks VALUES('same-task','Retained secondary goal');CREATE TABLE documents(document_id TEXT PRIMARY KEY,task_id TEXT,content TEXT);INSERT INTO documents VALUES('doc','same-task','Exact old document')");db.close();mkdirSync(join(f.dataRoot,'admin'));writeFileSync(join(f.dataRoot,'admin/host.log'),Buffer.from([0,1,255,2]));
 const {createArchive}=await import(pathToFileURL(join(repo,'scripts/migration/loopwork-history-lib.mjs')));const primary=await createArchive({sourceRoot:f.sourceRoot,dataRoot:f.dataRoot,output:join(root,'primary')});
 const {captureHistorySupplement}=await import(pathToFileURL(join(repo,'scripts/migration/loopwork-history-supplement.mjs')));const supplement=await captureHistorySupplement({archive:primary.archive,expectedHash:primary.hash,output:join(root,'supplement')});for(const db of Object.values(f.dbs))db.close();console.log(JSON.stringify({primary,supplement}));`
	raw, err := exec.Command("node", "--input-type=module", "-e", setup, root, repo).Output()
	if err != nil {
		t.Fatal("supplement fixture failed", err, string(raw))
	}
	var captures struct {
		Primary    struct{ Hash string }
		Supplement struct {
			Hash       string
			Supplement string
		}
	}
	if json.Unmarshal(raw, &captures) != nil {
		t.Fatal("invalid fixture")
	}
	h := *testHandler
	h.cfg.LocalAuthEnabled = true
	h.cfg.EngineeringHistoryHash = captures.Primary.Hash
	h.cfg.EngineeringHistorySupplementHash = captures.Supplement.Hash
	h.EngineeringHistoryWorker = engineeringAdminTestWorker{}
	h.EngineeringSupplementWorker = &engineering.Client{Worker: filepath.Join(repo, "packages/command-chain/dist/worker.mjs"), Database: captures.Supplement.Supplement, HistorySupplement: true}
	request := func() *http.Request {
		r := newRequest(http.MethodGet, "/history/supplement", nil)
		r.Header.Set("X-User-ID", localUserID)
		r.Header.Set("X-Workspace-ID", localWorkspaceID)
		return r
	}
	var catalog struct {
		Databases []struct {
			ID   string
			Path string
		}
		Files []struct{ ID string }
	}
	testutil.Call(t, h.GetEngineeringSupplementCatalog, request()).Want(200).JSON(&catalog)
	if len(catalog.Databases) != 1 || len(catalog.Files) != 1 {
		t.Fatal("wrong private supplement", catalog)
	}
	r := withURLParam(request(), "databaseID", catalog.Databases[0].ID)
	var tasks struct {
		Tasks []struct {
			ID    string
			Title string
		}
	}
	testutil.Call(t, h.ListEngineeringSupplementTasks, r).Want(200).JSON(&tasks)
	if len(tasks.Tasks) != 1 || tasks.Tasks[0].ID != "same-task" {
		t.Fatal("original task identity changed", tasks)
	}
	file := withURLParam(request(), "fileID", catalog.Files[0].ID)
	var chunk struct {
		Data   string `json:"data_base64"`
		Length int    `json:"byte_length"`
	}
	testutil.Call(t, h.GetEngineeringSupplementFile, file).Want(200).JSON(&chunk)
	if chunk.Data != "AAH/Ag==" || chunk.Length != 4 {
		t.Fatal("original bytes changed", chunk)
	}
	file.Header.Set("X-Actor-Source", "task_token")
	testutil.Call(t, h.GetEngineeringSupplementFile, file).Want(403)
	if _, err = h.EngineeringSupplementWorker.Call(context.Background(), map[string]any{"action": "capture", "expected_archive_hash": captures.Primary.Hash, "expected_hash": captures.Supplement.Hash}); err == nil {
		t.Fatal("readonly worker accepted a mutator")
	}
}
