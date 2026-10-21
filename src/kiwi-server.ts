// kiwi-server entrypoint.

import { loadServerConfig } from "./server/config.ts";
import { KiwiServer } from "./server/server.ts";
import { Conn } from "./server/ws.ts";
import { SSHRunner } from "./ssh.ts";
import { Store } from "./store.ts";

function main(): void {
  const config = loadServerConfig(process.argv.slice(2));

  const st = Store.open(`${config.dataDir}/server.db`);
  const runner = new SSHRunner(st, { knownHostsDir: config.dataDir });
  const srv = new KiwiServer(st, runner, config);

  const port = Number(config.addr.startsWith(":") ? config.addr.slice(1) : config.addr.split(":").pop());
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
    hostname: config.addr.includes(":") && !config.addr.startsWith(":") ? config.addr.split(":")[0] : undefined,
    fetch: (req, server) => srv.handle(req, server),
    websocket: wsHandlers,
  });
  console.log(`kiwi-server listening on http://localhost:${port} (token ${srv.token})`);
}

main();
