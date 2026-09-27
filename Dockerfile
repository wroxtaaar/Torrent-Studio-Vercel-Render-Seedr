# Build the Vite frontend first.
FROM node:22-alpine AS frontend-build

WORKDIR /frontend

COPY frontend/package.json ./
RUN npm install

COPY frontend/ ./

# API calls default to the browser origin in the full-stack build.
RUN npm run build

# Run FastAPI and serve the generated frontend from the same container.
FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends aria2 \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
COPY --from=frontend-build /frontend/dist ./frontend-dist

ENV PYTHONUNBUFFERED=1

CMD ["sh", "-c", "uvicorn fullstack_app:app --host 0.0.0.0 --port ${PORT:-10000}"]
