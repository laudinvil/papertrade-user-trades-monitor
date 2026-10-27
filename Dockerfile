FROM node:20-alpine
WORKDIR /app
EXPOSE 8080
ENV NODE_ENV=production
ENV PROFITABLE_TRADERS_STATE_PATH=/data/profitable-traders-state.json
COPY package.json ./
COPY profitable-traders-monitor.js supervisor.js check-nodeflare.mjs ./
RUN mkdir -p /data && chmod 777 /data
CMD ["node", "supervisor.js"]
