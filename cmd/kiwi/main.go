package main

import (
	"fmt"
	"os"

	"github.com/ByungHyun21/Kiwi-Agent/internal/execcli"
	"github.com/ByungHyun21/Kiwi-Agent/internal/tui"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "exec" {
		os.Exit(execcli.Run(os.Args[2:], os.Stdin, os.Stdout))
	}
	if err := tui.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "kiwi:", err)
		os.Exit(1)
	}
}
