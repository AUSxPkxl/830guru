FROM node:22-bookworm-slim

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip poppler-utils \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN python3 -m pip install --break-system-packages --no-cache-dir -r requirements.txt

COPY package.json ./
COPY server.js ./
COPY public ./public
COPY scripts ./scripts
COPY data ./seed-data
COPY .env.example ./.env.example

RUN mkdir -p data/manuals data/page-images data/photos

ENV PORT=8300
ENV PYTHON_PATH=python3
EXPOSE 8300

CMD ["node", "server.js"]
