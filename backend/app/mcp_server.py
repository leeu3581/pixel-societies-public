"""MCP server — exposes each world's orchestrator so peer worlds can call it.

The semantic the user wants: "consult other world with the question, but
that simply calls the orchestrator for that world as if it was its own
world." So the MCP tool here runs the FULL local consult flow (router →
sequential answers → synthesizer) inside the requested world, scoped to
that world's roster, and returns the structured ConsultResult.

In-process today (the FastMCP app is mounted alongside FastAPI on the
same uvicorn) but the contract is identical to the eventual case where
each world is its own service — the orchestrator on side A talks to the
orchestrator on side B over MCP either way.
"""

from __future__ import annotations

from fastmcp import FastMCP

from .agents import DEFAULT_WORLD, list_worlds
from .consult import consult_world

mcp = FastMCP(
    name="unicorn-intelligence-orchestrator",
    instructions=(
        "Multi-world orchestrator bridge. Use consult_world to ask a peer "
        "world's team a question — the peer runs its own router → answers → "
        "synthesizer pipeline scoped to that world's roster, and returns a "
        "structured Verdict. Use list_worlds to discover available worlds."
    ),
)


@mcp.tool(name="consult_world")
async def consult_world_tool(question: str, world: str = DEFAULT_WORLD) -> dict:
    """Run the full consult flow inside `world` and return the structured result.

    The peer world's router picks 2–4 of its own agents, each agent answers
    in turn (seeing prior answers), and the synthesizer produces a Verdict.
    Useful when the calling orchestrator wants a perspective that lives in
    a different world's roster.
    """
    result = await consult_world(question, world)
    return result.model_dump(mode="json")


@mcp.tool(name="list_worlds")
def list_worlds_tool() -> list[str]:
    """List the worlds this orchestrator currently hosts."""
    return list_worlds()
