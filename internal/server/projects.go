package server

import (
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/ByungHyun21/Kiwi-Agent/internal/protocol"
	"github.com/ByungHyun21/Kiwi-Agent/internal/server/store"
	"github.com/ByungHyun21/Kiwi-Agent/internal/web"
)

func (s *Server) projectsPage(w http.ResponseWriter, r *http.Request) {
	projects, err := s.store.Projects()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	page(web.ProjectsList(projects))(w, r)
}

func (s *Server) projectPage(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}
	p, err := s.store.Project(id)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	sessions, err := s.store.Sessions(id)
	if err != nil {
		log.Printf("sessions: %v", err)
	}
	page(web.ProjectDetail(p, sessions))(w, r)
}

func (s *Server) sessionPage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sess, err := s.store.Session(id)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	p, _ := s.store.Project(sess.ProjectID)
	sessions, _ := s.store.Sessions(sess.ProjectID)

	info := protocol.SessionInfo{ID: sess.ID, Name: sess.Name, UpdatedAt: sess.UpdatedAt}
	for _, si := range sessions {
		if si.ID == sess.ID {
			info = si
		}
	}

	msgs, err := s.store.Messages(id)
	if err != nil {
		log.Printf("messages: %v", err)
	}
	page(web.SessionDetail(p.Name, info, toUIMessages(msgs)))(w, r)
}

func toUIMessages(msgs []store.Message) []web.UIMessage {
	out := make([]web.UIMessage, 0, len(msgs))
	for _, m := range msgs {
		um := web.UIMessage{Role: m.Role, Content: m.Content}
		var tools []string
		for _, tc := range m.ToolCalls {
			tools = append(tools, tc.Name+" "+tc.Args)
		}
		um.Tools = strings.Join(tools, "\n")
		out = append(out, um)
	}
	return out
}
