// Package server hosts the kiwi HTTP surface: the web UI today, and the
// API, WebSocket endpoint and auth as they land.
package server

import (
	"net/http"

	"github.com/a-h/templ"

	"github.com/ByungHyun21/Kiwi-Agent/internal/web"
)

// Server assembles all kiwi-server HTTP handlers.
type Server struct {
	mux *http.ServeMux
}

// New builds a Server with the web UI wired.
func New() *Server {
	s := &Server{mux: http.NewServeMux()}
	s.routes()
	return s
}

// Handler returns the root handler.
func (s *Server) Handler() http.Handler { return s.mux }

func (s *Server) routes() {
	s.mux.HandleFunc("GET /{$}", page(web.Dashboard()))
	s.mux.HandleFunc("GET /machines", page(web.Machines()))
	s.mux.HandleFunc("GET /settings", page(web.Settings()))
	s.mux.HandleFunc("GET /docs", page(web.Docs()))
	s.mux.Handle("GET /static/", http.StripPrefix("/static/", web.Static()))
}

func page(c templ.Component) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		c.Render(r.Context(), w)
	}
}
