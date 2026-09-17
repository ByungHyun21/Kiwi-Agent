package web

import (
	"io/fs"
	"net/http"
)

// Static serves the embedded assets (CSS, vendored JS).
func Static() http.Handler {
	sub, err := fs.Sub(assets, "static")
	if err != nil {
		panic(err)
	}
	return http.FileServerFS(sub)
}
