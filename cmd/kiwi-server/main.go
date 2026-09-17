package main

import (
	"flag"
	"log"
	"net/http"

	"github.com/ByungHyun21/Kiwi-Agent/internal/server"
)

func main() {
	addr := flag.String("addr", ":5494", "listen address")
	flag.Parse()

	log.Printf("kiwi-server listening on http://localhost%s", *addr)
	log.Fatal(http.ListenAndServe(*addr, server.New().Handler()))
}
