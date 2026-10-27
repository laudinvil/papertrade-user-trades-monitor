FROM node:22.23.4-alpine
WORKDIR /app
EXPOSE 8080
ENV NODE_ENV=production
RUN apk upgrade --no-cache && apk add --no-cache ca-certificates && update-ca-certificates
COPY package.json ./
COPY trade-activity-monitor.js liquidation-summary-monitor.js supervisor.js check-nodeflare.mjs ./
RUN mkdir -p /data && chmod 777 /data
CMD ["node", "supervisor.js"]
