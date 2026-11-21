# AskDB Web

Talk to your PostgreSQL database in plain English, in your browser. The web version of [AskDB](https://github.com/igot-apps/AskDB).

- Your OpenRouter key and database links are saved **only in your browser**.
- A small password-protected server does the database work (browsers can't connect to PostgreSQL directly).
- Read-only by default; every change needs your confirmation. Wrong passwords are locked out after 10 tries.

## Run on Render (free)
- **Build command:** `npm install`
- **Start command:** `npm start`
- **Environment variable:** `APP_PASSWORD` = a long password of your choice

## Run locally
```bash
npm install
APP_PASSWORD=choose-a-password npm start   # then open http://localhost:10000
```
