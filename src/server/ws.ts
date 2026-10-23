// The agent WebSocket endpoint: one connection, one SessionRuntime. Transport
// (attach/send/close) and message routing live here; session behavior lives in
// session.ts.

import {
  EvHello,
  MsgBtw,
  MsgBtwSides,
  MsgCat,
  MsgCompact,
  MsgNew,
  MsgPathComplete,
  MsgProject,
  MsgResume,
  MsgSend,
  MsgSessions,
  MsgSessionCd,
  MsgSessionHost,
  MsgSetGoal,
  MsgSetThink,
  MsgState,
  MsgStop,
  type ClientMsg,
  type Event,
} from "../shared/protocol.ts";
import type { KiwiServer } from "./server.ts";
import { SessionRuntime } from "./session.ts";

/** Conn is one WebSocket connection to the server. */
export class Conn {
  srv: KiwiServer;
  ws: Bun.ServerWebSocket<unknown> | null = null;
  private runtime: SessionRuntime;

  constructor(srv: KiwiServer) {
    this.srv = srv;
    this.runtime = new SessionRuntime(srv, (e) => this.send(e));
  }

  attach(ws: Bun.ServerWebSocket<unknown>): void {
    this.ws = ws;
  }

  onOpen(): void {
    this.send({ type: EvHello });
    this.runtime.pushSessions(0);
    this.runtime.pushState();
  }

  onMessage(data: string | Uint8Array): void {
    if (typeof data !== "string") return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data) as ClientMsg;
    } catch {
      return;
    }
    this.handle(msg);
  }

  onClose(): void {
    this.ws = null;
    this.runtime.shutdown();
  }

  send(e: Event): void {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify(e));
    } catch (err) {
      console.error("ws write:", err);
    }
  }

  handle(msg: ClientMsg): void {
    switch (msg.type) {
      case MsgSend:
        this.runtime.send(msg.text ?? "");
        return;
      case MsgStop:
        this.runtime.stop();
        return;
      case MsgProject:
        this.runtime.selectProject(msg.text ?? "");
        return;
      case MsgNew:
        this.runtime.newSession(msg.text ?? "");
        return;
      case MsgResume:
        this.runtime.resume(msg.sessionId ?? "");
        return;
      case MsgSessions:
        this.runtime.pushSessions();
        return;
      case MsgState:
        this.runtime.pushState();
        return;
      case MsgSetGoal:
        this.runtime.setGoal(msg.text ?? "");
        return;
      case MsgSetThink:
        this.runtime.setThink(msg.text ?? "auto");
        return;
      case MsgCompact:
        void this.runtime.compact();
        return;
      case MsgBtw:
        void this.runtime.btw(msg.text ?? "", msg.sessionId);
        return;
      case MsgBtwSides:
        this.runtime.pushSides();
        return;
      case MsgSessionCd:
        this.runtime.setWorkdir(msg.text ?? "");
        return;
      case MsgSessionHost:
        this.runtime.setMachine(msg.text ?? "");
        return;
      case MsgCat:
        void this.runtime.cat(msg.text ?? "");
        return;
      case MsgPathComplete:
        void this.runtime.pathComplete(msg.text ?? "");
        return;
    }
  }
}
