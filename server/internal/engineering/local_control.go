package engineering

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"time"
)

// StartLocalControl exposes no TCP route and keeps its credential outside agents.
func StartLocalControl(ctx context.Context, socket string, call func(context.Context, json.RawMessage) (any, error)) error {
	if info, err := os.Lstat(socket); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return fmt.Errorf("engineering control path is not a socket")
		}
		connection, err := net.DialTimeout("unix", socket, time.Second)
		if err == nil {
			connection.Close()
			return fmt.Errorf("engineering control is already running")
		}
		if err = os.Remove(socket); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		return err
	}
	if err = os.Chmod(socket, 0600); err != nil {
		listener.Close()
		return err
	}
	secret := make([]byte, 32)
	if _, err = rand.Read(secret); err != nil {
		listener.Close()
		return err
	}
	token := hex.EncodeToString(secret)
	if err = os.WriteFile(socket+".token", []byte(token), 0600); err != nil {
		listener.Close()
		return err
	}
	if err = os.Chmod(socket+".token", 0600); err != nil {
		listener.Close()
		return err
	}
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/drain" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
			http.Error(w, "invalid local control credential", http.StatusForbidden)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil || !json.Valid(body) {
			http.Error(w, "invalid local control request", http.StatusBadRequest)
			return
		}
		result, err := call(r.Context(), body)
		if err != nil {
			http.Error(w, "engineering drain is unavailable or its authority changed", http.StatusConflict)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	})}
	go func() { <-ctx.Done(); _ = server.Close(); _ = os.Remove(socket + ".token") }()
	go func() { _ = server.Serve(listener) }()
	return nil
}

type LocalControlClient struct{ Socket string }

func (c *LocalControlClient) Call(ctx context.Context, input any) (json.RawMessage, error) {
	token, err := os.ReadFile(c.Socket + ".token")
	if err != nil {
		return nil, fmt.Errorf("engineering local control unavailable")
	}
	body, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", c.Socket)
	}}
	defer transport.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://engineering/drain", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+string(token))
	timeout := 20 * time.Second
	var operation struct {
		Action string `json:"action"`
	}
	if json.Unmarshal(body, &operation) == nil && operation.Action == "prepare-handoff" {
		// Preparation includes two bounded 10-second content reads, plus native
		// reconciliation and permission checks; keep room for both valid reads.
		timeout = 40 * time.Second
	}
	response, err := (&http.Client{Transport: transport, Timeout: timeout}).Do(request)
	if err != nil {
		return nil, fmt.Errorf("engineering local control unavailable")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK || !json.Valid(data) {
		return nil, fmt.Errorf("engineering local control rejected drain")
	}
	return data, nil
}
