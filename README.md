# Torrent Studio — Vercel + Render + Seedr

Clean split deployment of the full Torrent Studio UI.

## Architecture

- **frontend/** — React + Vite, deployed to Vercel.
- **backend/** — FastAPI, deployed to Render.
- **1337x** — torrent search.
- **Seedr** — cloud torrent storage/transfers.
- No qBittorrent, Prowlarr, FlareSolverr, local torrent storage, or local torrent streaming on Render.

## Vercel

Set the project Root Directory to `frontend`.

Environment variable:

```
VITE_API_URL=https://YOUR-RENDER-SERVICE.onrender.com
```

## Render

Set the service Root Directory to `backend`.

Environment variables:

```
SEEDR_API_TOKEN=<your Seedr PAT>
SEEDR_LIBRARY_FOLDER_ID=88718944
SEEDR_MAX_SIZE_GB=5
```

The Seedr token is a secret. Do not commit it to Git.

## Local development

Backend:

```bash
cd backend
python -m venv .venv
pip install -r requirements.txt
uvicorn main:app --reload
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Then set `VITE_API_URL=http://127.0.0.1:8000` for the frontend.

## API

- `GET /api/search?q=...`
- `POST /api/seedr/add`
- `POST /api/seedr/tasks/prepare`
- `GET /api/seedr/tasks`
- `GET /api/seedr/tasks/:id`
- `GET /api/seedr/quota`
- `GET /api/seedr/files`
- `GET /api/seedr/files/:id/download`

The preserved UI contains additional compatibility endpoints for its existing panels. Those endpoints do not start a qBittorrent process or create local torrent storage.
