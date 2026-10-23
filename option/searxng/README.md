# SearXNG (optional)

Kiwi itself does not require Docker. This folder is only for running a local
SearXNG instance as the agent's web-search backend.

```sh
cd option/searxng
docker compose up -d
```

Verify the JSON API:

```sh
curl 'http://127.0.0.1:8888/search?q=test&format=json'
```

Then open Kiwi → 관리 → 검색엔진 and enter:

```text
http://127.0.0.1:8888
```

`settings.yml` enables the JSON API and disables the limiter/image proxy. The
container binds to `127.0.0.1` only. If the Kiwi server runs on another
machine, change the port mapping in `docker-compose.yml` to `8888:8080`, make
sure the firewall allows it, and enter `http://<host-ip>:8888` in Kiwi.

Stop or remove it with:

```sh
docker compose down
```
