package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/ByungHyun21/Kiwi-Agent/internal/exec"
	"github.com/ByungHyun21/Kiwi-Agent/internal/server"
	"github.com/ByungHyun21/Kiwi-Agent/internal/server/store"
)

func main() {
	addr := flag.String("addr", ":5494", "listen address")
	flag.Parse()

	dataDir := os.Getenv("KIWI_DATA")
	if dataDir == "" {
		home, _ := os.UserHomeDir()
		dataDir = filepath.Join(home, ".local", "share", "kiwi")
	}
	st, err := store.Open(filepath.Join(dataDir, "server.db"))
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()

	runner := exec.NewSSHRunner(st)
	runner.Auth = exec.DefaultAuth()

	srv, err := server.New(st, runner)
	if err != nil {
		log.Fatalf("server: %v", err)
	}
	log.Printf("kiwi-server listening on http://localhost%s (token %s)", *addr, srv.Token())
	log.Fatal(http.ListenAndServe(*addr, srv.Handler()))
}
