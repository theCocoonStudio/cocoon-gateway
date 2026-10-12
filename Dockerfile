# The gateway's image, the same in every deploy shape: Node 22 on Debian bookworm slim; the lockfile
# installed with lifecycle scripts refused (.npmrc) and production dependencies only; run as the image's
# unprivileged `node` user. Nothing secret is baked in: every credential is read from the environment at
# start (the platform's secrets, src/credentials.js), and the two config files are the whole configuration.
# PORT is the platform's (default 8443, src/server.js); HEALTH_PORT is the loopback health listener (8080).
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY config ./config
USER node
EXPOSE 8443
CMD ["node", "src/server.js"]
