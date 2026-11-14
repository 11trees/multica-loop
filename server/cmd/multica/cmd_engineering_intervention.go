package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

func init() {
	command := &cobra.Command{Use: "intervention-request", Short: "Surrender this execution with its original blocker evidence", Args: exactArgs(0)}
	for _, name := range []string{"summary", "reason", "evidence"} {
		command.Flags().String(name+"-file", "", "UTF-8 "+name+" file inside task-private TMPDIR")
	}
	command.RunE = func(cmd *cobra.Command, _ []string) error {
		payload := map[string]string{}
		for _, field := range []struct {
			name  string
			limit int64
		}{{"summary", 4000}, {"reason", 8000}, {"evidence", 100000}} {
			path, _ := cmd.Flags().GetString(field.name + "-file")
			value, err := readEngineeringTaskText(path, field.limit)
			if err != nil {
				return err
			}
			payload[field.name] = value
		}
		client, err := newAPIClient(cmd)
		if err != nil {
			return err
		}
		var result json.RawMessage
		if err = client.PostJSON(cmd.Context(), "/api/engineering/intervention/request", payload, &result); err != nil {
			return err
		}
		_, err = fmt.Fprintln(os.Stdout, string(result))
		return err
	}
	engineeringCmd.AddCommand(command)
}
