# ── 1) 프론트(React) 빌드 ──
FROM node:20-slim AS fe
WORKDIR /fe
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ── 2) 백엔드(FastAPI) + ffmpeg + 나눔폰트 ──
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg fonts-nanum \
 && rm -rf /var/lib/apt/lists/*
ENV DSM_FONT_R=/usr/share/fonts/truetype/nanum/NanumGothic.ttf
ENV DSM_FONT_B=/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf

WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/ backend/
COPY --from=fe /fe/dist frontend/dist

WORKDIR /app/backend
EXPOSE 8000
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
