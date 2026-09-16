package tui

// Lang is a UI language code.
type Lang string

const (
	LangKo Lang = "ko"
	LangEn Lang = "en"
	LangZh Lang = "zh"
	LangJa Lang = "ja"
)

// defaultLang is used when no preference is stored.
const defaultLang = LangKo

// langOrder drives the /language subcommand popup.
var langOrder = []Lang{LangKo, LangEn, LangZh, LangJa}

// langNames are native names shown in the popup.
var langNames = map[Lang]string{
	LangKo: "한국어",
	LangEn: "English",
	LangZh: "中文",
	LangJa: "日本語",
}

func validLang(l Lang) bool {
	_, ok := langNames[l]
	return ok
}

// msgs holds every user-facing string in the TUI.
type msgs struct {
	Placeholder     string
	Connected       string
	Disconnected    string
	ProjectLabel    string
	SessionLabel    string
	None            string
	NoSessions      string
	HelpLeft        string
	HelpRight       string
	ServerUsage     string
	LanguageUsage   string
	LanguageChanged string // one %s: native language name
	SaveFailed      string
	CmdDescs        map[string]string
}

var translations = map[Lang]msgs{
	LangKo: {
		Placeholder:     "메시지 입력 · / 를 입력하면 명령어 보기",
		Connected:       "서버 연결됨",
		Disconnected:    "서버 연결 끊김",
		ProjectLabel:    "프로젝트",
		SessionLabel:    "세션",
		None:            "없음",
		NoSessions:      "세션 없음",
		HelpLeft:        "명령어: / · 선택 ↑↓ Tab · Esc 닫기",
		HelpRight:       "/exit 종료",
		ServerUsage:     "사용법: /server <호스트:포트>",
		LanguageUsage:   "사용법: /language <ko|en|zh|ja>",
		LanguageChanged: "언어가 변경되었습니다: %s",
		SaveFailed:      "설정 저장 실패",
		CmdDescs: map[string]string{
			"/project":  "프로젝트 선택 · 전환",
			"/new":      "새 세션 시작",
			"/resume":   "세션 이어하기",
			"/stop":     "작업 중단",
			"/exit":     "kiwi 종료",
			"/skill":    "스킬 관리",
			"/model":    "모델 변경",
			"/btw":      "사이드 질문 (본 흐름 유지)",
			"/update":   "kiwi 자가 업데이트",
			"/goal":     "목표 확인 · 설정",
			"/queue":    "프롬프트 대기열 추가",
			"/usage":    "토큰 사용량 확인",
			"/git":      "git 작업 (branch · fork …)",
			"/mcp":      "MCP 서버 관리",
			"/compact":  "컨텍스트 압축",
			"/rename":   "세션 이름 변경",
			"/init":     "프로젝트 초기화",
			"/language": "언어 변경",
		},
	},
	LangEn: {
		Placeholder:     "Type a message · press / for commands",
		Connected:       "Server connected",
		Disconnected:    "Server disconnected",
		ProjectLabel:    "Project",
		SessionLabel:    "Sessions",
		None:            "None",
		NoSessions:      "No sessions",
		HelpLeft:        "Commands: / · select ↑↓ Tab · Esc close",
		HelpRight:       "/exit quit",
		ServerUsage:     "Usage: /server <host:port>",
		LanguageUsage:   "Usage: /language <ko|en|zh|ja>",
		LanguageChanged: "Language changed: %s",
		SaveFailed:      "Failed to save settings",
		CmdDescs: map[string]string{
			"/project":  "Select / switch project",
			"/new":      "Start a new session",
			"/resume":   "Resume a session",
			"/stop":     "Stop work",
			"/exit":     "Quit kiwi",
			"/skill":    "Manage skills",
			"/model":    "Change model",
			"/btw":      "Side question (keeps main flow)",
			"/update":   "Self-update kiwi",
			"/goal":     "View / set goal",
			"/queue":    "Queue a prompt",
			"/usage":    "Token usage",
			"/git":      "git actions (branch · fork …)",
			"/mcp":      "Manage MCP servers",
			"/compact":  "Compact context",
			"/rename":   "Rename session",
			"/init":     "Initialize project",
			"/language": "Change language",
		},
	},
	LangZh: {
		Placeholder:     "输入消息 · 输入 / 查看命令",
		Connected:       "服务器已连接",
		Disconnected:    "服务器未连接",
		ProjectLabel:    "项目",
		SessionLabel:    "会话",
		None:            "无",
		NoSessions:      "暂无会话",
		HelpLeft:        "命令: / · 选择 ↑↓ Tab · Esc 关闭",
		HelpRight:       "/exit 退出",
		ServerUsage:     "用法: /server <host:port>",
		LanguageUsage:   "用法: /language <ko|en|zh|ja>",
		LanguageChanged: "语言已切换: %s",
		SaveFailed:      "保存设置失败",
		CmdDescs: map[string]string{
			"/project":  "选择 / 切换项目",
			"/new":      "新建会话",
			"/resume":   "继续会话",
			"/stop":     "停止任务",
			"/exit":     "退出 kiwi",
			"/skill":    "技能管理",
			"/model":    "切换模型",
			"/btw":      "侧问 (保持主流程)",
			"/update":   "kiwi 自更新",
			"/goal":     "查看 / 设定目标",
			"/queue":    "添加提示词队列",
			"/usage":    "查看令牌用量",
			"/git":      "git 操作 (branch · fork …)",
			"/mcp":      "MCP 服务器管理",
			"/compact":  "压缩上下文",
			"/rename":   "重命名会话",
			"/init":     "初始化项目",
			"/language": "切换语言",
		},
	},
	LangJa: {
		Placeholder:     "メッセージ入力 · / でコマンド一覧",
		Connected:       "サーバー接続済み",
		Disconnected:    "サーバー未接続",
		ProjectLabel:    "プロジェクト",
		SessionLabel:    "セッション",
		None:            "なし",
		NoSessions:      "セッションなし",
		HelpLeft:        "コマンド: / · 選択 ↑↓ Tab · Esc で閉じる",
		HelpRight:       "/exit 終了",
		ServerUsage:     "使い方: /server <host:port>",
		LanguageUsage:   "使い方: /language <ko|en|zh|ja>",
		LanguageChanged: "言語を変更しました: %s",
		SaveFailed:      "設定の保存に失敗",
		CmdDescs: map[string]string{
			"/project":  "プロジェクト選択・切替",
			"/new":      "新規セッション開始",
			"/resume":   "セッション再開",
			"/stop":     "作業停止",
			"/exit":     "kiwi 終了",
			"/skill":    "スキル管理",
			"/model":    "モデル変更",
			"/btw":      "サイド質問 (本体の流れを維持)",
			"/update":   "kiwi 自己更新",
			"/goal":     "目標の確認・設定",
			"/queue":    "プロンプトキュー追加",
			"/usage":    "トークン使用量確認",
			"/git":      "git 操作 (branch · fork …)",
			"/mcp":      "MCP サーバー管理",
			"/compact":  "コンテキスト圧縮",
			"/rename":   "セッション名変更",
			"/init":     "プロジェクト初期化",
			"/language": "言語変更",
		},
	},
}

// t returns the string table for the current language.
func (m Model) t() msgs { return translations[m.lang] }
