// kiwi-server entrypoint.

import { Store } from "./store.ts";
import { SSHRunner } from "./ssh.ts";
import { KiwiServer } from "./server/server.ts";
import { Conn } from "./server/ws.ts";

function main(): void {
  let addr = ":5494";
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-addr" || args[i] === "--addr") {
      addr = args[i + 1] ?? addr;
      i++;
    } else if (args[i]!.startsWith("--addr=")) {
      addr = args[i]!.slice("--addr=".length);
    }
  }

  let dataDir = process.env.KIWI_DATA ?? "";
  if (dataDir === "") {
    dataDir = `${process.env.HOME ?? "."}/.local/share/kiwi`;
  }

  const st = Store.open(`${dataDir}/server.db`);
  const runner = new SSHRunner(st, { knownHostsDir: dataDir });
  const srv = new KiwiServer(st, runner);

  const port = Number(addr.startsWith(":") ? addr.slice(1) : addr.split(":").pop());
  const wsHandlers = {
    open: (ws: Bun.ServerWebSocket<unknown>) => {
      (ws.data as Conn).attach(ws);
      (ws.data as Conn).onOpen();
    },
    message: (ws: Bun.ServerWebSocket<unknown>, message: string | Uint8Array) => {
      (ws.data as Conn).onMessage(message);
    },
    close: (ws: Bun.ServerWebSocket<unknown>) => {
      (ws.data as Conn).onClose();
    },
  };

  Bun.serve({
    port: Number.isFinite(port) && port > 0 ? port : 5494,
    hostname: addr.includes(":") && !addr.startsWith(":") ? addr.split(":")[0] : undefined,
    fetch: (req, server) => srv.handle(req, server),
    websocket: wsHandlers,
  });
  console.log(`kiwi-server listening on http://localhost:${port} (token ${srv.token})`);
}

main();
