FROM node:22-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
COPY src ./src
RUN npm install && npm run build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
ENTRYPOINT ["node", "dist/index.js"]
