package handler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const localUserID = "db20ef47-8076-41a0-af0d-2814950fbe42"
const localWorkspaceID = "323d1db3-abcf-4890-a2ca-df15a057fdf7"
const localUserEmail = "local@multica-loop.invalid"

func loopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

func localLoginRequest(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || !loopbackHost(host) {
		return false
	}
	host = r.Host
	if parsed, _, err := net.SplitHostPort(host); err == nil {
		host = parsed
	}
	if !loopbackHost(host) {
		return false
	}
	// Packaged Desktop uses an opaque renderer origin. Network requests still
	// have to reach this handler directly over loopback; proxy headers grant nothing.
	origin := r.Header.Get("Origin")
	if origin == "" || origin == "null" {
		return true
	}
	u, err := url.Parse(origin)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && loopbackHost(u.Hostname())
}

// LocalLogin establishes ordinary credentials for one reserved local identity.
// Normal Auth middleware remains responsible for every authenticated operation.
func (h *Handler) LocalLogin(w http.ResponseWriter, r *http.Request) {
	if !h.cfg.LocalAuthEnabled {
		http.NotFound(w, r)
		return
	}
	if !localLoginRequest(r) {
		writeError(w, http.StatusForbidden, "local sign-in requires a loopback connection and origin")
		return
	}
	user, err := h.ensureLocalIdentity(r.Context())
	if err != nil {
		slog.Error("local identity bootstrap failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to prepare local workspace")
		return
	}
	token, err := h.issueJWT(user)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create local session")
		return
	}
	if err := auth.SetAuthCookies(w, token); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to set local session cookies")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, LoginResponse{Token: token, User: h.userToResponse(user)})
}

func (h *Handler) ensureLocalIdentity(ctx context.Context) (db.User, error) {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return db.User{}, err
	}
	defer tx.Rollback(ctx)
	// Two fresh browser tabs may bootstrap simultaneously. Serialize creation
	// so both receive the same committed user, workspace, and membership.
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext('multica-loop:local-auth'))"); err != nil {
		return db.User{}, err
	}
	q := h.Queries.WithTx(tx)
	user, err := q.GetUser(ctx, parseUUID(localUserID))
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx, `INSERT INTO "user" (id, name, email) VALUES ($1, 'Local user', $2)`, localUserID, localUserEmail)
		if err == nil {
			user, err = q.GetUser(ctx, parseUUID(localUserID))
		}
	}
	if err != nil {
		return db.User{}, err
	}
	if user.Email != localUserEmail {
		return db.User{}, fmt.Errorf("reserved local user identity is already in use")
	}
	_, err = q.GetWorkspace(ctx, parseUUID(localWorkspaceID))
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx, `INSERT INTO workspace (id, name, slug, issue_prefix) VALUES ($1, 'Local workspace', 'loopwork-local', 'LOCAL')`, localWorkspaceID)
	}
	if err != nil {
		return db.User{}, err
	}
	member, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
		UserID: user.ID, WorkspaceID: parseUUID(localWorkspaceID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		member, err = q.CreateMember(ctx, db.CreateMemberParams{
			UserID: user.ID, WorkspaceID: parseUUID(localWorkspaceID), Role: "owner",
		})
	}
	if err != nil {
		return db.User{}, err
	}
	if member.Role != "owner" {
		return db.User{}, fmt.Errorf("local workspace membership must remain an owner")
	}
	if err := issuestatus.Ensure(ctx, q, parseUUID(localWorkspaceID)); err != nil {
		return db.User{}, err
	}
	user, err = q.MarkUserOnboarded(ctx, user.ID)
	if err != nil {
		return db.User{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return db.User{}, err
	}
	return user, nil
}
