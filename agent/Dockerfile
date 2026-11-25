# AIコマンド実行専用コンテナ (秘密なし・ネットワークあり)
# リポジトリの agent/ ディレクトリをコンテキストにビルドする:
#   docker build -t ghcr.io/y-exe/discord-analytics-agent -f agent/Dockerfile agent
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git jq procps findutils netcat-openbsd iputils-ping dnsutils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /work
COPY server.js /app/server.js

ENV AGENT_SOCKET=/agent-sock/agent.sock \
    AGENT_WORKDIR=/work \
    NODE_ENV=production

USER node
CMD ["node", "/app/server.js"]
