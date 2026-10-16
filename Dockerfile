FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json papertrade-monitor.js ./
COPY scripts/check-nodeflare.mjs ./check-nodeflare.mjs
COPY scripts/diagnose-liquidation-mapping.mjs ./diagnose-liquidation-mapping.mjs
RUN mkdir -p /app/data && chmod 777 /app/data
CMD ["sh", "-c", "if [ \"$RUN_MAPPING_DIAGNOSTIC\" = \"1\" ]; then node diagnose-liquidation-mapping.mjs; else node papertrade-monitor.js; fi"]
