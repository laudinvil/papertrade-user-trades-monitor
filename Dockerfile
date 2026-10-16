FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json papertrade-monitor.js check-nodeflare.mjs ./
RUN mkdir -p /app/data && chmod 777 /app/data
CMD ["node", "check-nodeflare.mjs"]
