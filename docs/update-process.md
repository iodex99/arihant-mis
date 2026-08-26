# Updating the Application

Updates never delete the database. The PostgreSQL volume is a **named** Docker
volume, so `docker compose down`, a rebuild and a restart all leave it intact.

## The normal update

```bash
cd /opt/arihant-mis
./scripts/update.sh
```

On Windows Server:

```powershell
cd C:\arihant-mis
.\scripts\update.ps1
```

Both scripts do the same five steps, and each stops on failure:

| Step | What it does | If it fails |
|---|---|---|
| 1 | Back up the database and configuration | Nothing has changed |
| 2 | `git pull --ff-only` | Nothing has changed |
| 3 | `docker compose build app` | The running application is untouched |
| 4 | `docker compose up -d` — migrations run on start | The backup from step 1 is current |
| 5 | Poll `/api/health` until healthy | Tells you to check the logs; the database was not modified |

`--ff-only` means a diverged local branch stops the update rather than producing
a merge commit on the server.

## What happens to the database

The container entrypoint waits for PostgreSQL, then runs:

```
npx prisma migrate deploy
```

`migrate deploy` applies committed migrations in order and **never** resets,
drops or recreates anything. It is the production-safe command; `migrate dev`
(which can reset) is only ever used in development.

If a migration fails, the container exits and the previous data is untouched.
Restore from the step-1 backup if needed, and check `docker compose logs app`.

## Verifying an update

```bash
curl -s http://localhost:3000/api/health
```

```json
{"status":"ok","version":"1.0.1","database":"connected","latencyMs":3}
```

Then in the browser: **Admin** shows the running version, the entry count and the
latest import. The dashboard totals should be unchanged — an update alters code,
never figures.

## Rolling back

```bash
git log --oneline -5          # find the previous commit
git checkout <commit>
docker compose build app
docker compose up -d
```

If the newer version applied a migration, roll the database back too:

```bash
./scripts/restore.sh backups/arihant-mis-<the backup update.sh just took>.sql.gz
```

This is why step 1 exists. Restore the dump taken immediately before the update,
not an older one.

## Schema changes during development

```bash
# edit prisma/schema.prisma, then
npx prisma migrate dev --name describe_the_change
```

Commit the generated `prisma/migrations/<timestamp>_describe_the_change/` folder.
The server applies it on the next update.

Rules for a migration that reaches production:

* **Never** hand-edit or delete a migration that has been applied anywhere.
* Additive changes (new nullable column, new table, new index) are safe.
* A destructive change (dropping or narrowing a column) needs a written plan and
  a verified backup first — and should usually be split into "add the new shape,
  backfill, switch reads, drop the old shape later".

## Versioning

The version comes from `package.json` and is shown in **Admin → System** and in
`/api/health`. Bump it with the change:

```bash
npm version patch    # 1.0.0 -> 1.0.1   fixes
npm version minor    # 1.0.0 -> 1.1.0   new capability
npm version major    # 1.0.0 -> 2.0.0   breaking
git push --follow-tags
```

## Updating only the database image

```bash
docker compose pull postgres
docker compose up -d postgres
```

A **major** PostgreSQL upgrade (17 to 18) is not an in-place operation: dump with
the old version, upgrade the image, then restore. Take the dump first.

## Zero-downtime

Not implemented, and not proposed. This is an internal reporting tool for one
office; a 30-second restart during an update is not worth the operational
complexity of blue/green deployment. Run updates outside working hours.
