"""Meta Model API configuration. No implicit provider fallback or credential logging."""
import os

META_BASE_URL = 'https://api.meta.ai/v1/'
DEFAULT_TEXT_MODEL = 'muse-spark-1.3'
DEFAULT_VOICE_MODEL = 'muse-voice-transcribe-1.0'


def api_key() -> str:
    key = os.getenv('META_API_KEY', '').strip()
    if not key:
        raise RuntimeError('Meta requires META_API_KEY in ignored local configuration')
    return key


def text_model() -> str:
    model = os.getenv('META_MODEL', DEFAULT_TEXT_MODEL).strip()
    # Private work history must not accidentally select a contributor/training mode.
    if model not in {'muse-spark-1.1', 'muse-spark-1.2', 'muse-spark-1.3', 'muse-wonder-1.0'}:
        raise RuntimeError('META_MODEL must select a documented Standard-mode text model')
    return model


def build_meta_model():
    from openai import AsyncOpenAI
    from pydantic_ai.models.openai import OpenAIResponsesModel
    from pydantic_ai.profiles.openai import OpenAIModelProfile
    from pydantic_ai.providers.openai import OpenAIProvider
    # Meta explicitly documents this wire format; compatibility is not inferred.
    # Bound SDK transport retries separately from the agent's schema repair retry.
    client = AsyncOpenAI(base_url=META_BASE_URL, api_key=api_key(),
                         timeout=50.0, max_retries=0)
    # Use Meta's documented text.format JSON schema, not an artificial output tool.
    profile = OpenAIModelProfile(supports_json_schema_output=True,
                                 default_structured_output_mode='native')
    return OpenAIResponsesModel(text_model(), provider=OpenAIProvider(openai_client=client), profile=profile,
        settings={'openai_store': False, 'openai_reasoning_effort': 'low'})


def analysis_cache_identity() -> dict:
    """No secrets: prevents replaying one provider's results as another's."""
    provider = os.getenv('LLM_PROVIDER', '').strip().lower()
    if provider == 'meta':
        return {'provider': 'meta', 'model': text_model(),
                'twin_enabled': os.getenv('TWIN_MEMORY_AI_ENABLED', ''),
                'disabled': os.getenv('LLM_DISABLED', '')}
    return {'provider': provider, 'twin_enabled': os.getenv('TWIN_MEMORY_AI_ENABLED', ''),
            'model': os.getenv('AZURE_OPENAI_DEPLOYMENT', '') or os.getenv('LLM_MODEL', ''),
            'disabled': os.getenv('LLM_DISABLED', '')}
