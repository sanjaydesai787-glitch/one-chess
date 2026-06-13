# Local Chess Tournament

A lightweight React + Vite app for managing local chess tournaments with player registration, round generation, and standings.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Run the development server:
   ```bash
   npm run dev
   ```

## Features

- Add players and ratings
- Generate rounds automatically
- Record game results
- View current standings
- Persist tournament data in browser local storage

## Forever Deployment

This project requires a persistent Node backend and is not suitable for Vercel's serverless platform for Socket.IO. Use a long-running Node host instead.

### Recommended deployment options

- Render, Heroku, Fly.io, Railway, or any Docker-compatible platform
- The existing `Procfile` already defines `web: node server.js`
- The included `Dockerfile` provides a container-ready deployment path

### Deploy with Docker

```bash
docker build -t chess-tournament .
docker run -p 4000:4000 -e PORT=4000 -e JWT_SECRET="your-secret" chess-tournament
```

### Deploy on Render / Heroku

1. Push this repo to GitHub.
2. Create a new Web Service on the host.
3. Use the existing `Procfile` and set env vars:
   - `PORT` (optional, defaults to `4000`)
   - `JWT_SECRET`
   - `ORGANIZER_USER`
   - `ORGANIZER_PASS`

If Render is still failing, use the Docker deployment path instead. This repository includes a `Dockerfile` and `render.yaml` for a Render Docker service.

This repo now includes a `prestart` script so `npm start` will build the frontend automatically before running `server.js` on Render.

#### Render Docker deployment

1. Push the repo to GitHub.
2. Create a new Render Web Service.
3. Select `Docker` as the environment.
4. Use the included `render.yaml` and `Dockerfile`.
5. Set env vars in Render:
   - `JWT_SECRET`
   - `ORGANIZER_USER`
   - `ORGANIZER_PASS`

### Deploy on Fly.io

1. Install the Fly CLI from https://fly.io/docs/getting-started/install/
2. Run:
   ```bash
   fly auth login
   fly launch --name chess-tournament --region iad --dockerfile Dockerfile --image dockerfile
   ```
3. If Fly asks to create a database, choose `no`.
4. Deploy:
   ```bash
   fly deploy
   ```
5. Set env vars:
   ```bash
   fly secrets set JWT_SECRET="your-secret"
   fly secrets set ORGANIZER_USER="admin"
   fly secrets set ORGANIZER_PASS="admin"
   ```

The `fly.toml` manifest is included and configures the app to run on port `4000`.

The backend will stay running and support live Socket.IO connections indefinitely.
