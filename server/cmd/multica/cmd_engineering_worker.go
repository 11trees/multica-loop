package main

import (
	"fmt"
	"github.com/multica-ai/multica/server/internal/engineering/adminrunner"
	"github.com/spf13/cobra"
	"os"
)

func init() {
	engineeringCmd.AddCommand(&cobra.Command{Use: "verification-worker", Hidden: true, Args: exactArgs(0), RunE: func(cmd *cobra.Command, _ []string) error {
		if !inIndependentVerificationContext() || os.Getenv("MULTICA_ADMIN_TOKEN") != "" || os.Getenv("MULTICA_TOKEN") != "" {
			return fmt.Errorf("native verification worker requires a credential-free private execution context")
		}
		return adminrunner.RunVerificationWorker(cmd.Context(), cmd.InOrStdin(), cmd.OutOrStdout())
	}})
}
