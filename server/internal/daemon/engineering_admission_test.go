//go:build darwin || linux

package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestEngineeringControllerAdmissionWaitsWithoutPreparingOrLaunching(t *testing.T) {
	for _, mode := range []string{"resume", "status-already-waiting", "cancel", "deadline", "closed"} {
		t.Run(mode, func(t *testing.T) {
			var attempts, waits atomic.Int32
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if mode == "deadline" {
				var stop context.CancelFunc
				ctx, stop = context.WithTimeout(ctx, 50*time.Millisecond)
				defer stop()
			}
			var controller string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/daemon/tasks/fixture/wait-local-directory" {
					waits.Add(1)
					if mode == "status-already-waiting" {
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					if mode == "cancel" {
						cancel()
					}
					return
				}
				if r.URL.Path != "/api/daemon/tasks/fixture/engineering-controller" {
					t.Error("admission attempted preparation or provider execution", r.URL.Path)
					w.WriteHeader(500)
					return
				}
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body["operation"] != "begin" {
					t.Error("unexpected admission operation")
				}
				id, _ := body["controller_id"].(string)
				if controller == "" {
					controller = id
				} else if controller != id {
					t.Error("waiting changed controller identity")
				}
				attempt := attempts.Add(1)
				if mode == "closed" {
					w.WriteHeader(http.StatusConflict)
					return
				}
				if (mode == "resume" || mode == "status-already-waiting") && attempt >= 3 {
					_ = json.NewEncoder(w).Encode(map[string]bool{"admitted": true})
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]bool{"admitted": false, "waiting_repository": true})
			}))
			defer server.Close()
			journal := &engineeringProcessJournal{client: NewClient(server.URL), task: Task{ID: "fixture", ProjectTitle: "Fixture project", DispatchedAt: "2026-11-17T00:00:00Z"}, ctx: ctx, provider: "codex"}
			err := journal.begin(ctx)
			if mode == "resume" || mode == "status-already-waiting" {
				if err != nil || attempts.Load() != 3 || waits.Load() != 1 {
					t.Fatal("admission did not resume unchanged", err, attempts.Load(), waits.Load())
				}
			} else if err == nil {
				t.Fatal("closed admission launched a provider")
			}
			if mode == "cancel" && !errors.Is(err, context.Canceled) {
				t.Fatal("cancelled wait did not stop", err)
			}
			if mode == "deadline" && !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal("wait ignored preparation deadline", err)
			}
			if journal.invoked.Load() || journal.startedProvider.Load() {
				t.Fatal("waiting fabricated a provider launch")
			}
		})
	}
}
