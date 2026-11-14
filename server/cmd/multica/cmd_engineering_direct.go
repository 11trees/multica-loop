package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/spf13/cobra"
)

func readEngineeringTaskText(name string, max int64) (string, error) {
	if name == "" {
		return "", fmt.Errorf("an engineering submission file is required")
	}
	base := os.Getenv("TMPDIR")
	if base == "" {
		return "", fmt.Errorf("Engineering files require the native task-private TMPDIR")
	}
	root, err := filepath.EvalSymlinks(base)
	if err != nil {
		return "", err
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return "", err
	}
	file, err := filepath.EvalSymlinks(name)
	if err != nil {
		return "", err
	}
	file, err = filepath.Abs(file)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(root, file)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", fmt.Errorf("Engineering submission files must be inside task-private TMPDIR")
	}
	f, err := os.Open(file)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("Engineering submission requires a regular UTF-8 file")
	}
	data, err := io.ReadAll(io.LimitReader(f, max*4+1))
	if err != nil {
		return "", err
	}
	if int64(len(data)) > max*4 || !utf8.Valid(data) {
		return "", fmt.Errorf("Engineering submission file exceeds its UTF-8 size boundary")
	}
	return string(data), nil
}

func init() {
	run := &cobra.Command{Use: "direct-run", Short: "Begin this native Direct attempt before doing its work", Args: exactArgs(0), RunE: func(cmd *cobra.Command, _ []string) error {
		client, err := newAPIClient(cmd)
		if err != nil {
			return err
		}
		var result json.RawMessage
		if err = client.PostJSON(cmd.Context(), "/api/engineering/direct/run", map[string]any{}, &result); err != nil {
			return err
		}
		_, err = fmt.Fprintln(os.Stdout, string(result))
		return err
	}}
	submit := &cobra.Command{Use: "direct-submit", Short: "Submit the actual Direct result from task-private UTF-8 files", Args: exactArgs(0)}
	submit.Flags().String("summary-file", "", "UTF-8 summary file in task-private TMPDIR (at most 4000 characters)")
	submit.Flags().String("result-file", "", "Optional full Markdown result in task-private TMPDIR (at most 100000 characters)")
	submit.RunE = func(cmd *cobra.Command, _ []string) error {
		summaryFile, _ := cmd.Flags().GetString("summary-file")
		summary, err := readEngineeringTaskText(summaryFile, 4000)
		if err != nil {
			return err
		}
		payload := map[string]string{"summary": summary}
		resultFile, _ := cmd.Flags().GetString("result-file")
		if resultFile != "" {
			content, err := readEngineeringTaskText(resultFile, 100000)
			if err != nil {
				return err
			}
			payload["result"] = content
		}
		client, err := newAPIClient(cmd)
		if err != nil {
			return err
		}
		var result json.RawMessage
		if err = client.PostJSON(cmd.Context(), "/api/engineering/direct/submit", payload, &result); err != nil {
			return err
		}
		_, err = fmt.Fprintln(os.Stdout, string(result))
		return err
	}
	engineeringCmd.AddCommand(run, submit)
}
