FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts: better-sqlite3 13 ships prebuilt binaries and sets gypfile:false, but that flag
# isn't recorded in the lockfile, so npm ci would otherwise try a node-gyp rebuild (no toolchain here).
# sharp uses platform packages, so nothing we depend on needs an install script.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY extension ./extension

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3420

CMD ["node", "src/server.js"]
