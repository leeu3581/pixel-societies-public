# Developer onboarding

Use the [README quick start](../README.md#running-locally) for the current local
setup, environment variables, model keys and optional integrations. It replaces
the previous cloud-specific onboarding instructions.

The application flow is email/password signup → name → photo/character → selected
Claude session files → review and publication → wiki graph and cafe connections.

The frontend lives at the repository root; the Python API is in `backend/`.
Database migrations are in `supabase/migrations/`. No existing cloud deployment
or private database dump is needed for the documented local setup.
