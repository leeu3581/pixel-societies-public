"""Shared inference selection. Explicit providers never silently fail over."""
import os
from urllib.parse import urlparse


def build_model():
    # Preserve the Azure migration's kill switch across every shared-model caller,
    # including Gmail context generation. Check before credentials or providers.
    if os.getenv('LLM_DISABLED', '').strip() == '1':
        from pydantic_ai.models.function import FunctionModel

        def refuse(messages, info):
            raise RuntimeError('LLM is disabled (LLM_DISABLED=1).')

        return FunctionModel(refuse)
    provider = os.getenv('LLM_PROVIDER', '').strip().lower()
    if provider == 'meta':
        from .meta import build_meta_model
        return build_meta_model()
    endpoint = os.getenv('AZURE_OPENAI_ENDPOINT', '').strip()
    if provider == 'azure' or (not provider and endpoint):
        from pydantic_ai.models.openai import OpenAIResponsesModel
        from pydantic_ai.providers.openai import OpenAIProvider
        key = os.getenv('AZURE_OPENAI_API_KEY', '').strip()
        deployment = os.getenv('AZURE_OPENAI_DEPLOYMENT', '').strip()
        parsed = urlparse(endpoint)
        if not key or not deployment or parsed.scheme != 'https' or not parsed.path.rstrip('/').endswith('/openai/v1'):
            raise RuntimeError('Azure requires an HTTPS /openai/v1/ endpoint, API key and deployment')
        return OpenAIResponsesModel(deployment, provider=OpenAIProvider(base_url=endpoint.rstrip('/')+'/', api_key=key), settings={'openai_store': False})
    if provider == 'openai' or (not provider and os.getenv('OPENAI_API_KEY')):
        from pydantic_ai.models.openai import OpenAIResponsesModel
        from pydantic_ai.providers.openai import OpenAIProvider
        return OpenAIResponsesModel(os.getenv('OPENAI_MODEL') or 'gpt-6-astra', provider=OpenAIProvider(api_key=os.environ['OPENAI_API_KEY']), settings={'openai_store': False})
    if os.getenv('PYDANTIC_AI_GATEWAY_API_KEY', '').strip():
        return os.getenv('PYDANTIC_AI_GATEWAY_MODEL') or 'gateway/anthropic:claude-haiku-4-5-20251001'
    if provider in ('gemini', 'google'):
        from pydantic_ai.models.google import GoogleModel
        from pydantic_ai.providers.google import GoogleProvider
        key = os.getenv('GOOGLE_API_KEY') or os.getenv('GEMINI_API_KEY')
        if not key:
            raise RuntimeError('Google inference requires GOOGLE_API_KEY or GEMINI_API_KEY')
        return GoogleModel(os.getenv('LLM_MODEL') or 'gemini-2.5-flash', provider=GoogleProvider(api_key=key))
    if provider not in ('', 'anthropic'):
        raise RuntimeError('Unknown LLM_PROVIDER')
    from pydantic_ai.models.anthropic import AnthropicModel
    return AnthropicModel(os.getenv('ANTHROPIC_MODEL') or 'claude-haiku-4-5-20251001')
