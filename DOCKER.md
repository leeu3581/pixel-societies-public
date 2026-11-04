# Docker

The recommended fresh-clone setup is [Running locally](README.md#running-locally).
It uses Docker through the Supabase CLI for PostgreSQL, auth infrastructure and
object storage, and runs FastAPI and Next.js on the host.

## Backend image

Build from the repository root so the image includes the pixel-art references:

```bash
docker build -f backend/Dockerfile -t pixel-societies-backend .
```

The image installs `backend/requirements.lock`. To run it against services
reachable from inside the container:

```bash
docker run --rm --env-file backend/.env -e PORT=8080 -p 8080:8080 pixel-societies-backend
```

`127.0.0.1` inside the container is the container itself. Configure database and
storage addresses for the container network before using this command. Generated
image URLs must also be reachable by the browser. Use a persistent volume for
`/home/pixel-data` if you want runtime wiki changes to survive container removal.

## Legacy Compose stack

`docker-compose.yml` is a legacy database-restore workflow. It assumes a private,
ignored `backend/db/init/02_seed.sql` dump and does **not** bootstrap a complete
application database from a fresh clone. Its backend environment also predates
the Meta configuration. Do not use it as the submission quick start or copy a
production database dump into the repository. Use the checked-in Supabase
migrations via the README instead.
