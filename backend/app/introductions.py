"""Introduction path finder — BFS over the wiki relationship graph.

Given two agent IDs, finds the shortest social chain using
`## Key relationships` sections in hub pages.
"""

from __future__ import annotations

import re
from collections import deque
from pathlib import Path

from .agents import WIKIS_DIR, get_agent, list_all_agents


def _build_relationship_graph() -> dict[str, list[tuple[str, str]]]:
    """Build adjacency list from hub page Key Relationships sections.

    Returns {agent_id: [(peer_agent_id, relationship_context), ...]}.
    """
    graph: dict[str, list[tuple[str, str]]] = {}
    # Build a name→id lookup for fuzzy matching
    name_to_id: dict[str, str] = {}
    for a in list_all_agents():
        graph[a.id] = []
        name_to_id[a.name.lower()] = a.id
        # Also map first name
        first = a.name.split()[0].lower()
        if first not in name_to_id:
            name_to_id[first] = a.id

    for a in list_all_agents():
        agent_dir = WIKIS_DIR / a.id
        hub = agent_dir / f"{a.name}.md"
        if not hub.exists():
            continue
        text = hub.read_text(encoding="utf-8")
        m = re.search(r"^## Key relationships\s*\n((?:.*\n)*?)(?=^## |\Z)", text, re.MULTILINE)
        if not m:
            continue
        for line in m.group(1).splitlines():
            rm = re.match(r"^\s*-\s+\[\[([^\]]+)\]\]\s*—\s*(.+)$", line)
            if not rm:
                continue
            peer_name = rm.group(1).strip().lower()
            context = rm.group(2).strip()
            peer_id = name_to_id.get(peer_name)
            if peer_id and peer_id != a.id:
                graph[a.id].append((peer_id, context))

    return graph


def find_introduction_path(
    from_id: str,
    to_id: str,
) -> list[dict[str, str]]:
    """BFS shortest path from from_id to to_id over the relationship graph.

    Returns list of dicts: [{id, name, relationship}, ...] where relationship
    is the context string for the edge TO the next node. Last node has
    relationship="".

    Returns empty list if no path exists.
    """
    if from_id == to_id:
        a = get_agent(from_id)
        return [{"id": from_id, "name": a.name if a else from_id, "relationship": ""}]

    graph = _build_relationship_graph()
    if from_id not in graph or to_id not in graph:
        return []

    # BFS
    visited: set[str] = {from_id}
    # Queue items: (current_id, path_so_far)
    # path_so_far: [(agent_id, relationship_context_to_next)]
    queue: deque[tuple[str, list[tuple[str, str]]]] = deque()
    queue.append((from_id, [(from_id, "")]))

    while queue:
        current, path = queue.popleft()
        for peer_id, context in graph.get(current, []):
            if peer_id in visited:
                continue
            new_path = path[:-1] + [(current, context), (peer_id, "")]
            if peer_id == to_id:
                # Build result
                result = []
                for aid, rel in new_path:
                    a = get_agent(aid)
                    result.append({
                        "id": aid,
                        "name": a.name if a else aid,
                        "relationship": rel,
                    })
                return result
            visited.add(peer_id)
            queue.append((peer_id, new_path))

    # No path found — fallback via world owners
    return _fallback_path(from_id, to_id)


def _fallback_path(from_id: str, to_id: str) -> list[dict[str, str]]:
    """Fallback: from_agent → world_owner → to_agent."""
    from .agents import _AGENT_WORLDS

    to_world = _AGENT_WORLDS.get(to_id, "joon")
    # World owners
    world_owners = {"joon": "support", "sage": "success", "yuri": "engineering"}
    owner_id = world_owners.get(to_world, "support")

    result = []
    for aid in [from_id, owner_id, to_id]:
        a = get_agent(aid)
        result.append({
            "id": aid,
            "name": a.name if a else aid,
            "relationship": "extended network" if aid != to_id else "",
        })
    return result
