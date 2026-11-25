FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production
COPY Bot/package.json Bot/bun.lock ./
# パッチ済み依存 (pglite-socket) 用。Bot/package.jsonのpatchedDependenciesが参照する
COPY patches/ ./patches/
RUN bun install --frozen-lockfile --production
RUN groupadd --gid 10001 appuser && useradd --uid 10001 --gid appuser --create-home appuser
COPY --chown=appuser:appuser Bot/ .
COPY --chown=appuser:appuser shared/ /shared/
USER appuser
CMD ["bun", "src/main.ts"]
