# One image for the API, the worker and the web app, so the same build runs here and on a server. Synthetic data only.
FROM node:24.11.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng tesseract-ocr-osd util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN npm ci --ignore-scripts && npm run build -w @codex-health/web && chown -R node:node /app
USER node
