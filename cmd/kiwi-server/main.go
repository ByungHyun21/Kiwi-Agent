package main

import (
	"flag"
	"log"
	"net/http"

	"kiwi-agent/internal/web"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	flag.Parse()

	log.Printf("kiwi-server listening on http://localhost%s", *addr)
	log.Fatal(http.ListenAndServe(*addr, web.Routes()))
}
