# Database and storage setup

Follow [Running locally](../README.md#running-locally) to start the Supabase CLI
stack and configure FastAPI. The checked-in migrations create the schema, signup
triggers, canonical characters, memory tables and the public `sprites` bucket.

Application email/password login is handled by `backend/app/auth_service.py`,
which signs JWTs using `SUPABASE_JWT_SECRET`. Images are uploaded by the backend
with `SUPABASE_SERVICE_ROLE_KEY`; never expose that key to the frontend.

Use `supabase migration up --local` for pending local migrations. Do not reset an
existing database merely to run the app. The Azure deployment can use PostgreSQL
and Azure Blob Storage instead; the legacy `SUPABASE_*` names remain for compatibility.
