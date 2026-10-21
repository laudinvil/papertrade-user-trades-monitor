FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY shark-radar-monitor.js ./
RUN mkdir -p /app/data && chmod 777 /app/data
CMD ["node", "shark-radar-monitor.js"]
