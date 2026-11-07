# 의존성 0 — npm install 없음. 서버 1프로세스 + SQLite 볼륨.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY policy ./policy
COPY kb ./kb
COPY web ./web
# 미러 수신 어댑터·정보주체 요청·감사 내보내기도 같은 이미지·같은 볼륨으로 돌린다(node scripts/inbound-imap.js · scripts/subject-request.js · scripts/audit-export.js)
COPY scripts/inbound-imap.js scripts/subject-request.js scripts/audit-export.js ./scripts/
# 운영 기본은 실발송(smtp). SMTP_HOST·SMTP_FROM·MAIL_ALLOWED_DOMAINS를 넣어야 나간다(허용 목록이 비면 전부 차단).
# 발송 없는 시연만 MAIL_PROVIDER=mock + ALLOW_MOCK_MAIL=1 — 이 둘이 없으면 production에서 mock은 시작을 거부한다.
# HOST: 서버 기본 바인드는 127.0.0.1 — 컨테이너 안에서는 모든 인터페이스로 열어야 포트 매핑(-p 127.0.0.1:3000:3000)이 산다.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/app/data/cs-agent.db \
    LLM_PROVIDER=anthropic \
    MAIL_PROVIDER=smtp
# 앱 사용자가 쓰는 곳은 /app/data 뿐이다. kb/·policy/는 이미지 기본값이라 root 소유로 둔다(고객 KB·정책 원문은 DB에 있다).
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "server/index.js"]
