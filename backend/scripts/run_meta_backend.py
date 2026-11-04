"""Start only against an explicitly configured loopback database, on port 4011."""
import os
from pathlib import Path
import sys
from urllib.parse import urlparse

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'backend'))


def configure():
    # Local config only; no copying snapshots from another worktree or Azure setup.
    for path in [ROOT/'.env.local', ROOT/'.env', ROOT/'backend/.env.local', ROOT/'backend/.env']:
        if path.is_file():
            for key, value in dotenv_values(path).items():
                if value is not None:
                    os.environ.setdefault(key, value)
    parsed = urlparse(os.getenv('SUPABASE_DB_URL', ''))
    if parsed.scheme not in ('postgres', 'postgresql') or parsed.hostname not in ('localhost', '127.0.0.1', '::1'):
        raise RuntimeError('Set SUPABASE_DB_URL to a prepared local PostgreSQL database; remote startup refused.')
    if not os.getenv('META_API_KEY', '').strip():
        raise RuntimeError('META_API_KEY is missing.')
    os.environ.update(LLM_PROVIDER='meta', TWIN_MEMORY_AI_ENABLED='1', TWIN_DISCOVERY_ENABLED='1',
                      META_VOICE_ENABLED='1', LLM_DISABLED='1', DISABLE_ENGINE_LOOP='1', DISABLE_SOCIETY_LOOP='1')
    # Private inference already suppresses instrumentation; keep local demo telemetry local too.
    os.environ['LOGFIRE_TOKEN'] = ''
    os.environ['LOGFIRE_SEND_TO_LOGFIRE'] = 'false'


if __name__ == '__main__':
    configure()
    import uvicorn
    uvicorn.run('app.main:app', host='127.0.0.1', port=4011)
