"""LLM extraction passes — chunk → ChunkExtraction, all chunks → ProfilePage.

Both passes use pydantic-ai with structured output_type so the model
literally cannot return free-form prose. Each chunk is small enough
to fit in one call; the synthesizer aggregates across chunks into the
final document.
"""

from __future__ import annotations

import json

from pydantic_ai import Agent

from ..conversation import _build_model
from .models import ChunkExtraction, ProfilePage


_WHATSAPP_PROMPT = (
    "You are extracting structured signal from a chunk of a WhatsApp\n"
    "conversation. The user message contains:\n"
    "  TARGET — the name of the person you are profiling (NOT the user).\n"
    "  TIMEFRAME — the date range covered by this chunk.\n"
    "  MESSAGES — verbatim chat lines from both speakers.\n\n"
    "Your job: extract everything the TARGET said or revealed about\n"
    "themselves. Pull these structured fields:\n\n"
    "- entities — proper nouns the TARGET referenced. People,\n"
    "  companies, products, places, tools, named concepts. Each\n"
    "  with `kind` and a one-clause `note`.\n"
    "- events — dated happenings. Use ISO month if possible.\n"
    "- interests — topics the TARGET cares about. Each with one\n"
    "  concrete `evidence` sentence (quoting or paraphrasing them).\n"
    "- opinions — sharp positions the TARGET took. Quote-flavoured.\n"
    "- voice_samples — 2–4 short verbatim quotes (≤120 chars each)\n"
    "  that show the TARGET's register/tone/tics.\n"
    "- links — URLs the TARGET shared, with one-clause purpose.\n"
    "- relationships — named people the TARGET mentioned and how\n"
    "  they relate to her/him.\n"
    "- summary — one paragraph summary of this chunk.\n\n"
    "Hard rules:\n"
    "- Only extract about the TARGET. Ignore signal about the user.\n"
    "- Quote concrete specifics. Not 'she likes tech' but\n"
    "  'she organised the BFL hackathon in Berlin'.\n"
    "- If a field has no signal in this chunk, return an empty list.\n"
    "- Set `chunk_label` to the TIMEFRAME string the user gave you."
)

_TEXT_DOC_PROMPT = (
    "You are extracting structured signal from a document or pasted\n"
    "text describing a person. The user message contains:\n"
    "  SUBJECT — the name of the person being profiled.\n"
    "  CHUNK_LABEL — which slice of the document this is.\n"
    "  TEXT — verbatim prose from the document.\n\n"
    "Your job: extract everything the TEXT reveals about the SUBJECT.\n"
    "Pull these structured fields:\n\n"
    "- entities — proper nouns associated with the SUBJECT. People,\n"
    "  companies, products, places, tools. Each with `kind` and a\n"
    "  one-clause `note`.\n"
    "- events — dated happenings. Use ISO month if possible.\n"
    "- interests — topics the SUBJECT engages with, each with a\n"
    "  concrete `evidence` sentence drawn from the text.\n"
    "- opinions — positions the SUBJECT holds (per the text).\n"
    "- voice_samples — short quotes (if the text quotes the SUBJECT).\n"
    "  Skip if the document is purely third-person.\n"
    "- links — URLs in the text that relate to the SUBJECT.\n"
    "- relationships — named people the SUBJECT is connected to.\n"
    "- summary — one paragraph summary of what this chunk reveals.\n\n"
    "Hard rules:\n"
    "- Quote concrete specifics. Tools, dates, numbers, named places.\n"
    "- If a field has no signal in this chunk, return an empty list.\n"
    "- Set `chunk_label` to the CHUNK_LABEL the user gave you."
)


def _chunk_agent(mode: str = "whatsapp") -> Agent[None, ChunkExtraction]:
    prompt = _TEXT_DOC_PROMPT if mode == "text_doc" else _WHATSAPP_PROMPT
    return Agent(
        _build_model(),
        output_type=ChunkExtraction,
        system_prompt=prompt,
        retries=3,
    )


def _profile_agent() -> Agent[None, ProfilePage]:
    return Agent(
        _build_model(),
        output_type=ProfilePage,
        retries=3,
        system_prompt=(
            "You are synthesising a structured person-profile from many\n"
            "chunk extractions of a WhatsApp conversation.\n\n"
            "The user message contains:\n"
            "  TARGET — the person being profiled.\n"
            "  CHUNK_EXTRACTIONS — JSON array of ChunkExtraction objects.\n"
            "  TIMEFRAME — the full date range covered.\n\n"
            "Produce a `ProfilePage` matching the Zoe.md template:\n"
            "- `name` — the TARGET's name (clean, no LRM marks).\n"
            "- `aliases` — any nicknames/spellings observed.\n"
            "- `subtitle` — TWO TO FOUR WORDS prefixed with 'The'. The single\n"
            "  archetype that captures this person's defining pattern.\n"
            "  Examples: 'The Community Builder', 'The Operator', 'The\n"
            "  Connector', 'The Critic', 'The Maker', 'The Storyteller'.\n"
            "  Should be specific to what THIS person actually does, not\n"
            "  generic. No quotes, no period. Just 'The X' or 'The X Y'.\n"
            "- `overview` — TWO paragraphs. Para 1: who they are, where\n"
            "  they live/work, headline relationships. Para 2: what they\n"
            "  founded/run and how they're embedded in their scene. Wrap\n"
            "  proper nouns in `[[wikilinks]]` Obsidian-style.\n"
            "- `work` — `day_job`, `side_projects`, and\n"
            "  `investment_or_business_interests` as markdown bullet lists.\n"
            "  Use `-` bullets, not numbered.\n"
            "- `interests` — top 4–7 topic clusters. Each cluster has a\n"
            "  `title` and 4–10 specific bullets. Bullets must reference\n"
            "  named tools, dates, places, projects — NOT vibes.\n"
            "- `projects` — concrete things the TARGET built or runs.\n"
            "  Include URLs when present.\n"
            "- `link_groups` — categorise URLs (events, products, tools,\n"
            "  LinkedIn, content). Drop duplicates.\n"
            "- `relationships` — top 6–12 named people, each with\n"
            "  2–4 sentences on the relationship.\n"
            "- `communication_style` — `one_line` adjective-rich summary +\n"
            "  4–8 trait bullets covering register, slang, tics.\n"
            "- `recurring_themes` — 3–5 named arcs (one short title +\n"
            "  one paragraph each) describing repeating tensions/threads.\n\n"
            "Hard rules:\n"
            "- Cite specifics. If you can't ground a bullet in a chunk\n"
            "  extraction, drop it.\n"
            "- For `overview`, prefer dense factual paragraphs. No filler.\n"
            "- Wrap proper nouns in `[[ ]]` only on FIRST mention in each\n"
            "  section to avoid clutter.\n"
            "- If the chunks contain almost no signal on a section,\n"
            "  return that section empty rather than fabricating."
        ),
    )


async def extract_chunk(
    chunk_label: str,
    target_sender: str,
    rendered_messages: str,
    mode: str = "whatsapp",
) -> ChunkExtraction:
    if mode == "text_doc":
        body = (
            f"SUBJECT: {target_sender}\n"
            f"CHUNK_LABEL: {chunk_label}\n\n"
            f"TEXT:\n{rendered_messages}"
        )
    else:
        body = (
            f"TARGET: {target_sender}\n"
            f"TIMEFRAME: {chunk_label}\n\n"
            f"MESSAGES:\n{rendered_messages}"
        )
    result = await _chunk_agent(mode=mode).run(body)
    extraction = result.output
    extraction.chunk_label = chunk_label
    return extraction


async def synthesise_profile(
    target_sender: str,
    extractions: list[ChunkExtraction],
    timeframe: str,
) -> ProfilePage:
    body = (
        f"TARGET: {target_sender}\n"
        f"TIMEFRAME: {timeframe}\n\n"
        f"CHUNK_EXTRACTIONS:\n```json\n"
        + json.dumps([e.model_dump(mode="json") for e in extractions], indent=2)
        + "\n```"
    )
    result = await _profile_agent().run(body)
    return result.output
