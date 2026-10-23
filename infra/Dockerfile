# Cred402 API + console — multi-stage production image.
# Stage 1 builds the React console; stage 2 runs the zero-extra-dep Node API
# (tsx) serving the built dashboard and the /api + /v1 surfaces.

FROM node:20-bookworm-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json* ./
COPY frontend/package.json frontend/
RUN npm install --no-audit --no-fund \
 && cd frontend && npm install --no-audit --no-fund
COPY . .
RUN cd frontend && npm run build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Non-root runtime user.
RUN useradd --no-create-home --uid 10001 cred402
COPY --from=frontend /app /app
# /data is where CRED402_DATA_DIR writes (event journal, payment-attempt
# stores, etc.) — it must be owned by the runtime user BEFORE the volume is
# mounted, or every write fails EACCES the moment a volume (named or bind)
# is attached at this mount point, since Docker otherwise creates it root:root.
RUN mkdir -p /data && chown -R cred402:cred402 /app /data
USER cred402

EXPOSE 4021
ENV CRED402_PORT=4021 \
    CRED402_ENV=testnet \
    CRED402_LOG_LEVEL=info \
    CRED402_AUTH_REQUIRED=true \
    CRED402_DATA_DIR=/data

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.CRED402_PORT||4021)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "api/server.ts"]
