package server

import (
	"net/http"

	"github.com/ByungHyun21/Kiwi-Agent/internal/web"
)

func (s *Server) settingsPage(w http.ResponseWriter, r *http.Request) {
	provider, baseURL, model := "", "", ""
	if role, err := s.store.Role("agent-chat"); err == nil {
		provider = role.Provider
		model = role.Model
		if ps, err := s.store.Providers(); err == nil {
			for _, p := range ps {
				if p.Name == provider {
					baseURL = p.BaseURL
				}
			}
		}
	}
	page(web.Settings(s.token, provider, baseURL, model))(w, r)
}

func (s *Server) machinesPage(w http.ResponseWriter, r *http.Request) {
	machines, _ := s.store.Machines()
	page(web.Machines(machines))(w, r)
}
