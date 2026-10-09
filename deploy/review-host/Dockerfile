# 審査用のホスト（ADR 0172、docs/play-store/review-host.md）。
# 審査モード（AGENT_HOST_REVIEW=1）の Pleiad を、fake のバックエンドだけで、画面なしで動かす。
# ビルドの文脈はリポジトリの根（Coolify の Base Directory は /、Dockerfile Location は /deploy/review-host/Dockerfile）。
FROM node:22-alpine

WORKDIR /app

# 実行に要る依存だけ入れる: devDependencies（electron など）・任意の依存（node-pty）・インストール時のスクリプトは入れない。
# 審査用のホストはシェルもブラウザーも使わない
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force

COPY core ./core
COPY web ./web
COPY assets ./assets
COPY skills ./skills
COPY deploy/review-host/entrypoint.sh /usr/local/bin/review-host-entrypoint

# 置き場は名前付きのボリューム 1 つだけ（/data）。ホストのフォルダーも Docker のソケットも渡さない
RUN chmod 0755 /usr/local/bin/review-host-entrypoint && mkdir -p /data && chown node:node /data

# 非 root。Linux の権限は付けず、書けるのは /data と /tmp だけにできる（--read-only --tmpfs /tmp が使える）
USER node

ENV AGENT_HOST_REVIEW=1 \
    AGENT_HOST_BACKENDS=fake \
    AGENT_HOST_LOCALE=en \
    AGENT_HOST_DATA=/data \
    AGENT_HOST_PORT=7420 \
    AGENT_HOST_BIND=127.0.0.1 \
    AGENT_HOST_GIT_SNAPSHOTS=off \
    AGENT_HOST_WORKTREES=off \
    AGENT_HOST_ANTHROPIC_API=off \
    AGENT_HOST_ROUTING_USAGE=off \
    NODE_ENV=production

VOLUME ["/data"]

# 生きているか（待ち受けていれば、トークンが無くて 401 でも「生きている」）。中継につながっているかはログに出る
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.AGENT_HOST_PORT || 7420) + '/').then(() => process.exit(0), () => process.exit(1))"

ENTRYPOINT ["review-host-entrypoint"]
