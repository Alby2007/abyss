FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# the node user needs somewhere writable for the local-json fallback
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
ENV PORT=3000
EXPOSE 3000
VOLUME /app/data
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/meta" >/dev/null || exit 1
CMD ["node", "server.js"]
