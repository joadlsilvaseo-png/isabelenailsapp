FROM node:24-alpine

ARG APP_REVISION=unknown
LABEL org.opencontainers.image.revision=$APP_REVISION

WORKDIR /app

COPY --chown=node:node package.json ./

RUN npm install --omit=dev --no-audit --no-fund \
    && chown -R node:node /app

COPY --chown=node:node src/ ./src/

USER node

EXPOSE 3001

CMD ["npm", "start"]
