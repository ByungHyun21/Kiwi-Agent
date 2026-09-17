// Package server hosts the kiwi HTTP surface: the web UI, REST API and
// the agent WebSocket endpoint.
package server

import (
	"context"
	"fmt"
	"net/http"

	"github.com/a-h/templ"

	"github.com/ByungHyun21/Kiwi-Agent/internal/agentcore"
	"github.com/ByungHyun21/Kiwi-Agent/internal/exec"
	"github.com/ByungHyun21/Kiwi-Agent/internal/llm"
	"github.com/ByungHyun21/Kiwi-Agent/internal/protocol"
	"github.com/ByungHyun21/Kiwi-Agent/internal/server/store"
	"github.com/ByungHyun21/Kiwi-Agent/internal/web"
)

// Server assembles all kiwi-server HTTP handlers.
type Server struct {
	mux    *http.ServeMux
	store  *store.Store
	token  string
	runner exec.Runner
}

// New builds a Server around a store and a tool runner.
func New(st *store.Store, runner exec.Runner) (*Server, error) {
	token, err := st.Token()
	if err != nil {
		return nil, err
	}
	s := &Server{mux: http.NewServeMux(), store: st, token: token, runner: runner}
	s.routes()
	return s, nil
}

// Token exposes the auth token (for the web UI settings page).
func (s *Server) Token() string { return s.token }

// Handler returns the root handler.
func (s *Server) Handler() http.Handler { return s.mux }

func (s *Server) routes() {
	// pages
	s.mux.HandleFunc("GET /{$}", page(web.Dashboard()))
	s.mux.HandleFunc("GET /machines", s.machinesPage)
	s.mux.HandleFunc("GET /settings", s.settingsPage)
	s.mux.HandleFunc("GET /docs", page(web.Docs()))
	s.mux.Handle("GET /static/", http.StripPrefix("/static/", web.Static()))

	// api + ws
	s.apiRoutes()
	s.mux.HandleFunc("GET /ws", s.handleWS)
}

func page(c templ.Component) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		c.Render(r.Context(), w)
	}
}

// agentFor builds the agent runtime for a session's project.
func (s *Server) agentFor(sessionID string) (*agentcore.Agent, error) {
	sess, err := s.store.Session(sessionID)
	if err != nil {
		return nil, fmt.Errorf("세션을 찾을 수 없습니다: %w", err)
	}
	project, err := s.store.Project(sess.ProjectID)
	if err != nil {
		return nil, fmt.Errorf("프로젝트를 찾을 수 없습니다: %w", err)
	}
	machine, err := s.store.Machine(project.Machine)
	if err != nil {
		return nil, fmt.Errorf("기기를 찾을 수 없습니다: %w", err)
	}
	client, err := s.llmForRole("agent-chat")
	if err != nil {
		return nil, err
	}
	return &agentcore.Agent{
		LLM:     client,
		Runner:  s.runner,
		Machine: machine,
		Workdir: project.Workdir,
		Store:   s.store,
	}, nil
}

// llmForRole resolves a role to a provider client.
func (s *Server) llmForRole(role string) (*llm.Client, error) {
	r, err := s.store.Role(role)
	if err != nil {
		return nil, fmt.Errorf("역할 %s 이 설정되지 않았습니다 (웹UI 설정 확인)", role)
	}
	providers, err := s.store.Providers()
	if err != nil {
		return nil, err
	}
	for _, p := range providers {
		if p.Name == r.Provider {
			return llm.New(p.BaseURL, p.APIKey, r.Model), nil
		}
	}
	return nil, fmt.Errorf("공급자 %s 를 찾을 수 없습니다", r.Provider)
}

// modelsForRole lists models of the provider behind a role.
func (s *Server) modelsForRole(ctx context.Context, role string) ([]string, error) {
	client, err := s.llmForRole(role)
	if err != nil {
		return nil, err
	}
	return client.ListModels(ctx)
}

// panelState assembles the live sidebar state for a session.
func (s *Server) panelState(sessionID, projectName string) *protocol.PanelState {
	state := &protocol.PanelState{Project: projectName}
	if r, err := s.store.Role("agent-chat"); err == nil {
		state.Model = r.Model
	}
	ctxMax := 128000
	if v, err := s.store.Setting("ctx_max"); err == nil && v != "" {
		fmt.Sscanf(v, "%d", &ctxMax)
	}
	state.CtxMax = ctxMax
	if sessionID == "" {
		return state
	}
	sess, err := s.store.Session(sessionID)
	if err != nil {
		return state
	}
	state.Goal = sess.Goal
	state.Tokens = int(sess.PromptTokens + sess.CompletionTokens)
	if p, err := s.store.Project(sess.ProjectID); err == nil {
		state.Project = p.Name
		state.Machine = p.Machine
	}
	// gauge uses the session's latest context estimate: prompt+completion of the last call
	if sess.PromptTokens+sess.CompletionTokens > 0 {
		// cumulative is an upper bound estimate until per-call tracking lands
		state.CtxUsed = min(int(sess.PromptTokens+sess.CompletionTokens), ctxMax)
	}
	return state
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
