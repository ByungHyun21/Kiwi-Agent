package web

import (
	"io/fs"
	"net/http"

	"github.com/a-h/templ"
)

// Routes builds the kiwi-server HTTP surface.
func Routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /{$}", page(Dashboard()))
	mux.HandleFunc("GET /machines", page(Machines()))
	mux.HandleFunc("GET /settings", page(Settings()))
	mux.HandleFunc("GET /docs", page(Docs()))

	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServerFS(mustSub())))

	return mux
}

func page(c templ.Component) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		c.Render(r.Context(), w)
	}
}

func mustSub() fs.FS {
	sub, err := fs.Sub(assets, "static")
	if err != nil {
		panic(err)
	}
	return sub
}
