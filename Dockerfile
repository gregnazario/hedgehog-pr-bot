FROM node:24-bookworm-slim

ARG PI_VERSION=0.84.4
RUN npm install --global --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && npm cache clean --force

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

ENV HOST=0.0.0.0 \
    PORT=3000 \
    PI_VERSION=0.84.4 \
    PI_CODING_AGENT_DIR=/tmp/pi-agent \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0 \
    HOME=/tmp \
    NO_COLOR=1

USER node
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
