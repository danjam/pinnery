# Build stage: build dist/ (the web app and extension bundles), then keep only production dependencies.
FROM node:26-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS build

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
# --include=dev: the build needs esbuild (NODE_ENV=production would leave dev dependencies out).
# --ignore-scripts: better-sqlite3 13 ships prebuilt binaries and sets gypfile:false, but that flag
# isn't recorded in the lockfile, so npm ci would otherwise try a node-gyp rebuild (no toolchain here).
# sharp and esbuild use platform packages, so nothing we depend on needs an install script.
RUN npm ci --include=dev --ignore-scripts

COPY scripts ./scripts
COPY src ./src
COPY extension ./extension
# The server serves dist/, so the sources it was built from (and the build script) can go.
RUN npm run build \
  && npm prune --omit=dev && npm cache clean --force \
  && rm -rf scripts src/public extension
RUN mkdir /data

# Runtime: distroless Node, i.e. just Node and the libraries it needs. No shell, npm or package
# manager, so far less to patch. Debian-based (glibc), which the prebuilt sqlite/sharp binaries need.
# The Node major is in the image name (nodejsNN), which Renovate can't bump: change it by hand with the
# build stage's node:NN-slim. CI (test.yml) fails while the two differ.
FROM gcr.io/distroless/nodejs26-debian13:latest@sha256:80631bd2f0e7ef192138a7409013b47d92fd11b8ff3bb35f5c0a65be3ecaea4c

ENV NODE_ENV=production
# The image keeps node in /nodejs/bin, off PATH; this lets healthchecks (ours and existing compose
# files) run plain `node`.
ENV PATH=/nodejs/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /app

# App code stays root-owned so the app (uid 1000) can't modify it; only /data is writable.
COPY --from=build /app /app
COPY --from=build --chown=1000:1000 /data /data
# Licence notices travel with the image. The GPL-3 and LGPL-3 texts that libvips (via sharp) needs
# are already in the base image, in /usr/share/common-licenses.
COPY LICENSE NOTICE ./

# uid 1000, as before, so existing data folders keep working. (The image's default user is root.)
USER 1000:1000
VOLUME /data
EXPOSE 3420

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://localhost:${process.env.PORT || 3420}/healthz`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# The image's entrypoint is node itself.
CMD ["src/server.ts"]
