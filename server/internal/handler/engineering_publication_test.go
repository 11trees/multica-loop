package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

type publicationFixture struct {
	body    json.RawMessage
	failAck bool
	acks    int
}

func (f *publicationFixture) Call(_ context.Context, input any) (json.RawMessage, error) {
	value := input.(map[string]any)
	if value["action"] == "publication" {
		return f.body, nil
	}
	if value["action"] == "publication-ack" {
		f.acks++
		if f.failAck {
			f.failAck = false
			return nil, errors.New("acknowledgement unavailable")
		}
		return json.RawMessage(`{"acknowledged":true}`), nil
	}
	return nil, errors.New("unexpected operation")
}

func TestEngineeringPublicationRetriesAfterNativeCommitWithoutDuplicatingUnits(t *testing.T) {
	parentID := dbfx.Issue(t, "Publication parent")
	firstID, secondID, planID := dbid.NewV7(), dbid.NewV7(), dbid.NewV7()
	ctx := context.Background()
	units := []map[string]any{}
	for index, id := range []pgtype.UUID{firstID, secondID} {
		units = append(units, map[string]any{"issueId": uuidToString(id), "parentIssueId": parentID, "workspaceId": testWorkspaceID, "parentRevision": 1, "planDraftId": uuidToString(planID), "contractHash": strings.Repeat("a", 64), "published": false, "unit": map[string]string{"key": []string{"heading", "action"}[index], "title": []string{"Planned heading", "Planned action"}[index]}})
	}
	body, _ := json.Marshal(map[string]any{"requested_by": testUserID, "units": units})
	worker := &publicationFixture{body: body, failAck: true}
	h := *testHandler
	h.EngineeringWorker = worker
	t.Cleanup(func() {
		for _, id := range []pgtype.UUID{firstID, secondID} {
			request := withURLParam(newRequest(http.MethodDelete, "/api/issues/"+uuidToString(id), nil), "id", uuidToString(id))
			testHandler.DeleteIssue(httptest.NewRecorder(), request)
		}
	})
	request := func() *http.Request {
		return withURLParam(newRequest(http.MethodPost, "/api/issues/"+parentID+"/engineering/publication", map[string]int{"expected_revision": 1, "expected_sequence": 9}), "id", parentID)
	}
	testutil.Call(t, h.PublishEngineeringUnits, request()).Want(http.StatusServiceUnavailable)
	first, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: firstID, WorkspaceID: parseUUID(testWorkspaceID)})
	if err != nil {
		t.Fatal(err)
	}
	var metadata map[string]any
	if err := json.Unmarshal(first.Metadata, &metadata); err != nil {
		t.Fatal(err)
	}
	for _, value := range metadata {
		switch value.(type) {
		case string, float64, bool:
		default:
			t.Fatal("native metadata must remain flat")
		}
	}
	if first.ParentIssueID != parseUUID(parentID) || first.AssigneeID.Valid || first.Status != "todo" {
		t.Fatal("native child ownership or execution changed")
	}
	testutil.Call(t, h.PublishEngineeringUnits, request()).Want(http.StatusOK)
	var count int
	dbfx.QueryRow(t, "SELECT count(*) FROM issue WHERE parent_issue_id=$1 AND id=ANY($2::uuid[])", parentID, []string{uuidToString(firstID), uuidToString(secondID)}).Scan(&count)
	if count != 2 {
		t.Fatalf("publication created %d children", count)
	}
	otherParent := dbfx.Issue(t, "Other publication parent")
	_, err = h.IssueService.CreateEngineeringUnit(ctx, service.IssueCreateParams{WorkspaceID: parseUUID(testWorkspaceID), ParentIssueID: parseUUID(otherParent), CreatorType: "member", CreatorID: parseUUID(testUserID)}, firstID, service.EngineeringUnitOrigin{PlanDraftID: uuidToString(planID), UnitKey: "heading", RequirementRevision: 1, ContractHash: strings.Repeat("a", 64)})
	if !errors.Is(err, service.ErrEngineeringUnitIdentity) {
		t.Fatalf("foreign parent adopted a frozen identity: %v", err)
	}
}

func TestEngineeringPublicationRefusesUnfinishedParentRuns(t *testing.T) {
	runtimeID := dbfx.Runtime(t, "Publication runtime")
	agentID := dbfx.Agent(t, "Publication agent", runtimeID)
	parentID := dbfx.Issue(t, "Running publication parent")
	dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": parentID, "status": "running"})
	h := *testHandler
	worker := &engineeringRecorder{}
	h.EngineeringWorker = worker
	request := withURLParam(newRequest(http.MethodPost, "/api/issues/"+parentID+"/engineering/publication", map[string]int{"expected_revision": 1, "expected_sequence": 9}), "id", parentID)
	testutil.Call(t, h.PublishEngineeringUnits, request).Want(http.StatusConflict)
	if len(worker.inputs) != 0 {
		t.Fatal("active parent reached publication")
	}
}
