package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"

	"github.com/spf13/cobra"
)

var engineeringCmd = &cobra.Command{Use: "engineering", Short: "Run engineering command chains and manage frozen verification contracts"}

func init() {
	engineeringCmd.GroupID = groupCore
	rootCmd.AddCommand(engineeringCmd)
	for _, operation := range []struct{ name, path, short string }{
		{"start", "/api/engineering/verification/start", "Start or resume this run's engineering checkpoint"},
		{"status", "/api/engineering/verification", "Read this run's engineering checkpoint"},
		{"command", "/api/engineering/verification/commands", "Execute a JSON phase/artifact/runtime-input command"},
		{"configure <issue-id>", "configure", "Freeze a delivery contract and clean repository commit (human only)"},
		{"publish-units <issue-id>", "publish-units", "Publish a frozen requirement plan as native child issues (human only)"},
		{"start-deliveries <issue-id>", "start-deliveries", "Authorize frozen roles and bounded serial delivery for a published plan (human only)"},
		{"start-review <issue-id>", "start-review", "Authorize requirement reconciliation and automatic gap follow-up (human only)"},
		{"acknowledge-report <issue-id>", "acknowledge-report", "Confirm reading the exact current closure report and close the requirement (human only)"},
		{"inspect <issue-id>", "inspect", "Read the issue's contract and questions (human only)"},
		{"answer <issue-id>", "answer", "Answer a pending runtime input (human only)"},
		{"abandon <issue-id>", "abandon", "Abandon an active verification draft (human only)"},
	} {
		op := operation
		cmd := &cobra.Command{Use: op.name, Short: op.short, Args: exactArgs(0)}
		if op.path[0] != '/' {
			cmd.Args = exactArgs(1)
		}
		cmd.Flags().String("payload", "", "JSON request body")
		cmd.Flags().String("payload-file", "", "Read the JSON request body from a UTF-8 file")
		cmd.Flags().Bool("payload-stdin", false, "Read the JSON request body from stdin")
		cmd.Flags().Bool("allow-external-file", false, "Allow reading a payload file outside the working directory")
		cmd.RunE = func(cmd *cobra.Command, args []string) error {
			client, err := newAPIClient(cmd)
			if err != nil {
				return err
			}
			path := op.path
			if path[0] != '/' {
				path = "/api/issues/" + url.PathEscape(args[0]) + "/engineering/verification/"
				if op.path == "publish-units" {
					path = "/api/issues/" + url.PathEscape(args[0]) + "/engineering/publication"
				}
				if op.path == "start-deliveries" {
					path = "/api/issues/" + url.PathEscape(args[0]) + "/engineering/delivery"
				}
				if op.path == "start-review" {
					path = "/api/issues/" + url.PathEscape(args[0]) + "/engineering/review"
				}
				if op.path == "acknowledge-report" {
					path = "/api/issues/" + url.PathEscape(args[0]) + "/engineering/review/acknowledge"
				}
				if op.path == "answer" {
					path += "answers"
				}
				if op.path == "abandon" {
					path += "abandon"
				}
			}
			var output json.RawMessage
			if op.path == "inspect" || op.path == "/api/engineering/verification" {
				err = client.GetJSON(cmd.Context(), path, &output)
			} else {
				payload, supplied, readErr := resolveTextFlag(cmd, "payload")
				if readErr != nil {
					return readErr
				}
				if inline, _ := cmd.Flags().GetString("payload"); inline != "" {
					payload = inline
				}
				if !supplied {
					payload = "{}"
				}
				if !json.Valid([]byte(payload)) {
					return fmt.Errorf("payload must be valid JSON")
				}
				err = client.PostJSON(cmd.Context(), path, json.RawMessage(payload), &output)
			}
			if err != nil {
				return err
			}
			_, err = fmt.Fprintln(os.Stdout, string(output))
			return err
		}
		engineeringCmd.AddCommand(cmd)
	}
}
