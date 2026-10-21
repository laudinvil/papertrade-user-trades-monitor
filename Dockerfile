FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY papertrade-monitor.js shark-radar-monitor.js supervisor.js ./
RUN mkdir -p /app/data && chmod 777 /app/data
CMD ["node", "supervisor.js"]
