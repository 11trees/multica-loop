package engineering

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestEngineeringLocalControlRequiresPrivateSocketCredential(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix control socket")
	}
	root, err := os.MkdirTemp("", "eng-ctl-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	socket := filepath.Join(root, "control.sock")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	calls := 0
	if err = StartLocalControl(ctx, socket, func(_ context.Context, body json.RawMessage) (any, error) {
		calls++
		return map[string]any{"phase": "draining"}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if err = StartLocalControl(ctx, socket, func(context.Context, json.RawMessage) (any, error) {
		t.Fatal("duplicate listener served request")
		return nil, nil
	}); err == nil {
		t.Fatal("replaced live control listener")
	}
	for _, path := range []string{socket, socket + ".token"} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("private control permissions %v %v", info, err)
		}
	}
	client := &LocalControlClient{Socket: socket}
	data, err := client.Call(ctx, map[string]any{"claim": map[string]any{}})
	if err != nil || string(data) != "{\"phase\":\"draining\"}\n" {
		t.Fatal(string(data), err)
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	defer transport.CloseIdleConnections()
	response, err := (&http.Client{Transport: transport}).Post("http://engineering/drain", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden || calls != 1 {
		t.Fatal("unauthenticated local cancellation was accepted")
	}
}
