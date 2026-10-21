# kiwi-server + web SPA (OpenTUI TUI included in the binary)
FROM oven/bun:1 AS build
WORKDIR /app
COPY web/package.json web/bun.lock* ./web/
RUN cd web && bun install
COPY src ./src
COPY tsconfig.json ./
COPY web ./web
RUN cd web && bun install && bun run build

FROM oven/bun:1
# system ssh client is used for remote exec on work machines
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV KIWI_DATA=/data KIWI_WEB_DIST=/app/web/dist
COPY src ./src
COPY tsconfig.json ./
COPY --from=build /app/web/dist ./web/dist
EXPOSE 6002
CMD ["bun", "run", "src/kiwi-server.ts", "--addr", "0.0.0.0:6002"]
