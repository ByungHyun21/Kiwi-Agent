// Tool schemas exposed to the model.

import type { Tool } from "../../llm.ts";

export const agentTools: Tool[] = [
  {
    name: "write_file",
    description: "작업 폴더에 파일을 생성하거나 전체 내용을 덮어씁니다. 새 파일이나 전체 재작성 시에만 사용하세요.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "상대 경로, 예: index.html" },
        content: { type: "string", description: "파일의 전체 새 내용" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "read_file",
    description: "작업 폴더의 파일 내용을 읽습니다. tagged:true면 줄마다 N#TAG│ 접두가 붙습니다.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        tagged: { type: "boolean", description: "줄 태그 포함(정밀 줄 편집용)" },
      },
      required: ["path"],
    },
  },
  {
    name: "edit",
    description: "파일의 일부를 문자열 치환으로 수정합니다. 각 oldText는 파일에서 정확히 한 번 나타나야 합니다.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "상대 경로" },
        lineEdits: {
          type: "array",
          description: "pos 태그 기반 줄 편집(read_file tagged:true의 N#TAG 사용). edits 대신 사용",
          items: {
            type: "object",
            properties: {
              pos: { type: "string", description: "예: 12#ABC" },
              op: { type: "string", description: "replace | insertBefore | insertAfter | delete" },
              newText: { type: "string" },
            },
            required: ["pos"],
          },
        },
        edits: {
          type: "array",
          description: "순서대로 적용할 치환 목록",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "파일에서 찾을 유일한 텍스트" },
              newText: { type: "string", description: "새 텍스트" },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "edits"],
    },
  },
  {
    name: "list_dir",
    description: "작업 폴더(또는 하위 폴더)의 항목 목록을 봅니다.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "기본값: 작업 폴더 루트" },
      },
    },
  },
  {
    name: "grep",
    description: "정규식으로 파일 내용을 검색합니다(rg 우선, grep 폴백). 결과는 파일:줄:내용 형식입니다.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "검색 패턴" },
        include: { type: "string", description: "파일명 글롭 필터, 예: *.ts" },
        path: { type: "string", description: "기본값: 작업 폴더 전체" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "glob",
    description: "파일명 패턴(예: **/*.py)으로 파일을 찾습니다. 최근 수정 순으로 최대 100건.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "기본값: 작업 폴더 루트" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "lsp_status",
    description: "LSP 데몬(작업 머신의 언어서버) 상태를 조회합니다.",
    parameters: {
      type: "object",
      properties: {
        lang: { type: "string", description: "기본값: typescript" },
      },
    },
  },
  {
    name: "lsp_diagnostics",
    description: "파일의 컴파일/정적 오류를 언어서버 진단으로 조회합니다(ts/py/go/rust/c/cpp/cs/java/js). 첫 호출은 서버 기동에 수 초~수십 초 걸릴 수 있습니다.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "상대 경로" },
      },
      required: ["path"],
    },
  },
  {
    name: "lsp_definition",
    description: "심볼의 정의 위치로 이동 정보를 얻습니다. line/character는 1-based.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
      },
      required: ["path", "line", "character"],
    },
  },
  {
    name: "lsp_references",
    description: "심볼의 모든 참조 위치를 조회합니다. line/character는 1-based.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
      },
      required: ["path", "line", "character"],
    },
  },
  {
    name: "lsp_symbols",
    description: "파일의 심볼 목록(이름·종류·줄)을 조회합니다.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "monitor_start",
    description: "셸 명령을 백그라운드에서 시작하고 감시합니다(서버 기동, 로그 감시 등). 즉시 monitor id를 반환합니다.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "예: python3 -m http.server 8000" },
        label: { type: "string", description: "선택: 표시 이름" },
      },
      required: ["command"],
    },
  },
  {
    name: "monitor_output",
    description: "감시 중인 명령의 새 출력을 받아옵니다. running:true면 아직 진행 중이니 적절히 다시 호출하세요.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "monitor_stop",
    description: "감시 중인 명령을 중지합니다.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "monitor_list",
    description: "모니터 목록(id, 라벨, 실행 여부, 출력 바이트)을 반환합니다.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "run",
    description: "작업 폴더에서 셸 명령을 실행합니다(빌드, 테스트, 실행 등). 명령은 직접 실행되며 경로 이동 없이 작업 폴더에서 시작됩니다.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "예: python3 gugudan.py" },
        timeoutMs: { type: "number", description: "선택: 시간 제한(ms, 최대 600000). 기본 120000" },
      },
      required: ["command"],
    },
  },
  {
    name: "session_search",
    description: "과거 세션을 포함한 모든 대화 기록을 전문 검색합니다.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "기본 10" },
      },
      required: ["query"],
    },
  },
  {
    name: "session_read",
    description: "세션 대화 기록을 읽습니다. sessionId 생략 시 현재 세션의 최근 메시지를 반환합니다.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "기본값: 현재 세션" },
        limit: { type: "number", description: "끝에서부터의 메시지 수, 기본 20" },
      },
    },
  },
];

export const READ_ONLY_TOOLS = new Set(["read_file", "list_dir", "grep", "glob", "session_search", "session_read", "monitor_output", "monitor_list", "lsp_status", "lsp_diagnostics", "lsp_definition", "lsp_references", "lsp_symbols"]);

