// Store tests: machines, projects, sessions, messages, queue, token.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NotFoundError, Store } from "../src/store.ts";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "kiwi-store-"));
  store = Store.open(path.join(dir, "server.db"));
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("Store", () => {
  test("token is stable across reopens", () => {
    const t1 = store.token();
    expect(t1).toMatch(/^[a-f0-9]{48}$/);
    const t2 = Store.open(path.join(dir, "server.db")).token();
    expect(t2).toBe(t1);
  });

  test("machine CRUD", () => {
    store.saveMachine({ name: "box1", host: "h", port: 22, user: "u", state: "" });
    const m = store.machine("box1");
    expect(m.name).toBe("box1");
    expect(m.state).toBe("unknown"); // defaulted
    store.touchMachine("box1", "connected");
    expect(store.machine("box1").state).toBe("connected");
    store.saveHostKey("box1", "SHA256:abc");
    expect(store.machine("box1").hostKey).toBe("SHA256:abc");
    expect(store.machines().map((x) => x.name)).toEqual(["box1"]);
    store.deleteMachine("box1");
    expect(() => store.machine("box1")).toThrow(NotFoundError);
  });

  test("project CRUD + session flow", () => {
    store.saveMachine({ name: "m", host: "h", port: 22, user: "u", state: "" });
    const p = store.createProject({ id: 0, name: "demo", machine: "m", workdir: "/tmp/w" });
    expect(p.id).toBeGreaterThan(0);
    expect(store.projectByName("demo").workdir).toBe("/tmp/w");

    const sess = store.newSession(p.id, "");
    expect(sess.name).toBe("session " + sess.id);
    store.setGoal(sess.id, "테스트 목표");
    expect(store.session(sess.id).goal).toBe("테스트 목표");

    store.appendMessage(sess.id, { role: "user", content: "안녕" });
    store.appendMessage(sess.id, {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "write_file", args: "{}" }],
    });
    store.appendMessage(sess.id, { role: "tool", content: "결과", toolCallID: "c1", name: "write_file" });

    const msgs = store.messages(sess.id);
    expect(msgs).toHaveLength(3);
    expect(msgs[1]!.toolCalls![0]!.name).toBe("write_file");
    expect(msgs[2]!.toolCallID).toBe("c1");

    store.addUsage(sess.id, 10, 5);
    const reloaded = store.session(sess.id);
    expect(reloaded.promptTokens).toBe(10);
    expect(reloaded.completionTokens).toBe(5);

    // compact via replaceMessages
    store.replaceMessages(sess.id, [{ role: "user", content: "[요약]" }]);
    expect(store.messages(sess.id)).toHaveLength(1);
  });

  test("queue FIFO", () => {
    store.saveMachine({ name: "m", host: "h", port: 22, user: "u", state: "" });
    const p = store.createProject({ id: 0, name: "q", machine: "m", workdir: "/w" });
    const sess = store.newSession(p.id, "s");
    expect(store.dequeue(sess.id)).toBeNull();
    store.enqueue(sess.id, "첫번째");
    store.enqueue(sess.id, "두번째");
    expect(store.dequeue(sess.id)).toBe("첫번째");
    expect(store.dequeue(sess.id)).toBe("두번째");
    expect(store.dequeue(sess.id)).toBeNull();
  });

  test("providers and roles", () => {
    const providers = store.providers();
    expect(providers).toHaveLength(1); // seeded
    expect(providers[0]!.name).toBe("local");
    const role = store.role("agent-chat");
    expect(role.provider).toBe("local");
    store.setRole({ role: "agent-chat", provider: "local", model: "new-model" });
    expect(store.role("agent-chat").model).toBe("new-model");
  });

  test("settings upsert", () => {
    store.setSetting("ctx_max", "64000");
    expect(store.setting("ctx_max")).toBe("64000");
    store.setSetting("ctx_max", "32000");
    expect(store.setting("ctx_max")).toBe("32000");
    expect(store.setting("missing")).toBe("");
  });

  test("session location override (T01)", () => {
    store.saveMachine({ name: "m1", host: "h", port: 22, user: "u", state: "" });
    store.saveMachine({ name: "m2", host: "h2", port: 22, user: "u", state: "" });
    const p = store.createProject({ id: 0, name: "p1", machine: "m1", workdir: "/w1" });
    const s = store.newSession(p.id, "s1");
    expect(store.sessionLocation(s.id)).toEqual({ machine: "", workdir: "" });
    store.setSessionLocation(s.id, { machine: "m2", workdir: "/other" });
    expect(store.sessionLocation(s.id)).toEqual({ machine: "m2", workdir: "/other" });
    store.setSessionLocation(s.id, { workdir: "/third" });
    expect(store.sessionLocation(s.id)).toEqual({ machine: "m2", workdir: "/third" });
  });

  test("machine auth roundtrip, obfuscated at rest (T05)", () => {
    store.saveMachine({ name: "m1", host: "h", port: 22, user: "u", state: "" });
    expect(store.machineAuth("m1")).toBeNull();
    store.saveMachineAuth("m1", "yoon", "s3cret~패스");
    expect(store.machineAuth("m1")).toEqual({ user: "yoon", password: "s3cret~패스" });
  });

  test("message full-text search across sessions (A10)", () => {
    store.saveMachine({ name: "m1", host: "h", port: 22, user: "u", state: "" });
    const p = store.createProject({ id: 0, name: "p1", machine: "m1", workdir: "/w" });
    const s1 = store.newSession(p.id, "s1");
    const s2 = store.newSession(p.id, "s2");
    store.appendMessage(s1.id, { role: "user", content: "마이그레이션 버그를 수정해줘" });
    store.appendMessage(s2.id, { role: "assistant", content: "다른 주제에 대한 답변입니다" });
    const hits = store.searchMessages("마이그레이션", 10);
    expect(hits.length).toBe(1);
    expect(hits[0]!.sessionId).toBe(s1.id);
    expect(hits[0]!.snippet).toContain("마이그레이션");
    expect(store.searchMessages("존재안하는단어", 10)).toEqual([]);
    store.replaceMessages(s1.id, [{ role: "user", content: "컴팩트 후 요약" }]);
    expect(store.searchMessages("마이그레이션", 10)).toEqual([]);
    expect(store.searchMessages("컴팩트", 10).length).toBe(1);
  });
});
