# Using the Obsidian vault

The wiki layer doubles as an Obsidian vault, so you can browse the
agents' knowledge as a real bidirectional knowledge graph.

## One-time setup

1. Install [Obsidian](https://obsidian.md) (free).
2. From the repo root, install the vault template:
   ```bash
   ./vault-template/install.sh
   ```
   This copies `.obsidian/` (graph view defaults + colour groups per agent)
   and `README.md` into `backend/data/wikis/`. The `data/` dir is
   gitignored, so the template lives at the top level and gets copied in
   on demand.
3. Open Obsidian → **Open vault as folder** → pick `backend/data/wikis/`.
4. Obsidian loads the workspace from the installed `.obsidian/workspace.json`:
   - **Left pane:** graph view (nodes colour-coded per agent folder)
   - **Right pane:** the vault README
5. Open the graph view (`Ctrl/Cmd+G` if it didn't auto-open).

## What you'll see

```
README ─── connects everything

marketing/index ──┬─ right-now-music
                  ├─ internet-moments ──── shows-having-a-moment
                  └─ shows-having-a-moment

engineering/index ─┬─ photo-books-i-keep-returning-to
                   ├─ films-that-taught-me-something ─── playlist-shapes
                   └─ playlist-shapes

(after a conversation)
marketing/visual-language ──Source──▶ engineering/films-that-taught-me-something
```

Cross-agent edges are the interesting ones — they're created live when
an agent invokes `create_wiki_page` / `append_to_wiki_page` during a
conversation and passes `quoted_from_peer_slug`. The store writes a
`> Source: [[../{peer_agent}/{peer_slug}]]` line in the page body, which
Obsidian renders as a graph edge.

## Live demo flow

For the pitch:

1. Open Obsidian on the secondary screen, graph view full-window.
2. Open the conversation UI on the primary screen.
3. Run a 6-turn conversation (Yuri ↔ Ellis is the proven pair).
4. After each `wiki_change` event, click into the Obsidian graph
   view (or hit `F5`) to refresh — new nodes pop in, new edges
   draw between agent folders.
5. The bidirectional graph is the "auditable self-improvement"
   thesis made visible.

## Resetting the vault for a clean demo

```bash
rm -rf backend/data/wikis/{marketing,engineering,sales,support,product,success}
# Restart the backend — seed.py re-runs and rebuilds the seeded pages
```

This wipes accumulated conversation pages but preserves your `.obsidian/`
config.

## Why is the vault gitignored?

`backend/data/` is treated as runtime state. The seed at backend boot is
the source of truth, so nothing in `data/` is committed. If you want a
frozen demo snapshot for the slides, copy `data/wikis/` somewhere outside
the gitignore and commit that copy.
