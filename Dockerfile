FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV STATE_PATH=/data/state.json
ENV SHARK_RADAR_STATE_PATH=/data/shark-radar-state.json
COPY package.json ./
COPY papertrade-monitor.js shark-radar-monitor.js supervisor.js ./
RUN mkdir -p /data && chmod 777 /data
CMD ["node", "supervisor.js"]
