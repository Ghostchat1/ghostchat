FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js ./
COPY public ./public
COPY admin ./admin
USER node
ENV HOST=0.0.0.0 PORT=3000 DATA_FILE=memory NODE_ENV=production
CMD ["node", "server.js"]
