# Build stage: install production dependencies with npm.
FROM node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts: better-sqlite3 13 ships prebuilt binaries and sets gypfile:false, but that flag
# isn't recorded in the lockfile, so npm ci would otherwise try a node-gyp rebuild (no toolchain here).
# sharp uses platform packages, so nothing we depend on needs an install script.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY extension ./extension
RUN mkdir /data

# Runtime: distroless Node, i.e. just Node and the libraries it needs. No shell, npm or package
# manager, so far less to patch. Debian-based (glibc), which the prebuilt sqlite/sharp binaries need.
FROM gcr.io/distroless/nodejs24-debian13:latest@sha256:03980f6fd2a3245fa06e371c36fd33528ebbc676a1d0f84e3e21d95cd291b807

ENV NODE_ENV=production
# The image keeps node in /nodejs/bin, off PATH; this lets healthchecks (ours and existing compose
# files) run plain `node`.
ENV PATH=/nodejs/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /app

# App code stays root-owned so the app (uid 1000) can't modify it; only /data is writable.
COPY --from=build /app /app
COPY --from=build --chown=1000:1000 /data /data

# uid 1000, as before, so existing data folders keep working. (The image's default user is root.)
USER 1000:1000
VOLUME /data
EXPOSE 3420

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://localhost:${process.env.PORT || 3420}/healthz`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# The image's entrypoint is node itself.
CMD ["src/server.js"]
