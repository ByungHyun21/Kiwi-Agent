package main

import (
	"fmt"
	"os"

	"github.com/ByungHyun21/Kiwi-Agent/internal/tui"
)

func main() {
	if err := tui.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "kiwi:", err)
		os.Exit(1)
	}
}
