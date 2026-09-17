// Package tui renders the kiwi agent terminal client: server connection,
// raw streaming transcript, command popup, fullscreen menus and sidebar.
package tui

import (
	"os"
	"path/filepath"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/ByungHyun21/Kiwi-Agent/internal/protocol"
)

// Model is the bubbletea model for the kiwi client.
type Model struct {
	// connection
	msgIn     textinput.Model
	addr      string
	token     string
	client    *wsClient
	connected bool

	// live session state (mirrors the server panel)
	project  string
	machine  string
	model    string
	provider string
	goal     string
	todos    []string
	ctxUsed  int
	ctxMax   int
	tokens   int
	curTool  string // tool currently executing (spinner hint)

	// server-side lists
	sessions       []string
	sessionIDs     []protocol.SessionInfo
	currentSession string
	projects       []protocol.Project
	machines       []protocol.Machine
	wantProject    string

	// transcript
	transcript   []tline
	streamKind   int
	scroll       int    // -1 = follow bottom
	toolArgsName string // name of the call whose args are streaming
	busy         bool
	spinner      int

	// ui chrome
	lang      Lang
	notice    string
	popupSel  int
	popupGone bool
	menu      *menu
	width     int
	height    int
}

var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

func (m Model) hasServer() bool { return m.addr != "" }

// New returns the initial model, starting directly at the main screen.
// The language and server preferences are loaded from disk.
func New() Model {
	cfg := loadConfig()
	in := textinput.New()
	in.Placeholder = translations[Lang(cfg.Language)].Placeholder
	in.Prompt = "> "
	in.CharLimit = 4000
	in.Focus()
	return Model{
		msgIn:  in,
		lang:   Lang(cfg.Language),
		addr:   cfg.Server,
		token:  cfg.Token,
		scroll: -1,
	}
}

// Init implements tea.Model. Auto-connects when a server is configured.
func (m Model) Init() tea.Cmd {
	if m.addr != "" && m.token != "" {
		return tea.Batch(textinput.Blink, dialServer(m.addr, m.token))
	}
	return textinput.Blink
}

// Run starts the kiwi terminal client.
func Run() error {
	_, err := tea.NewProgram(New(), tea.WithAltScreen(), tea.WithMouseCellMotion()).Run()
	return err
}

// afterConnect pulls role and machine data after a fresh connection.
func (m Model) afterConnect() tea.Cmd {
	return tea.Batch(fetchRole(m.addr, m.token), fetchMachines(m.addr, m.token))
}

// tick drives the spinner animation while busy.
func tick() tea.Cmd {
	return tea.Tick(120*time.Millisecond, func(time.Time) tea.Msg { return tickMsg{} })
}

// machineDefault / workdirDefault fill project creation defaults.
func (m Model) machineDefault() string { return "local" }

func (m Model) workdirDefault() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Desktop", "workspace", m.wantProject)
}
