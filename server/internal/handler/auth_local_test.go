package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestLocalLoginRequestPolicy(t *testing.T) {
	for _, tc := range []struct {
		name, peer, host, origin string
		allowed                  bool
	}{
		{"browser", "127.0.0.1:4567", "localhost:8080", "http://localhost:3000", true},
		{"ipv6", "[::1]:4567", "[::1]:8080", "http://[::1]:3000", true},
		{"desktop", "127.0.0.1:4567", "127.0.0.1:8080", "null", true},
		{"local CLI", "127.0.0.1:4567", "localhost:8080", "", true},
		{"remote peer", "192.0.2.1:4567", "localhost:8080", "http://localhost:3000", false},
		{"public host", "127.0.0.1:4567", "example.com", "http://localhost:3000", false},
		{"foreign origin", "127.0.0.1:4567", "localhost:8080", "https://example.com", false},
		{"malformed origin", "127.0.0.1:4567", "localhost:8080", "localhost:3000", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "http://"+tc.host+"/auth/local", nil)
			req.RemoteAddr = tc.peer
			req.Header.Set("Origin", tc.origin)
			req.Header.Set("X-Forwarded-For", "127.0.0.1")
			if got := localLoginRequest(req); got != tc.allowed {
				t.Fatalf("localLoginRequest = %v, want %v", got, tc.allowed)
			}
		})
	}
}

func TestLocalLoginDisabled(t *testing.T) {
	h := newTestHandler(Config{})
	req := httptest.NewRequest(http.MethodPost, "http://localhost/auth/local", nil)
	req.RemoteAddr = "127.0.0.1:4567"
	testutil.Call(t, h.LocalLogin, req).Want(http.StatusNotFound)
}

func TestLocalLoginSessionAndBootstrap(t *testing.T) {
	ctx := context.Background()
	h := *testHandler
	h.cfg.LocalAuthEnabled = true
	h.cfg.AllowSignup = false
	h.cfg.DisableWorkspaceCreation = true
	_, userErr := h.Queries.GetUser(ctx, parseUUID(localUserID))
	_, wsErr := h.Queries.GetWorkspace(ctx, parseUUID(localWorkspaceID))
	if errors.Is(userErr, pgx.ErrNoRows) {
		dbfx.Cleanup(t, `DELETE FROM "user" WHERE id = $1`, localUserID)
	}
	if errors.Is(wsErr, pgx.ErrNoRows) {
		dbfx.Cleanup(t, `DELETE FROM workspace WHERE id = $1`, localWorkspaceID)
		dbfx.Cleanup(t, `DELETE FROM issue_status WHERE workspace_id = $1`, localWorkspaceID)
		dbfx.Cleanup(t, `DELETE FROM member WHERE workspace_id = $1`, localWorkspaceID)
	}
	newRequest := func() *http.Request {
		req := httptest.NewRequest(http.MethodPost, "http://localhost:8080/auth/local", nil)
		req.RemoteAddr = "127.0.0.1:4567"
		req.Header.Set("Origin", "http://localhost:3000")
		return req
	}
	var result LoginResponse
	response := testutil.Call(t, h.LocalLogin, newRequest()).Want(http.StatusOK).JSON(&result)
	foundAuthCookie := false
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == "multica_auth" && cookie.HttpOnly {
			foundAuthCookie = true
		}
	}
	if !foundAuthCookie {
		t.Fatal("local bootstrap did not set an HttpOnly session cookie")
	}
	if result.User.ID != localUserID || result.Token == "" || result.User.OnboardedAt == nil {
		t.Fatalf("bootstrap did not return the onboarded local identity: %+v", result.User)
	}
	// The token passes the unmodified authentication middleware and GetMe path.
	me := httptest.NewRequest(http.MethodGet, "http://localhost:8080/api/me", nil)
	me.Header.Set("Authorization", "Bearer "+result.Token)
	authenticated := middleware.Auth(h.Queries, nil, nil, nil)(http.HandlerFunc(h.GetMe))
	var user UserResponse
	testutil.Call(t, authenticated.ServeHTTP, me).Want(http.StatusOK).JSON(&user)
	if user.ID != localUserID {
		t.Fatalf("session authenticated as %s, want local user", user.ID)
	}
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for range 2 {
		wg.Go(func() {
			rr := httptest.NewRecorder()
			h.LocalLogin(rr, newRequest())
			statuses <- rr.Code
		})
	}
	wg.Wait()
	close(statuses)
	for status := range statuses {
		if status != http.StatusOK {
			t.Errorf("concurrent bootstrap returned %d", status)
		}
	}
	if count := dbfx.Count(t, `SELECT COUNT(*) FROM member WHERE user_id = $1 AND workspace_id = $2 AND role = 'owner'`, localUserID, localWorkspaceID); count != 1 {
		t.Fatalf("local owner memberships = %d, want 1", count)
	}
	if count := dbfx.Count(t, `SELECT COUNT(*) FROM issue_status WHERE workspace_id = $1`, localWorkspaceID); count != 7 {
		t.Fatalf("local workspace status catalog has %d rows, want 7", count)
	}
}
