FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY public ./public
COPY scripts ./scripts
COPY data/index.schema.json ./data/index.schema.json
COPY .env.example ./.env.example

RUN mkdir -p data/manuals data/page-images data/photos

ENV PORT=8300
EXPOSE 8300

CMD ["node", "server.js"]
