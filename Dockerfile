# 의존성 0 — npm install 없음. 서버 1프로세스 + SQLite 볼륨.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY policy ./policy
COPY kb ./kb
COPY web ./web
# 운영 기본은 실발송(smtp). SMTP_HOST·SMTP_FROM·MAIL_ALLOWED_DOMAINS를 넣어야 나간다(허용 목록이 비면 전부 차단).
# 발송 없는 시연만 MAIL_PROVIDER=mock + ALLOW_MOCK_MAIL=1 — 이 둘이 없으면 production에서 mock은 시작을 거부한다.
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/cs-agent.db \
    LLM_PROVIDER=anthropic \
    MAIL_PROVIDER=smtp
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "server/index.js"]
