FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache docker-cli ffmpeg
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
USER node
CMD ["node", "src/server.js"]
