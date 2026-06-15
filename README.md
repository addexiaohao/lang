# Language Learning App

A personal multi-user language learning assistant. Chat with Claude to learn vocabulary and grammar — it saves structured flashcard data to a Supabase database. Supports multiple users and projects (e.g. German for one user, Swedish for another).

## How it works

React frontend → Vercel serverless functions → Anthropic (Claude) + Supabase

Claude streams responses inline, emitting fenced JSON blocks for vocabulary and grammar cards. You review and save them to the database with one click. Claude checks for duplicates before emitting any card. All API routes require a Supabase Auth session — accounts are created manually in the Supabase dashboard.

## Running locally

### Prerequisites

- Node.js 18+
- Vercel CLI: `npm i -g vercel`
- An Anthropic API key
- A Supabase project (see `schema.sql` to set up the database)

### 1. Install dependencies

```bash
npm install
```

### 2. Set environment variables

Create a `.env` file:

```
ANTHROPIC_API_KEY=...
VITE_SUPABASE_URL=...
SUPABASE_SECRET_KEY=...
VITE_SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_ACCESS_TOKEN=...
```

### 3. Link to Vercel (one-time)

```bash
vercel link
```

### 4. Start the dev server

```bash
vercel dev
```

This serves the React frontend and all `/api/*` serverless functions together on [http://localhost:3000](http://localhost:3000).

(`npm run dev` runs Vite only — use that for pure frontend work without the API.)

## Database setup

Run `schema.sql` in the Supabase SQL editor (or `npm run migrate`) to create the tables and stored procedures.

After migrating, create your user account in the Supabase dashboard under **Authentication → Users** — a `user_settings` row is created automatically via a Postgres trigger when the account is made. Then insert a row into the `projects` table with your `user_id`. The first project will load by default; switching projects in the UI persists your choice.

## Project structure

```
src/          React frontend (auth, project context, chat UI)
api/          Vercel serverless functions (all require auth)
lib/          Server-side helpers (auth, Supabase admin client, project config)
schema.sql    Database schema (source of truth)
```
