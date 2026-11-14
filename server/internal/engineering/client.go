package engineering

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"sync"
	"time"
)

type Rejection struct {
	Message  string
	Conflict bool
}

func (e *Rejection) Error() string { return e.Message }

// Client serializes local application operations. The trusted worker receives
// projected identity, never bearer credentials, and owns the protocol database.
type Client struct {
	Worker, Database string
	Admin            bool
	mu               sync.Mutex
}

func (c *Client) Call(ctx context.Context, input any) (json.RawMessage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	body, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	args := []string{c.Worker, c.Database}
	if c.Admin {
		args = append(args, "--admin")
	}
	cmd := exec.CommandContext(ctx, "node", args...)
	for _, key := range []string{"PATH", "TMPDIR", "TMP", "TEMP", "LANG", "SystemRoot", "WINDIR"} {
		if value, ok := os.LookupEnv(key); ok {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	cmd.Env = append(cmd.Env, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_TERMINAL_PROMPT=0")
	cmd.Stdin = bytes.NewReader(body)
	output, err := cmd.Output()
	if err != nil {
		return nil, errors.New("engineering worker unavailable")
	}
	var response struct {
		Result   json.RawMessage `json:"result"`
		Error    string          `json:"error"`
		Conflict bool            `json:"conflict"`
	}
	if err := json.Unmarshal(output, &response); err != nil {
		return nil, errors.New("invalid engineering worker response")
	}
	if response.Error != "" {
		return nil, &Rejection{Message: response.Error, Conflict: response.Conflict}
	}
	if len(response.Result) == 0 {
		return nil, errors.New("missing engineering worker result")
	}
	return response.Result, nil
}
