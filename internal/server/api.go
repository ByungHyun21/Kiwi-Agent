package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/ByungHyun21/Kiwi-Agent/internal/protocol"
	"github.com/ByungHyun21/Kiwi-Agent/internal/server/store"
)

// apiAuth guards API endpoints with the bearer token.
func (s *Server) apiAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		token, ok := strings.CutPrefix(auth, "Bearer ")
		if !ok || token == "" {
			token = r.URL.Query().Get("token")
		}
		if token != s.token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func readJSON(r *http.Request, v any) error {
	return json.NewDecoder(r.Body).Decode(v)
}

func (s *Server) apiRoutes() {
	m := s.mux
	m.Handle("GET /api/machines", s.apiAuth(http.HandlerFunc(s.apiListMachines)))
	m.Handle("POST /api/machines", s.apiAuth(http.HandlerFunc(s.apiSaveMachine)))
	m.Handle("DELETE /api/machines/{name}", s.apiAuth(http.HandlerFunc(s.apiDeleteMachine)))

	m.Handle("GET /api/projects", s.apiAuth(http.HandlerFunc(s.apiListProjects)))
	m.Handle("POST /api/projects", s.apiAuth(http.HandlerFunc(s.apiCreateProject)))
	m.Handle("DELETE /api/projects/{id}", s.apiAuth(http.HandlerFunc(s.apiDeleteProject)))

	m.Handle("GET /api/sessions", s.apiAuth(http.HandlerFunc(s.apiListSessions)))
	m.Handle("GET /api/usage", s.apiAuth(http.HandlerFunc(s.apiUsage)))

	m.Handle("GET /api/models", s.apiAuth(http.HandlerFunc(s.apiModels)))
	m.Handle("GET /api/roles/{role}", s.apiAuth(http.HandlerFunc(s.apiGetRole)))
	m.Handle("PUT /api/roles/{role}", s.apiAuth(http.HandlerFunc(s.apiSetRole)))

	m.Handle("GET /api/health", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}))
}

func (s *Server) apiListMachines(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.Machines()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, 200, list)
}

func (s *Server) apiSaveMachine(w http.ResponseWriter, r *http.Request) {
	var m protocol.Machine
	if err := readJSON(r, &m); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if m.Name == "" || m.Host == "" || m.User == "" {
		http.Error(w, "name, host, user required", 400)
		return
	}
	if m.Port == 0 {
		m.Port = 22
	}
	if err := s.store.SaveMachine(m); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, 200, m)
}

func (s *Server) apiDeleteMachine(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteMachine(r.PathValue("name")); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.WriteHeader(204)
}

func (s *Server) apiListProjects(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.Projects()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, 200, list)
}

func (s *Server) apiCreateProject(w http.ResponseWriter, r *http.Request) {
	var p protocol.Project
	if err := readJSON(r, &p); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if p.Name == "" || p.Machine == "" || p.Workdir == "" {
		http.Error(w, "name, machine, workdir required", 400)
		return
	}
	created, err := s.store.CreateProject(p)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, 201, created)
}

func (s *Server) apiDeleteProject(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if id <= 0 {
		http.Error(w, "bad id", 400)
		return
	}
	if err := s.store.DeleteProject(id); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.WriteHeader(204)
}

func (s *Server) apiListSessions(w http.ResponseWriter, r *http.Request) {
	var projectID int64
	if v := r.URL.Query().Get("project"); v != "" {
		projectID, _ = strconv.ParseInt(v, 10, 64)
	}
	list, err := s.store.Sessions(projectID)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, 200, list)
}

func (s *Server) apiUsage(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("session")
	if id == "" {
		http.Error(w, "session required", 400)
		return
	}
	sess, err := s.store.Session(id)
	if err != nil {
		http.Error(w, err.Error(), 404)
		return
	}
	writeJSON(w, 200, map[string]int64{
		"promptTokens":     sess.PromptTokens,
		"completionTokens": sess.CompletionTokens,
		"totalTokens":      sess.PromptTokens + sess.CompletionTokens,
	})
}

func (s *Server) apiModels(w http.ResponseWriter, r *http.Request) {
	roleName := r.URL.Query().Get("role")
	if roleName == "" {
		roleName = "agent-chat"
	}
	models, err := s.modelsForRole(r.Context(), roleName)
	if err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	writeJSON(w, 200, models)
}

func (s *Server) apiGetRole(w http.ResponseWriter, r *http.Request) {
	role, err := s.store.Role(r.PathValue("role"))
	if err != nil {
		http.Error(w, err.Error(), 404)
		return
	}
	writeJSON(w, 200, role)
}

func (s *Server) apiSetRole(w http.ResponseWriter, r *http.Request) {
	var role struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
	}
	if err := readJSON(r, &role); err != nil || role.Provider == "" || role.Model == "" {
		http.Error(w, "provider, model required", 400)
		return
	}
	if err := s.store.SetRole(store.Role{Role: r.PathValue("role"), Provider: role.Provider, Model: role.Model}); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, 200, role)
}
