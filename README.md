# Schedule Dashboard

A live weekly schedule dashboard for club managers, with an admin approval workflow. Node.js + Express + Postgres + a vanilla HTML/CSS/JS frontend. No build step. Ready to deploy to Railway.

## Features

- Email + password auth with bcrypt, two roles: `admin` and `manager`
- Weekly (Mon–Sun) schedule grid of employees × days per club
- Workflow: `draft` → `submitted` → `posted`, with recall / return-to-draft
- Managers can manage their own roster (add / rename / archive employees)
- Employees are tagged by team (`Main`, `Team 2`, `Shared`) with color-coded rows
- Admin can create managers, reset passwords, and delete users
- Historical posted schedules are preserved even when employees are archived

## Tech stack

- Node.js 18+
- Express, express-session, connect-pg-simple
- Postgres (`pg`)
- bcrypt for password hashing
- Vanilla HTML/CSS/JS frontend served from `/public`

## Local development

```bash
cp .env.example .env
# Edit .env: point DATABASE_URL at a local Postgres, set SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
npm install
node db/migrate.js   # applies schema + seeds clubs/employees + creates admin user
npm start
# open http://localhost:3000
```

## Deploying to Railway

1. **Create a GitHub repo**
   - `git init && git add . && git commit -m "initial commit"`
   - Create a new empty repo on GitHub, then push:
     ```bash
     git remote add origin git@github.com:YOUR-USER/schedule-dashboard.git
     git branch -M main
     git push -u origin main
     ```

2. **Create a Railway project**
   - Go to <https://railway.app> → **New Project** → **Deploy from GitHub repo** → select your new repo.
   - Railway will detect Node.js and run `npm install` (which triggers `postinstall: node db/migrate.js`) and then `npm start`.

3. **Add the Postgres plugin**
   - In the Railway project, click **+ New** → **Database** → **Add PostgreSQL**.
   - Railway will automatically inject a `DATABASE_URL` environment variable into your web service.

4. **Set environment variables** on the web service (Variables tab):
   - `SESSION_SECRET` — a long random string (e.g. `openssl rand -hex 32`)
   - `ADMIN_EMAIL` — the first admin's email address
   - `ADMIN_PASSWORD` — a strong temporary password (you'll change it on first login)
   - `PGSSL=true` (recommended — Railway's managed Postgres uses SSL)
   - `NODE_ENV=production`

5. **Redeploy**
   - After setting the variables, trigger a redeploy from the Deployments tab (or push a new commit).
   - On first boot, `db/migrate.js` will:
     - create all tables
     - seed the two clubs (Jacksonville, St. Augustine) with their employees
     - create the bootstrap admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD`

6. **Expose the service**
   - In the Settings tab of the web service, click **Generate Domain** to get a public URL.

## First-login checklist

Once deployed:

1. Open the Railway-generated URL and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
2. Click **Change password** in the top-right and set a strong permanent password.
3. Go to the **Users** tab and click **+ Create user** to create a manager for each club:
   - Role: `manager`
   - Club: pick the correct club (Jacksonville or St. Augustine)
   - Give them a temporary password
4. Share each manager's email + temporary password with them securely and tell them to change it on first login.
5. (Optional) Review the rosters under **Manage roster** to make sure everyone is correct. For Jacksonville, confirm that Dustyn Burd through Jaron Firesheets render as **Team 2** (purple) while everyone else is **Main** (blue).

## Workflow

- **Managers** sign in and land on their club's schedule. They edit any cell in the grid (it auto-saves) and add notes. When ready, they click **Submit for review**, which locks the schedule. They can **Recall** a submitted schedule to keep editing.
- **Admin** logs in, picks a club and week, reviews the submitted schedule, and clicks **Approve & Post** to publish it. The admin can also **Return to draft** to push changes back to the manager.

## API reference (summary)

```
POST   /api/login
POST   /api/logout
GET    /api/me
POST   /api/me/password

GET    /api/clubs
POST   /api/clubs                          (admin)

GET    /api/clubs/:id/employees
POST   /api/clubs/:id/employees
PATCH  /api/employees/:id
DELETE /api/employees/:id                  (archives)

GET    /api/clubs/:id/schedule?week=YYYY-MM-DD
PATCH  /api/schedules/:id/cell
PATCH  /api/schedules/:id/notes
POST   /api/schedules/:id/submit           (manager)
POST   /api/schedules/:id/recall           (manager)
POST   /api/schedules/:id/post             (admin)
POST   /api/schedules/:id/return           (admin)

GET    /api/users                          (admin)
POST   /api/users                          (admin)
PATCH  /api/users/:id                      (admin)
DELETE /api/users/:id                      (admin)
```

## Notes

- `db/migrate.js` is idempotent — it's safe to run it multiple times. It will only seed clubs/employees if the `clubs` table is empty, and only create the bootstrap admin if no admin exists yet.
- `postinstall` tolerates a missing `DATABASE_URL` (for local `npm install` without a DB). Set `MIGRATE_STRICT=true` to make migration failures hard-fail the install.
- All writes to schedule cells and notes are debounced and auto-saved from the frontend.
