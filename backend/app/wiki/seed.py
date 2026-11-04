"""The public edition ships fictional sample wikis in data/wikis/."""
from .store import ensure_agent_dir

def seed_all_wikis() -> None:
    from ..agents import list_all_agents
    for agent in list_all_agents():
        ensure_agent_dir(agent.id)
