package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/engineering/adminrunner"
	"github.com/multica-ai/multica/server/internal/engineering/processidentity"
	"github.com/multica-ai/multica/server/internal/handler"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/spf13/cobra"
)

// The invocation socket does not consult a human profile or API credentials.
func callAdminCommand(ctx context.Context, payload any) (json.RawMessage, error) {
	socket, token := os.Getenv("MULTICA_ADMIN_SOCKET"), os.Getenv("MULTICA_ADMIN_TOKEN")
	if socket == "" || token == "" {
		return nil, fmt.Errorf("Admin commands require an active investigation invocation")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 20 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://admin/command", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	response, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Admin invocation command unavailable")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 32<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Admin command rejected: %s", data)
	}
	if !json.Valid(data) {
		return nil, fmt.Errorf("Invalid Admin invocation response")
	}
	return data, nil
}

func adminWorker(cmd *cobra.Command) (*engineering.Client, error) {
	if os.Getenv("MULTICA_ADMIN_TOKEN") != "" || os.Getenv("MULTICA_TASK_ID") != "" {
		return nil, fmt.Errorf("Management control is unavailable inside an agent invocation")
	}
	worker, _ := cmd.Flags().GetString("worker")
	database, _ := cmd.Flags().GetString("database")
	if worker == "" {
		worker = os.Getenv("MULTICA_ENGINEERING_WORKER")
	}
	if database == "" {
		database = os.Getenv("MULTICA_ENGINEERING_DATABASE")
	}
	if !filepath.IsAbs(worker) || !filepath.IsAbs(database) {
		return nil, fmt.Errorf("Management requires absolute environment-owned worker and business database paths")
	}
	return &engineering.Client{Worker: worker, Database: database + ".admin.sqlite", Admin: true}, nil
}
func addAdminHostFlags(cmd *cobra.Command) {
	cmd.Flags().String("worker", "", "Absolute private worker path (or MULTICA_ENGINEERING_WORKER)")
	cmd.Flags().String("database", "", "Absolute business database path (or MULTICA_ENGINEERING_DATABASE)")
}

func init() {
	admin := &cobra.Command{Use: "admin", Short: "Use this investigation's private command protocol"}
	for _, action := range []string{"status", "history", "evidence", "submit", "workspace-takeover"} {
		action := action
		cmd := &cobra.Command{Use: action, Args: exactArgs(0), RunE: func(cmd *cobra.Command, _ []string) error {
			payload := map[string]any{"action": action}
			switch action {
			case "workspace-takeover":
				for _, key := range []string{"observation-id", "reason"} {
					value, _ := cmd.Flags().GetString(key)
					if key == "observation-id" {
						payload["observation_id"] = value
					} else {
						payload[key] = value
					}
				}
			case "history":
				for _, key := range []string{"collection", "hash"} {
					value, _ := cmd.Flags().GetString(key)
					if value != "" {
						payload[key] = value
					}
				}
				for _, key := range []string{"index", "start", "length"} {
					value, _ := cmd.Flags().GetInt(key)
					payload[key] = value
				}
			case "evidence", "submit":
				flag, key := "payload-file", "payload"
				if action == "submit" {
					flag, key = "result-file", "result"
				}
				path, _ := cmd.Flags().GetString(flag)
				value, err := readEngineeringTaskText(path, 8<<20)
				if err != nil {
					return err
				}
				if !json.Valid([]byte(value)) {
					return fmt.Errorf("Submission file must contain valid JSON")
				}
				payload[key] = json.RawMessage(value)
				if action == "evidence" {
					for _, key := range []string{"key", "kind"} {
						value, _ := cmd.Flags().GetString(key)
						payload[key] = value
					}
				}
			}
			result, err := callAdminCommand(cmd.Context(), payload)
			if err != nil {
				return err
			}
			_, err = fmt.Fprintln(cmd.OutOrStdout(), string(result))
			return err
		}}
		switch action {
		case "workspace-takeover":
			cmd.Flags().String("observation-id", "", "Original business observation from this Case")
			cmd.Flags().String("reason", "", "Reason for scoped workspace takeover")
		case "history":
			cmd.Flags().String("collection", "observations", "observations, evidence or attempts")
			cmd.Flags().String("hash", "", "Exact row SHA-256 returned by status")
			cmd.Flags().Int("index", 0, "Row index")
			cmd.Flags().Int("start", 0, "Character offset")
			cmd.Flags().Int("length", 16000, "Maximum characters (1 to 16000)")
		case "evidence":
			cmd.Flags().String("key", "", "Immutable evidence key")
			cmd.Flags().String("kind", "finding", "hypothesis, finding, action or change")
			cmd.Flags().String("payload-file", "", "UTF-8 JSON object in invocation TMPDIR")
		case "submit":
			cmd.Flags().String("result-file", "", "Structured terminal result JSON in invocation TMPDIR")
		}
		admin.AddCommand(cmd)
	}
	control := &cobra.Command{Use: "admin-control", Short: "Configure or control local single-user Admin management"}
	for _, action := range []string{"status", "configure", "start", "stop"} {
		action := action
		cmd := &cobra.Command{Use: action, Args: exactArgs(0), RunE: func(cmd *cobra.Command, _ []string) error {
			client, err := adminWorker(cmd)
			if err != nil {
				return err
			}
			payload := map[string]any{"action": "state"}
			if action == "configure" {
				path, _ := cmd.Flags().GetString("provider-path")
				model, _ := cmd.Flags().GetString("model")
				effort, _ := cmd.Flags().GetString("reasoning-effort")
				revision, _ := cmd.Flags().GetInt("expected-revision")
				configuration := map[string]any{"provider": "codex", "executablePath": path}
				if model != "" {
					configuration["model"] = model
				}
				if effort != "" {
					configuration["reasoningEffort"] = effort
				}
				payload = map[string]any{"action": "configuration", "payload": map[string]any{"expected_revision": revision, "configuration": configuration}}
			}
			if action == "start" || action == "stop" {
				intent := "running"
				if action == "stop" {
					intent = "stopped"
				}
				request, _ := cmd.Flags().GetString("request-id")
				if request == "" {
					return fmt.Errorf("An idempotent --request-id is required")
				}
				payload = map[string]any{"action": "intent", "payload": map[string]any{"intent": intent, "request_id": request}}
			}
			result, err := client.Call(cmd.Context(), payload)
			if err != nil {
				return err
			}
			_, err = fmt.Fprintln(cmd.OutOrStdout(), string(result))
			return err
		}}
		addAdminHostFlags(cmd)
		if action == "configure" {
			cmd.Flags().String("provider-path", "", "Explicit absolute Codex executable; configuration does not execute or discover it")
			cmd.Flags().String("model", "", "Explicit model")
			cmd.Flags().String("reasoning-effort", "", "Reasoning effort")
			cmd.Flags().Int("expected-revision", 0, "Current runtime configuration revision")
		}
		if action == "start" || action == "stop" {
			cmd.Flags().String("request-id", "", "Unique durable intent request ID")
		}
		control.AddCommand(cmd)
	}
	host := &cobra.Command{Use: "admin-host", Short: "Run the independent local Admin supervision process", Args: exactArgs(0), RunE: func(cmd *cobra.Command, _ []string) error {
		client, err := adminWorker(cmd)
		if err != nil {
			return err
		}
		if !processidentity.Supported() {
			return fmt.Errorf("Independent Admin host requires macOS or Linux process identity support")
		}
		root, _ := cmd.Flags().GetString("root")
		if root == "" {
			root = client.Database + ".logs"
		}
		if !filepath.IsAbs(root) {
			return fmt.Errorf("Admin logs require an absolute path")
		}
		ctx, cancel := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
		if err != nil {
			return fmt.Errorf("Admin native identity database unavailable")
		}
		defer pool.Close()
		if err = pool.Ping(ctx); err != nil {
			return fmt.Errorf("Admin native identity database unavailable")
		}
		binary, err := os.Executable()
		if err != nil {
			return err
		}
		stateFile, _ := cmd.Flags().GetString("state-file")
		if stateFile != "" {
			if !filepath.IsAbs(stateFile) {
				return fmt.Errorf("Admin identity file requires an absolute path")
			}
			state, _ := json.Marshal(map[string]any{"pid": os.Getpid(), "commit": buildCommit, "started_at": time.Now().UTC().Format(time.RFC3339)})
			if err = os.WriteFile(stateFile+".tmp", state, 0600); err != nil {
				return err
			}
			if err = os.Rename(stateFile+".tmp", stateFile); err != nil {
				return err
			}
		}
		h := &handler.Handler{EngineeringTakeoverControl: &engineering.LocalControlClient{Socket: client.Database[:len(client.Database)-len(".admin.sqlite")] + ".control.sock"}, Queries: db.New(pool), EngineeringWorker: &engineering.Client{Worker: client.Worker, Database: client.Database[:len(client.Database)-len(".admin.sqlite")]}, EngineeringAdminWorker: client, EngineeringAdminExecutor: &adminrunner.Runner{Client: client, Multica: binary, Root: root}}
		h.RunEngineeringAdmin(ctx)
		return nil
	}}
	addAdminHostFlags(host)
	host.Flags().String("root", "", "Absolute private investigation log directory")
	host.Flags().String("state-file", "", "Absolute managed host identity file")
	engineeringCmd.AddCommand(admin, control, host)
}
