FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json papertrade-monitor.js ./
RUN mkdir -p /app/data
CMD ["npm", "start"]
