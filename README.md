<p align="center">
  <img src="public/onboarding/logo.svg" alt="Pixel Societies globe logo" width="96" />
  <img src="docs/images/pixel-walk.gif" alt="A pixel character walking in a loop" width="48" height="96" />
</p>
<h1 align="center">Pixel Societies</h1>
<p align="center"><strong>Your work. Your twin. Your people.</strong></p>

### Your agent knows your work. Turn that understanding into your next collaboration.

**An evolving digital twin, built from the work you’re already doing. Powered by Meta Muse.**

Your coding sessions contain a picture of you that a professional profile rarely
captures: the idea you keep returning to, the problems you’re trying to solve,
the tradeoffs you make, and how you move from uncertainty to something that works.

Pixel Societies brings that picture to life. Meta Muse interprets your work
history, helps you recognise the patterns in it, and turns your approved
understanding into a digital twin with a visual map of your thinking. Inside a
shared pixel world, that context becomes a reason to meet someone: a shared
ambition, a complementary strength, or a collaboration neither of you had thought
to search for.

**The opportunity is already in the context. We make it visible.**

[The experience](#from-work-history-to-a-reason-to-meet) · [Why Meta Muse](#meta-muse-is-the-intelligence-throughout-the-experience) · [Run locally](#running-locally)

<p align="center">
  <img src="docs/images/pixel-world.png" alt="Pixel characters exploring the shared Pixel Societies world" width="1000" />
  <br />
  <em>A world of people, ideas, and reasons to connect.</em>
</p>

## The problem: the most useful things about us are missing from our profiles

A job title tells you someone is a developer. It doesn’t tell you what they are
trying to build this week, which question they are stuck on, or what kind of
thinking would move their project forward.

Finding a cofounder or collaborator often means compressing yourself into a bio,
choosing a few tags, and hoping the right person recognises the connection. Yet
our agents already encounter much richer context while helping us work. That
context usually stays inside isolated conversations.

Pixel Societies gives it a second purpose: **understanding people well enough to
create useful connections between them.**

## From work history to a reason to meet

### 1. Arrive as yourself

Upload a photo. **Muse Image** creates a recognisable pixel portrait and animation
poses, giving your twin a place in a world you can explore. Identity becomes part
of the experience from the first interaction.

<p align="center">
  <img src="docs/images/muse-pixel-character.png" alt="Muse-generated pixel character with walking poses and playful expressions" width="780" />
  <br />
  <em>A little pixel personality. Generated with Meta Muse Image.</em>
</p>

### 2. Discover what your work says about you

<p align="center">
  <a href="docs/images/history-import.png"><img src="docs/images/history-import.png" alt="A generated pixel twin ready to import Claude Code sessions into builder memory" width="1100" /></a>
  <br />
  <em>Your character is ready. Bring the work that makes it you.</em>
</p>

Add selected Claude Code sessions. **Muse Spark** connects the evidence across
those sessions into current projects, interests, open questions and ways of
working. The result is a set of readable, editable observations organised around:

- **What you’re building** — the direction behind the tasks.
- **How you build** — the patterns in how you approach the work.
- **What’s on your mind** — ideas and questions that deserve another conversation.
- **What matters to you** — priorities expressed through your choices.

The aim is the recognition moment: *“Yes—that’s what I’ve been trying to do.”*
New uploads enrich the same understanding, so the twin can develop with the person.

### 3. See the connections in your own thinking

A second **Muse Spark** synthesis turns approved understanding into a personal
wiki: named concepts, readable pages and relationships between them. Your portrait
sits at the centre of a graph of projects, interests and ideas.

This makes the twin something you can explore. A task history becomes a picture
of what connects your work.

### 4. Choose what represents you

The reading cards are selected by default. Keep what feels right, edit the wording,
and uncheck anything you want to keep private. **Publish selected** makes the
approved profile text available for discovery. Supporting session excerpts remain
in your private notebook.

### 5. Find a connection with a reason behind it

**Explore current matches** opens a visual connection between two people inside
the world. It surfaces two different kinds of opportunity:

| Shared direction | Complementary strengths |
| --- | --- |
| Someone exploring a related idea, building toward a similar goal, or asking a question you care about. | Someone whose experience or perspective could help with a specific part of your work—and open up a useful exchange. |
| “We should compare what we’re learning.” | “We could make progress together.” |

Each connection has a visible explanation, context from both profiles, and a
conversation starter. The product creates a next step: a question to discuss,
a small experiment to try, or an idea to build together.

<p align="center">
  <a href="docs/images/complementary-matches.png"><img src="docs/images/complementary-matches.png" alt="A visual connection between Soomin and Yuri showing complementary strengths in prototyping and visual storytelling" width="1100" /></a>
  <br />
  <em>Your next collaborator may think differently. See where your strengths meet.</em>
</p>

## Meta Muse is the intelligence throughout the experience

Muse powers a sequence of transformations. Each stage creates the context the
next stage needs: evidence becomes understanding, understanding becomes a map,
and shared understanding becomes an opportunity.

```mermaid
flowchart LR
  A[Your work history] --> B[Muse Spark: understand the person]
  B --> C[Editable readings]
  C --> D[Your approval]
  D --> E[Muse Spark: connected personal wiki]
  D --> F[Muse Spark: reasons to collaborate]
  G[Other people's shared context] --> F
  H[Your photo] --> I[Muse Image: your pixel twin]
  I --> J[A shared world]
  E --> J
  F --> J
```

| Meta capability | What we built with it | Why it matters |
| --- | --- | --- |
| **Muse Spark · `muse-spark-1.3`** | Evidence-based interpretation across selected coding sessions, followed by concise profile readings | Surfaces current work and supported patterns that a static bio misses |
| **Muse Spark · `muse-spark-1.3`** | A second synthesis into wiki concepts, prose and relationships | Makes the underlying understanding visible and explorable |
| **Muse Spark · `muse-spark-1.3`** | Semantic discovery across approved profile statements | Finds adjacent ideas and complementary experience beyond exact keyword overlap |
| **Muse Image · `muse-image-1.0`** | Photo-conditioned pixel portraits and animation poses, packed locally into character sheets | Gives personal context a recognisable presence in the world |
| **Muse Voice Transcribe · `muse-voice-transcribe-1.0`** | An optional transcription API for turning a spoken update into editable text | Provides another way to feed current context into the same understanding pipeline |

The main experience combines text intelligence and image generation. The voice
transcription endpoint is available as an additional input capability; its full
frontend flow is a next step.

## What makes this different

<p align="center">
  <a href="docs/images/personal-readings.png"><img src="docs/images/personal-readings.png" alt="Editable readings surfacing current projects, interests and ways of working from coding sessions" width="1100" /></a>
  <br />
  <em>From the tasks you asked for to the patterns you recognise in yourself.</em>
</p>

**Work becomes a living profile.** The starting point is what someone actually
brings to their agent: projects, decisions, questions and intentions. Dated
evidence helps the system distinguish earlier activity from current focus.

**Interpretation happens at multiple levels.** We move from individual excerpts
to a coherent understanding, then to concepts and relationships, then to a
possible connection between people. Each level answers a different question.

**Complementarity opens up discovery.** The valuable person may use different
tools or work in another field. A researcher who can sharpen your evaluation
question or a visual storyteller who can make your product legible may be more
useful than another person with the same technical stack.

**The explanation is part of the match.** You can see the two sides of the
connection and explore why they belong together. The introduction arrives with
something worth talking about.

**The person shapes their twin.** Sources support the readings; editing and
publication give the owner control over how that understanding represents them.
The backend validates cited references and checks that sharing remains active
before returning live introductions.

## The larger idea

Cofounder discovery is one starting point. The same foundation can help a team
find an internal collaborator, a builder find a creative partner, or a community
connect people who are approaching the same problem from different directions.

As agents gain more context about our work, there is an opportunity to turn that
understanding into value **between people**. Pixel Societies makes that idea
concrete: a twin you recognise, a world you can explore, and a reason to start a
conversation.

## Stack and repository

- **Frontend:** Next.js 16, React 19, TypeScript, Phaser and a wiki graph.
- **Backend:** Python 3.12, FastAPI, asyncpg and Pydantic AI.
- **Data:** PostgreSQL; local Supabase supplies database infrastructure and storage.
- **Authentication:** the FastAPI email/password service issues JWTs. Legacy
  `SUPABASE_*` configuration names remain in use.
- **Storage:** Supabase Storage locally, or Azure Blob Storage when configured.

```text
app/                         Next.js pages and onboarding
components/                  World, notebook, graph and connection UI
backend/app/                 API, agents and integrations
backend/app/twin_memory/      Interpretation, publication, wiki and matching
backend/data/wikis/           Existing character profiles and wiki content
public/                      Portraits, pixel assets and reference images
supabase/migrations/         Versioned database schema
backend/tests/               Backend tests
```

## Running locally

```bash
git clone https://github.com/leeu3581/pixel-societies-public.git
cd pixel-societies-public
```

### 1. Prerequisites

Install **Node.js 22**, **Python 3.12**, **Docker**, and the **Supabase CLI**.
Start Docker before starting Supabase. You also need access to the Meta models
listed above and a Meta Model API key. No Azure account is required for this local
setup. Run commands from the repository root unless otherwise shown.

```bash
npm ci
python3.12 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.lock
cp .env.local.example .env.local
cp backend/.env.example backend/.env
```

Do not overwrite existing environment files if you have already configured them.

### 2. Start the local database and storage

```bash
supabase start
supabase status -o env
```

A fresh local Supabase instance applies the checked-in migrations. For an existing
instance, apply outstanding migrations without resetting its data:

```bash
supabase migration up --local
```

Copy the local `JWT_SECRET` and `SERVICE_ROLE_KEY` from the status output into
`SUPABASE_JWT_SECRET` and `SUPABASE_SERVICE_ROLE_KEY` in `backend/.env`.
The template already contains the default local database and API addresses.
If your CLI reports different addresses, use those values. Do not commit or share
the status output. Migration `0005_storage.sql` creates the public `sprites`
bucket; later migrations add profiles, worlds, memory and discovery tables.

The repository does not require a production database dump or existing user
credentials. Create your own account through the application.

### 3. Configure the backend

Edit **`backend/.env`**. The required configuration for the main flow is:

| Variable | Value / purpose |
| --- | --- |
| `SUPABASE_DB_URL` | Local default: `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| `SUPABASE_URL` | Local default: `http://127.0.0.1:54321`; used for storage |
| `SUPABASE_JWT_SECRET` | Local JWT secret; signs and verifies application sessions |
| `SUPABASE_SERVICE_ROLE_KEY` | Local service-role key; backend uploads original photos and generated images |
| `META_API_KEY` | Your Meta Model API key; used for text and image generation |
| `LLM_PROVIDER` | `meta` |
| `META_MODEL` | `muse-spark-1.3` |
| `TWIN_MEMORY_AI_ENABLED` | `1` enables the private interpretation/wiki pipeline |
| `TWIN_DISCOVERY_ENABLED` | `1` enables connections |
| `LLM_DISABLED` | `1` disables unrelated model paths; it does **not** disable the explicitly enabled twin pipeline or image generation |
| `DISABLE_ENGINE_LOOP` | `1` keeps the autonomous world loop off |
| `DISABLE_SOCIETY_LOOP` | `1` keeps the autonomous society loop off |
| `ALLOWED_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` |

Model calls can incur charges. No model, database or storage credentials belong in
`NEXT_PUBLIC_*` variables. The frontend only needs
`NEXT_PUBLIC_CHAT_BACKEND_HOST=localhost:4000` in **`.env.local`**—a host and port,
without `http://`.

### 4. Start the application

Backend terminal:

```bash
cd backend
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 4000 --reload
```

Frontend terminal, from the repository root:

```bash
npm run dev -- --port 3000
```

Open **http://localhost:3000**. The API documentation is at
**http://127.0.0.1:4000/docs**; a basic health check is:

```bash
curl http://127.0.0.1:4000/api/health
```

Sign up, complete name/photo onboarding, then import session files from
`~/.claude/projects/<project>/*.jsonl`. The root `~/.claude/history.jsonl` is not
the full per-project session export. The importer accepts up to 100 files and
50 MB combined. Importing joins your character to the cofounder cafe.

FastAPI loads `backend/.env` when launched from `backend/`. It does **not**
automatically merge `backend/.env.local`; the root `.env.local` belongs to Next.js.
Restart the relevant process after changing its environment.

### Optional integrations

**Gmail context:** configure a Google OAuth web client with Gmail API access and
an allowed test user if the consent screen is in testing mode. Set
`GOOGLE_GMAIL_CLIENT_ID`, `GOOGLE_GMAIL_CLIENT_SECRET`, and
`GOOGLE_GMAIL_REDIRECT_URI=http://localhost:3000/profile/gmail`. Register that exact
redirect URI in the OAuth client. Set `GMAIL_TOKEN_ENCRYPTION_KEY` to a Fernet key:

```bash
backend/.venv/bin/python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
```

Keep that key stable across restarts; changing it prevents decryption of existing
stored tokens. Gmail requests read-only access and processes bounded sent-message
context for review. Its summarizer uses the general model path, so set
`LLM_DISABLED=0` to enable it; keep both autonomous-loop flags at `1` if you do
not want background activity. Connect Gmail from the profile page. This is
separate from Google sign-in, which is not part of the working login flow.

**Azure Blob Storage:** instead of Supabase storage, set
`AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_SPRITES_CONTAINER` (default `sprites`) and
`AZURE_STORAGE_SPRITES_SAS`. Provision the container with permissions for uploads
and browser-readable image URLs. A nonempty account selects Azure storage.

**Azure OpenAI text inference:** set `LLM_PROVIDER=azure`,
`AZURE_OPENAI_ENDPOINT` (the `/openai/v1/` endpoint), `AZURE_OPENAI_API_KEY`, and
`AZURE_OPENAI_DEPLOYMENT`. The twin pipeline supports Meta or this Azure path;
there is no automatic provider failover. Photo generation still needs the Meta
key. Other legacy agent providers are not required for the submission flow.

**Voice transcription:** `META_VOICE_ENABLED=1` enables the Meta transcription
endpoint using the same Meta key. The older live voice interview is a separate
Gemini feature requiring `GEMINI_API_KEY`.

**Other optional services:** `LOGFIRE_TOKEN` enables remote observability;
`DEVIN_SERVICE_API_KEY` is for the Devin routes; `MONTY_SIDECAR_URL` and optional
`MONTY_SIDECAR_SECRET` configure the code sandbox. None is required for onboarding,
readings, wiki synthesis or the connection panel. Leave remote telemetry disabled
with `LOGFIRE_SEND_TO_LOGFIRE=false` for a local run.

## Checks and troubleshooting

```bash
npx --no-install tsc --noEmit
npm run build
cd backend
.venv/bin/python -m pytest tests/test_twin_memory.py tests/test_meta.py tests/test_cc_onboarding.py -q
```

- **Frontend cannot reach the API:** check host/port, restart Next.js after editing
  `.env.local`, and ensure the browser origin is in `ALLOWED_ORIGINS`.
- **Sign-in reports server configuration errors:** check the JWT secret and database
  URL. `supabase status` confirms whether local services are running.
- **Photo generation fails:** check Meta image-model access and storage credentials.
  A working text-model key alone does not prove access to image generation.
- **Analysis stays unavailable:** check Meta credentials, model access and
  `TWIN_MEMORY_AI_ENABLED=1`. Uploaded evidence can remain saved while AI is disabled.
- **Wiki is still building:** the richer concept graph is a separate model pass
  after approval; allow it to finish or use the retry control if it fails.
- **No live matches:** both sides need active shared context. Authored roster
  connections appear in the cafe after you have published at least one note.

The full end-to-end flow is not run automatically by these commands. Local DB
contract tests are opt-in with `RUN_LOCAL_MEMORY_TESTS=1`; use a disposable local
database, not a production database.

See [DOCKER.md](DOCKER.md) for the backend image and the limitations of the legacy
Compose workflow. Product architecture is described in
[docs/TWIN-MEMORY-AND-DISCOVERY.md](docs/TWIN-MEMORY-AND-DISCOVERY.md).

## License

All rights reserved.

### Sample world

The public edition includes the approved Joon, Nat and Yuri profiles alongside three fictional sample characters. Upload your own sessions to build a personal twin and explore the matching flow.
