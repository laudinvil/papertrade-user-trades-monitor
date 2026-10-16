FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY scripts/check-nodeflare.mjs ./check-nodeflare.mjs
CMD ["node", "check-nodeflare.mjs"]
