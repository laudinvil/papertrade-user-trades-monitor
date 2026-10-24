FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV STATE_PATH=/data/state.json
COPY package.json ./
COPY papertrade-monitor.js check-nodeflare.mjs supervisor.js ./
RUN mkdir -p /data && chmod 777 /data
CMD ["node", "supervisor.js"]
