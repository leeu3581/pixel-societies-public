import pytest
from app.llm import build_model


@pytest.fixture(autouse=True)
def env(monkeypatch):
    for key in ['LLM_DISABLED', 'LLM_PROVIDER', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_DEPLOYMENT', 'OPENAI_API_KEY', 'PYDANTIC_AI_GATEWAY_API_KEY']:
        monkeypatch.delenv(key, raising=False)


def test_disabled_model_needs_no_credentials_and_refuses_generation(monkeypatch):
    from pydantic_ai import Agent
    monkeypatch.setenv('LLM_DISABLED', '1')
    monkeypatch.setenv('LLM_PROVIDER', 'azure')
    with pytest.raises(RuntimeError, match='LLM is disabled'):
        Agent(build_model()).run_sync('Synthetic test; no provider call permitted.')


def test_azure_precedes_legacy_gateway_and_does_not_store(monkeypatch):
    monkeypatch.setenv('LLM_PROVIDER', 'azure')
    monkeypatch.setenv('AZURE_OPENAI_ENDPOINT', 'https://synthetic.openai.azure.com/openai/v1/')
    monkeypatch.setenv('AZURE_OPENAI_API_KEY', 'synthetic-key')
    monkeypatch.setenv('AZURE_OPENAI_DEPLOYMENT', 'synthetic-deployment')
    monkeypatch.setenv('PYDANTIC_AI_GATEWAY_API_KEY', 'synthetic-legacy')
    model = build_model()
    assert model.model_name == 'synthetic-deployment'
    assert str(model.client.base_url) == 'https://synthetic.openai.azure.com/openai/v1/'
    assert model.settings['openai_store'] is False


def test_incomplete_azure_fails_closed_without_fallback(monkeypatch):
    monkeypatch.setenv('LLM_PROVIDER', 'azure')
    monkeypatch.setenv('OPENAI_API_KEY', 'synthetic-fallback')
    with pytest.raises(RuntimeError):
        build_model()


def test_explicit_openai_fallback(monkeypatch):
    monkeypatch.setenv('LLM_PROVIDER', 'openai')
    monkeypatch.setenv('OPENAI_API_KEY', 'synthetic-fallback')
    monkeypatch.setenv('AZURE_OPENAI_ENDPOINT', 'https://ignored.openai.azure.com/openai/v1/')
    model = build_model()
    assert str(model.client.base_url) == 'https://api.openai.com/v1/'
