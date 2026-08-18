# -- build the Vue SPA --
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

# -- runtime: Node backend serving the built SPA + JSON/SSE API --
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
# better-sqlite3 needs a toolchain to compile its native addon.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev \
  && apt-get purge -y python3 make g++ || true
COPY server ./server
COPY --from=build /app/dist ./dist
EXPOSE 8035
CMD ["node", "server/index.js"]
