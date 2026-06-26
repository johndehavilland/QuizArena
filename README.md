# QuizArena

Compete live. Climb the leaderboard.

A live quiz platform with an admin screen for publishing quizzes and controlling live sessions, plus a player screen for joining and answering questions with a leaderboard at the end and support for 100+ concurrent users. 

## Get it going

The easiest way to get this up and running to use is in Azure. This repo includes Azure Developer CLI (`azd`) configuration for Azure Container Apps in `azure.yaml` and `infra/`. 

This requires you have access to an Azure Subscription. If you want to run it elsewhere, instructions for Docker build are later in this guide.

### Clone the repo

Before running any setup commands, clone this repository and change into the project directory in your terminal:

```bash
git clone <repo-url>
cd quiz-app
```

### Install Azure Developer CLI

Install `azd` from https://aka.ms/azd/install. If you are on windows, open PowerShell and enter:

```bash
winget install microsoft.azd
```

then open a new terminal and check it is available:

```bash
azd version
```

### Deploy

1. Make sure your terminal is in the repo directory.

   ```bash
   cd quiz-app
   ```

2. Sign in to Azure.

   ```bash
   azd auth login
   ```

3. Create an environment and choose a region.

   ```bash
   azd env new quiz-app
   azd env set AZURE_LOCATION centralus
   ```

4. Set the admin password used by the `/admin` page.

   ```bash
   azd env set ADMIN_PASSWORD "your-strong-password"
   ```

5. **Optional**: set `DATABASE_URL` if you want to use PostgreSQL instead of the default SQLite database. You might want this is if you are hosting quizes for more than 100 people to enable better database persistence and replication as the app tier scales out.

   ```bash
   azd env set DATABASE_URL "postgres://user:password@host:5432/database?sslmode=require"
   ```

   If `DATABASE_URL` is not set, the Azure deployment uses SQLite stored on an Azure Files share and runs one Container Apps replica.

### Migrate existing SQLite data to PostgreSQL

If you already have data in SQLite and want to switch to PostgreSQL, run the migration script in [scripts/migrate-sqlite-to-postgres.mjs](scripts/migrate-sqlite-to-postgres.mjs).

1. Set `DATABASE_URL` for your PostgreSQL server.

2. Run the migration script from the repo root.

   PowerShell:
   node .\scripts\migrate-sqlite-to-postgres.mjs

   bash:
   node ./scripts/migrate-sqlite-to-postgres.mjs

3. The script prints source and target row counts for: quizzes, questions, attempts, live_sessions, and live_answers.

4. If you want to migrate from a non-default SQLite file, set `SQLITE_PATH` first.

   PowerShell:
   $env:SQLITE_PATH = '.\\data\\quiz.sqlite'
   node .\scripts\migrate-sqlite-to-postgres.mjs

   bash:
   export SQLITE_PATH=./data/quiz.sqlite
   node ./scripts/migrate-sqlite-to-postgres.mjs

Notes:
- The script is safe to re-run because it uses upsert behavior.
- Run migration before scaling out so all replicas use the same PostgreSQL-backed data set.

5. Preview the infrastructure changes.

   ```bash
   azd provision --preview
   ```

6. Deploy the app.

   ```bash
   azd up
   ```

`azd up` prints the deployed web URL when it finishes.

To remove the Azure resources later:

```bash
azd down
```

## Non Azure setup: Docker Compose

This is the simplest way to hand the app to someone else. They only need Docker installed.

### Install Docker

Install Docker before running the app with Docker Compose:

- macOS or Windows: install Docker Desktop from https://www.docker.com/products/docker-desktop/
- Linux: install Docker Engine from https://docs.docker.com/engine/install/

After installing Docker, open a new terminal and check that Docker Compose works:

```bash
docker compose version
```

Then start the app:

1. Clone the repo and enter the folder.

   ```bash
   git clone <repo-url>
   cd quiz-app
   ```

2. Pick an admin password and start the app.

   ```bash
   ADMIN_PASSWORD="your-strong-password" docker compose up --build
   ```

3. Open the app.

   - Player view: http://localhost:3000
   - Admin view: http://localhost:3000/admin

Quiz data is stored in a Docker volume named `quiz-data`, so it survives container restarts and rebuilds.

To stop the app:

```bash
docker compose down
```

To delete all saved quiz data as well:

```bash
docker compose down --volumes
```

## Local Development

Use Node 24 because the server uses the built-in `node:sqlite` module.

1. Install dependencies.

   ```bash
   npm install
   ```

2. Set an admin password.

   ```bash
   export ADMIN_PASSWORD="your-strong-password"
   ```

3. Run the frontend and backend together.

   ```bash
   npm run dev
   ```

4. Open http://localhost:5173.

## Production Build Without Docker

```bash
npm ci
npm run build
ADMIN_PASSWORD="your-strong-password" npm start
```

The production server listens on `PORT`, defaulting to `3001` outside Docker.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD` | `change-me` | Password required for admin actions. Set this before sharing or hosting the app. |
| `PORT` | `3001` locally, `3000` in Docker | HTTP port for the production server. |
| `DATABASE_PATH` | `data/quiz.sqlite` locally, `/app/data/quiz.sqlite` in Docker | SQLite database location. |
| `DATABASE_URL` | empty | Optional PostgreSQL connection string for shared hosting. |

Admin actions like publishing quizzes, deleting quizzes, and starting or advancing live sessions are locked behind the admin password gate in the UI and enforced on the server.
