# Playwright base image bundles Chromium and its system libraries.
# Keep the tag in sync with the "playwright" version in packages/server/package.json.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
# Dev dependencies are needed for the build step below.
RUN npm ci --include=dev

COPY packages packages
RUN npm run build

EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]
