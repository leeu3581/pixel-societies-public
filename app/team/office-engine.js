// Unicorn Intelligence Scene — vanilla JS, Canvas 2D
// Characters wander around a pixel-art cityscape backdrop (the hero image).
// Click a character to chat with them.

// ── Constants ─────────────────────────────────────────────────
// Native character sprite size (from the sheet).
const SRC_W = 16;
const SRC_H = 32;
// Render scale so the character is visible against the 1600x679 cityscape.
const CHAR_SCALE = 8;
const CHAR_W = SRC_W * CHAR_SCALE;
const CHAR_H = SRC_H * CHAR_SCALE;

// Character sheet layout: 7 cols × 3 rows of 16×32 frames
//   Row 0 = down, Row 1 = up, Row 2 = right (left is flipped right)
const ROW_DOWN = 0;
const ROW_UP = 1;
const ROW_RIGHT = 2;

const WALK_SPEED_PX_PER_SEC = 40;
const WALK_FRAME_SEC = 0.16;
const IDLE_PAUSE_MIN = 1.5;
const IDLE_PAUSE_MAX = 4.0;
const TARGET_RADIUS_PX = 6;

// Jump animation constants
const JUMP_ARC_DUR = 1.4;     // seconds for the full arc flight
const JUMP_ARC_HEIGHT = 250;   // peak height of the arc in world px
const CLOUD_COUNT = 8;         // puff particles per burst
const CLOUD_LIFETIME = 0.9;    // seconds each cloud lives

const HERO_SRC = "/unicorn-intelligence-latest-map.webp";
const LAYOUT_SRC = "/team-office/default-layout-1.json";

// Walkability is driven by the tile grid in LAYOUT_SRC: each cell is
// 0=floor, 1=wall, 2=grass, 3=water, 4=portal. Walls and water block;
// floor, grass, and portal are passable. Grass cells are explicit spawn
// points; floor cells are only used if they're reachable from a grass
// cell (BFS through passable tiles), which prunes interior pockets that
// happen to be empty but are walled off from the playable area.
// WALKABLE_ZONES is the legacy fallback for layouts with no tile grid.
let TILE_GRID = null;
let WALKABLE_ZONES = [];

const TILE_FLOOR = 0;
const TILE_GRASS = 2;
const TILE_PORTAL = 4;

function isPassableTile(v) {
  return v === TILE_FLOOR || v === TILE_GRASS || v === TILE_PORTAL;
}

// Resolve which worlds should be live for this session. The caller can
// override via `layout.activeWorlds` (the engine's load() injects the
// constructor option there); falls back to all declared worlds.
function resolveActiveWorldIds(layout) {
  const declared = Array.isArray(layout.worlds)
    ? layout.worlds.map((w) => String(w.id))
    : [];
  if (declared.length === 0) return [];
  const active = Array.isArray(layout.activeWorlds)
    ? layout.activeWorlds.map(String)
    : declared;
  // Preserve `worlds[]` ordering — this drives the portal cycle direction.
  const set = new Set(active);
  return declared.filter((id) => set.has(id));
}

// For each cell index, which world index it belongs to (or -1 if outside
// any defined world). Used to mask inactive worlds and to tag portals.
function buildWorldOfCell(layout, cols, rows) {
  const worlds = Array.isArray(layout.worlds) ? layout.worlds : [];
  const out = new Int8Array(cols * rows).fill(-1);
  worlds.forEach((w, idx) => {
    const b = w.tileBox || {};
    const c0 = Math.max(0, Math.floor(Number(b.col) || 0));
    const r0 = Math.max(0, Math.floor(Number(b.row) || 0));
    const c1 = Math.min(cols, c0 + Math.floor(Number(b.cols) || 0));
    const r1 = Math.min(rows, r0 + Math.floor(Number(b.rows) || 0));
    for (let r = r0; r < r1; r++) {
      const rowStart = r * cols;
      for (let c = c0; c < c1; c++) out[rowStart + c] = idx;
    }
  });
  return out;
}

// Cluster-detect portals, tag each cluster with its world index, then
// build a directed cycle through the active worlds:
//   1 active  → no partners (portal cells stay walkable, no teleport)
//   2 active  → A↔B (bidirectional, same as the legacy pairwise wiring)
//   3 active  → A→B, B→C, C→A (one-directional cycle)
function buildPortalGroups(data, cols, rows, worldOfCell, activeWorldIndices) {
  const visited = new Uint8Array(data.length);
  const clusters = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== TILE_PORTAL || visited[i]) continue;
    const cluster = [];
    const stack = [i];
    while (stack.length) {
      const j = stack.pop();
      if (visited[j] || data[j] !== TILE_PORTAL) continue;
      visited[j] = 1;
      cluster.push(j);
      const c = j % cols;
      const r = (j - c) / cols;
      if (c > 0) stack.push(j - 1);
      if (c < cols - 1) stack.push(j + 1);
      if (r > 0) stack.push(j - cols);
      if (r < rows - 1) stack.push(j + cols);
    }
    clusters.push(cluster);
  }

  const partnerOf = new Map();

  if (worldOfCell && activeWorldIndices && activeWorldIndices.length > 0) {
    // World-aware: index clusters by their owning world.
    const clusterByWorld = new Map();
    for (const cluster of clusters) {
      if (cluster.length === 0) continue;
      const wIdx = worldOfCell[cluster[0]];
      if (wIdx < 0) continue;
      if (!clusterByWorld.has(wIdx)) clusterByWorld.set(wIdx, cluster);
    }
    const cycle = activeWorldIndices
      .map((wIdx) => clusterByWorld.get(wIdx))
      .filter(Boolean);
    if (cycle.length === 2) {
      // Bidirectional pair (back-and-forth).
      const [a, b] = cycle;
      for (const idx of a) partnerOf.set(idx, b);
      for (const idx of b) partnerOf.set(idx, a);
    } else if (cycle.length >= 3) {
      // One-directional cycle: i → i+1.
      for (let i = 0; i < cycle.length; i++) {
        const next = cycle[(i + 1) % cycle.length];
        for (const idx of cycle[i]) partnerOf.set(idx, next);
      }
    }
    // cycle.length === 1: leave partnerOf empty → portals are inert.
    return { clusters, partnerOf };
  }

  // Legacy pairwise fallback for layouts without world definitions.
  for (let k = 0; k + 1 < clusters.length; k += 2) {
    const a = clusters[k];
    const b = clusters[k + 1];
    for (const idx of a) partnerOf.set(idx, b);
    for (const idx of b) partnerOf.set(idx, a);
  }
  return { clusters, partnerOf };
}

function buildTileGrid(layout, worldW, worldH) {
  const cols = Number(layout.tileCols);
  const rows = Number(layout.tileRows);
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  if (!Array.isArray(layout.tiles) || layout.tiles.length !== cols * rows) return null;

  const worlds = Array.isArray(layout.worlds) ? layout.worlds : [];
  const worldOfCell = worlds.length > 0 ? buildWorldOfCell(layout, cols, rows) : null;
  const activeWorldIds = resolveActiveWorldIds(layout);
  const activeWorldIndices = worlds.length > 0
    ? activeWorldIds
        .map((id) => worlds.findIndex((w) => String(w.id) === id))
        .filter((i) => i >= 0)
    : [];
  const activeWorldSet = new Set(activeWorldIndices);

  const cellActive = (i) => {
    if (!worldOfCell) return true;
    const w = worldOfCell[i];
    return w >= 0 && activeWorldSet.has(w);
  };

  const data = new Uint8Array(cols * rows);
  const reachable = new Uint8Array(cols * rows);
  const spawnCells = [];

  for (let i = 0; i < data.length; i++) {
    const v = Number(layout.tiles[i]) | 0;
    data[i] = v;
    if (v === TILE_GRASS && cellActive(i)) {
      spawnCells.push(i);
      reachable[i] = 1;
    }
  }

  const { clusters: portalClusters, partnerOf: portalPartnerOf } =
    buildPortalGroups(data, cols, rows, worldOfCell, activeWorldIndices);

  // BFS from grass cells through any passable AND active tile. Portal
  // cells also bridge to their partner cluster, so worlds joined only by
  // a portal still end up in the same reachable set.
  const queue = spawnCells.slice();
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const col = i % cols;
    const row = (i - col) / cols;
    const tryNeighbour = (n) => {
      if (!reachable[n] && isPassableTile(data[n]) && cellActive(n)) {
        reachable[n] = 1;
        queue.push(n);
      }
    };
    if (col > 0)        tryNeighbour(i - 1);
    if (col < cols - 1) tryNeighbour(i + 1);
    if (row > 0)        tryNeighbour(i - cols);
    if (row < rows - 1) tryNeighbour(i + cols);
    if (data[i] === TILE_PORTAL) {
      const partner = portalPartnerOf.get(i);
      if (partner) {
        for (const n of partner) {
          if (!reachable[n]) { reachable[n] = 1; queue.push(n); }
        }
      }
    }
  }

  const walkCells = [];
  if (spawnCells.length > 0) {
    for (let i = 0; i < data.length; i++) {
      if (reachable[i]) walkCells.push(i);
    }
  } else {
    for (let i = 0; i < data.length; i++) {
      if (isPassableTile(data[i]) && cellActive(i)) walkCells.push(i);
    }
  }

  // Per-world spawn pools — used by initCharacters to drop each agent
  // into their assigned world rather than anywhere on the map.
  const worldSpawnCells = worlds.map(() => []);
  for (const cellIdx of spawnCells) {
    const wIdx = worldOfCell ? worldOfCell[cellIdx] : -1;
    if (wIdx >= 0) worldSpawnCells[wIdx].push(cellIdx);
  }

  // Viewport = bounding box of active worlds' tileBoxes, in pixels. Lets
  // the renderer crop the canvas to just the live area (1 world fills
  // the editorial-tile, 2 worlds fill the top row, etc.) instead of
  // showing acres of cream where unloaded worlds would sit.
  const cellW = worldW / cols;
  const cellH = worldH / rows;
  let viewport = null;
  if (worlds.length > 0 && activeWorldIndices.length > 0) {
    let minC = Infinity, minR = Infinity, maxC = -Infinity, maxR = -Infinity;
    for (const idx of activeWorldIndices) {
      const b = worlds[idx].tileBox || {};
      const c0 = Math.floor(Number(b.col) || 0);
      const r0 = Math.floor(Number(b.row) || 0);
      const c1 = c0 + Math.floor(Number(b.cols) || 0);
      const r1 = r0 + Math.floor(Number(b.rows) || 0);
      if (c0 < minC) minC = c0;
      if (r0 < minR) minR = r0;
      if (c1 > maxC) maxC = c1;
      if (r1 > maxR) maxR = r1;
    }
    if (Number.isFinite(minC)) {
      viewport = {
        x: minC * cellW,
        y: minR * cellH,
        w: (maxC - minC) * cellW,
        h: (maxR - minR) * cellH,
      };
    }
  }

  return {
    cols,
    rows,
    cellW,
    cellH,
    data,
    spawnCells,
    walkCells,
    portalClusters,
    portalPartnerOf,
    worlds,
    worldOfCell,
    activeWorldIds,
    activeWorldIndices,
    worldSpawnCells,
    viewport,
  };
}

function pointInCell(grid, idx) {
  const col = idx % grid.cols;
  const row = (idx - col) / grid.cols;
  return {
    x: (col + Math.random()) * grid.cellW,
    y: (row + Math.random()) * grid.cellH,
  };
}

function pickSpawnPoint(grid) {
  if (!grid) return null;
  const pool = grid.spawnCells.length > 0 ? grid.spawnCells : grid.walkCells;
  if (pool.length === 0) return null;
  return pointInCell(grid, pool[Math.floor(Math.random() * pool.length)]);
}

function pickWalkTarget(grid) {
  if (!grid || grid.walkCells.length === 0) return null;
  return pointInCell(grid, grid.walkCells[Math.floor(Math.random() * grid.walkCells.length)]);
}

function clampCol(grid, x) {
  return Math.max(0, Math.min(grid.cols - 1, Math.floor(x / grid.cellW)));
}
function clampRow(grid, y) {
  return Math.max(0, Math.min(grid.rows - 1, Math.floor(y / grid.cellH)));
}

// 4-neighbour BFS over passable tiles. Returns waypoints in feet world
// coords (cell centers) or null if no path exists. The start cell is
// always treated as visited regardless of its tile value, so a character
// who's currently clipped into a wall can still BFS its way out.
//
// When `bridgePortals` is true, BFS treats partner-cluster cells as
// neighbours of each portal cell — that lets cross-portal targets be
// reachable. The reconstructed path is then truncated at the first
// portal-bridge edge: the character walks to the portal cell, the
// runtime teleport takes them across, and they re-plan from there.
// (Without truncation, the path would have a far jump that the engine
// would walk in a straight line, cutting through every wall in between.)
function pathfindFeet(grid, fromX, fromY, toX, toY, bridgePortals = true) {
  if (!grid) return null;
  const cols = grid.cols;
  const rows = grid.rows;
  const sc = clampCol(grid, fromX);
  const sr = clampRow(grid, fromY);
  const gc = clampCol(grid, toX);
  const gr = clampRow(grid, toY);
  const start = sr * cols + sc;
  const goal = gr * cols + gc;

  if (start === goal) {
    return [{ x: toX, y: toY }];
  }

  const cameFrom = new Int32Array(cols * rows);
  cameFrom.fill(-1);
  cameFrom[start] = start;
  const queue = [start];
  let head = 0;
  let found = false;

  while (head < queue.length) {
    const i = queue[head++];
    if (i === goal) { found = true; break; }
    const c = i % cols;
    const r = (i - c) / cols;
    if (c > 0)         { const n = i - 1;    if (cameFrom[n] === -1 && isPassableTile(grid.data[n])) { cameFrom[n] = i; queue.push(n); } }
    if (c < cols - 1)  { const n = i + 1;    if (cameFrom[n] === -1 && isPassableTile(grid.data[n])) { cameFrom[n] = i; queue.push(n); } }
    if (r > 0)         { const n = i - cols; if (cameFrom[n] === -1 && isPassableTile(grid.data[n])) { cameFrom[n] = i; queue.push(n); } }
    if (r < rows - 1)  { const n = i + cols; if (cameFrom[n] === -1 && isPassableTile(grid.data[n])) { cameFrom[n] = i; queue.push(n); } }
    if (bridgePortals && grid.data[i] === TILE_PORTAL && grid.portalPartnerOf) {
      const partner = grid.portalPartnerOf.get(i);
      if (partner) {
        for (const n of partner) {
          if (cameFrom[n] === -1) { cameFrom[n] = i; queue.push(n); }
        }
      }
    }
  }

  if (!found) return null;

  // Reconstruct the cell sequence from start to goal.
  const cellPath = [];
  let cur = goal;
  while (cur !== start) { cellPath.push(cur); cur = cameFrom[cur]; }
  cellPath.push(start);
  cellPath.reverse();

  // Truncate at the first non-4-adjacent step (a portal bridge).
  let truncatedAtPortal = false;
  let cutoff = cellPath.length;
  for (let i = 1; i < cellPath.length; i++) {
    const prev = cellPath[i - 1];
    const next = cellPath[i];
    const dCol = (next % cols) - (prev % cols);
    const dRow = Math.floor(next / cols) - Math.floor(prev / cols);
    if (Math.abs(dCol) + Math.abs(dRow) !== 1) {
      truncatedAtPortal = true;
      cutoff = i; // keep up to and including prev (the portal entry cell)
      break;
    }
  }

  const path = [];
  for (let i = 1; i < cutoff; i++) {
    const idx = cellPath[i];
    const c = idx % cols;
    const r = (idx - c) / cols;
    path.push({ x: (c + 0.5) * grid.cellW, y: (r + 0.5) * grid.cellH });
  }

  // Snap the last waypoint to the exact target only when the path actually
  // reaches the goal — if we truncated at a portal, the last waypoint must
  // stay on the portal cell center so the runtime teleport fires there.
  if (!truncatedAtPortal && path.length > 0) {
    path[path.length - 1] = { x: toX, y: toY };
  }
  return path;
}

// ── Legacy zone helpers (used only when tile grid is missing) ──────
function zoneArea(z) {
  return Math.max(0, z.x2 - z.x1) * Math.max(0, z.y2 - z.y1);
}
function pickZone() {
  const total = WALKABLE_ZONES.reduce((s, z) => s + zoneArea(z), 0);
  let r = Math.random() * total;
  for (const z of WALKABLE_ZONES) {
    r -= zoneArea(z);
    if (r <= 0) return z;
  }
  return WALKABLE_ZONES[0];
}
function pointInZone(z, marginX, marginY) {
  return {
    x: z.x1 + marginX + Math.random() * Math.max(1, z.x2 - z.x1 - 2 * marginX),
    y: z.y1 + marginY + Math.random() * Math.max(1, z.y2 - z.y1 - 2 * marginY),
  };
}

// ── Utility ───────────────────────────────────────────────────
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load " + url));
    img.src = url;
  });
}

function randRange(a, b) { return a + Math.random() * (b - a); }

// Stable palette index for an agent id — same agent always gets the
// same sprite across reloads regardless of where they sit in the
// agents array. With only six sprites available, large rosters see
// collisions; the hover label disambiguates.
function _hashPalette(id) {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  return Math.abs(h) % 6;
}

function sameStringArray(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── Engine ────────────────────────────────────────────────────
export class PixelOffice {
  constructor({ canvas, agents, onAgentClick, fullscreen = false, activeWorlds = null, fitMode = null, layoutSrc = null, heroSrc = null }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    // fitMode: "contain" → scale so the entire grid fits inside the
    // viewport (no horizontal scroll, all worlds visible at once).
    // Overrides `fullscreen` when set.
    this.fitMode = fitMode;
    // Allow callers to point at an alternate layout JSON / hero image —
    // e.g. /world uses a row-layout variant. When unset, the engine
    // falls back to the canonical defaults at the top of this file.
    this.layoutSrc = layoutSrc || LAYOUT_SRC;
    this.heroSrc = heroSrc || null; // resolved per-load: layout.image > heroSrc > HERO_SRC
    // Full roster — preserved across world toggles so setActiveWorlds()
    // can re-derive the visible subset without losing the original list.
    // Cap at 12 so the office doesn't get visually swamped by ingested
    // colleagues; sprite palettes cycle every 6 (see _hashPalette), so
    // duplicates beyond six are inevitable but the hover label
    // disambiguates.
    this.allAgents = agents.slice(0, 24);
    this.agents = this.allAgents.slice();
    this.onAgentClick = onAgentClick;
    this.fullscreen = fullscreen;
    this.activeWorldsOverride = Array.isArray(activeWorlds) ? activeWorlds.slice() : null;
    this.characters = [];
    this.scale = 1;
    this.hoveredAgentId = null;
    this.bubbles = new Map();
    this.clouds = [];
    this.rafId = null;
    this.lastTime = 0;

    canvas.addEventListener("click", (e) => this.handleClick(e));
    canvas.addEventListener("mousemove", (e) => this.handleMove(e));
    canvas.addEventListener("mouseleave", () => {
      this.hoveredAgentId = null;
      canvas.style.cursor = "default";
    });
  }

  async load() {
    const layoutResp = await fetch(this.layoutSrc);
    if (!layoutResp.ok) throw new Error(`Failed to load layout: ${this.layoutSrc}`);
    this.layout = await layoutResp.json();

    // Hero image preference: explicit constructor opt > layout.image > module default.
    const hero = this.heroSrc || this.layout.image || HERO_SRC;
    this.heroImg = await loadImage(hero);

    this.worldW = Number.isFinite(this.layout.imageWidth) ? this.layout.imageWidth : this.heroImg.naturalWidth;
    this.worldH = Number.isFinite(this.layout.imageHeight) ? this.layout.imageHeight : this.heroImg.naturalHeight;

    // Load all six character palettes upfront. The palette index is the
    // sprite identity (not the agents-array position) so toggling worlds
    // or re-ordering the roster doesn't shuffle anyone's appearance.
    // Each agent's palette is derived from a stable hash of agent.id —
    // see _hashPalette and the per-character `palette` assignment below.
    this.charSheets = [];
    for (let p = 0; p < 6; p++) {
      this.charSheets[p] = await loadImage(`/team-office/characters/char_${p}.png`);
    }

    this._applyWorlds();        // builds TILE_GRID + agent filter
    this.initCharacters();      // fresh spawn for the initial active set
    this.resize();
    window.addEventListener("resize", this.onResize);
  }

  // Live roster swap — category filters (and the agent-count slider) call
  // this so positions are preserved across toggles. Existing agents keep
  // their x/y/path/state via _reconcileCharacters; only newly-arriving
  // ones spawn fresh. Without this, ConsultView would have to destroy
  // and recreate the whole PixelOffice and every sprite would re-roll.
  setAgents(agents) {
    const next = Array.isArray(agents) ? agents.slice(0, 24) : [];
    const sameList =
      this.allAgents.length === next.length &&
      this.allAgents.every((a, i) => a.id === next[i].id);
    if (sameList) return;
    this.allAgents = next;
    if (!this.layout) return; // load() will call initCharacters once it finishes
    this._applyWorlds();
    this._reconcileCharacters();
    this.resize();
  }

  // Live world toggle — keeps existing characters in place and only
  // spawns the newly-arriving ones. Called when "Add world" appends a
  // world after the office is already running.
  setActiveWorlds(activeWorlds) {
    if (!this.layout) {
      // load() hasn't finished yet — just stash the override; load()
      // will pick it up when it builds the initial grid.
      this.activeWorldsOverride = Array.isArray(activeWorlds) ? activeWorlds.slice() : null;
      return;
    }
    const next = Array.isArray(activeWorlds) ? activeWorlds.slice() : null;
    if (sameStringArray(this.activeWorldsOverride, next)) return;
    this.activeWorldsOverride = next;

    this._applyWorlds();
    this._reconcileCharacters();
    this.resize();
  }

  // Build TILE_GRID for the current activeWorlds and re-derive the
  // active-agent list (filtered from allAgents, parallel agentWorldIdx).
  _applyWorlds() {
    const effectiveLayout = this.activeWorldsOverride
      ? { ...this.layout, activeWorlds: this.activeWorldsOverride }
      : this.layout;

    // Prefer the painted tile grid; fall back to legacy walkableZones
    // only if no usable tile data is present in the layout.
    TILE_GRID = buildTileGrid(effectiveLayout, this.worldW, this.worldH);
    WALKABLE_ZONES = TILE_GRID ? [] : (Array.isArray(this.layout.walkableZones) ? this.layout.walkableZones : []);

    if (TILE_GRID && Array.isArray(TILE_GRID.worlds) && TILE_GRID.worlds.length > 0) {
      const agentToWorldIdx = new Map();
      TILE_GRID.worlds.forEach((w, idx) => {
        if (Array.isArray(w.agents)) {
          for (const aid of w.agents) agentToWorldIdx.set(String(aid), idx);
        }
      });
      const activeSet = new Set(TILE_GRID.activeWorldIndices);
      this.agents = this.allAgents.filter((a) => {
        const wIdx = agentToWorldIdx.get(String(a.id));
        return wIdx !== undefined && activeSet.has(wIdx);
      });
      this.agentWorldIdx = this.agents.map((a) => agentToWorldIdx.get(String(a.id)));
    } else {
      this.agents = this.allAgents.slice();
      this.agentWorldIdx = this.agents.map(() => -1);
    }
  }

  // Stable palette per agent id — derived from a hash of the id, so
  // adding/removing/reordering agents (or toggling worlds) never
  // shuffles anyone's sprite. Six sprites means collisions are
  // possible past 6 agents; the hover label is the disambiguator.
  _paletteForId(id) {
    return _hashPalette(id);
  }

  _makeCharacter(agent, worldIdx) {
    const feet = this.pickSpawnPoint(worldIdx);
    return {
      agent,
      palette: this._paletteForId(agent.id),
      x: feet.x - CHAR_W / 2,
      y: feet.y - CHAR_H,
      path: [],
      pathStep: 0,
      lastCellIdx: -1,
      portalCooldown: 0,
      dir: ROW_DOWN,
      mirrored: false,
      state: "idle",
      idleTimer: randRange(IDLE_PAUSE_MIN, IDLE_PAUSE_MAX),
      frame: 0,
      frameTimer: 0,
      jumping: false,
      jumpTime: 0,
      jumpOffset: 0,
      jumpAlpha: 1,
      jumpStartX: 0,
      jumpStartY: 0,
      jumpLandX: 0,
      jumpLandY: 0,
    };
  }

  // After a world toggle: keep characters whose agent is still active
  // (preserves position, walk path, idle timer — no random respawn);
  // drop characters whose world turned off; spawn fresh ones for newly
  // active agents inside their assigned world.
  _reconcileCharacters() {
    const prevById = new Map();
    for (const c of this.characters) prevById.set(c.agent.id, c);
    const next = [];
    this.agents.forEach((agent, i) => {
      const existing = prevById.get(agent.id);
      if (existing) {
        existing.agent = agent; // pick up any updated metadata
        next.push(existing);
        return;
      }
      next.push(this._makeCharacter(agent, this.agentWorldIdx[i]));
    });
    this.characters = next;
  }

  onResize = () => this.resize();

  initCharacters() {
    this.characters = this.agents.map((agent, i) =>
      this._makeCharacter(agent, this.agentWorldIdx ? this.agentWorldIdx[i] : -1),
    );
  }

  pickSpawnPoint(worldIdx = -1) {
    if (TILE_GRID) {
      // Prefer the agent's assigned world's grass cells; fall back to the
      // global pool if that world has none (e.g., bottom map without
      // dedicated spawn cells, but it still inherits grass from the
      // left-half copy).
      if (worldIdx >= 0 && Array.isArray(TILE_GRID.worldSpawnCells)) {
        const pool = TILE_GRID.worldSpawnCells[worldIdx];
        if (pool && pool.length > 0) {
          return pointInCell(TILE_GRID, pool[Math.floor(Math.random() * pool.length)]);
        }
      }
      const p = pickSpawnPoint(TILE_GRID);
      if (p) return p;
    }
    if (WALKABLE_ZONES.length > 0) {
      return pointInZone(pickZone(), CHAR_W / 2, CHAR_H / 2);
    }
    return { x: this.worldW / 2, y: this.worldH / 2 };
  }

  pickWalkTarget() {
    if (TILE_GRID) {
      const p = pickWalkTarget(TILE_GRID);
      if (p) return p;
    }
    if (WALKABLE_ZONES.length > 0) {
      return pointInZone(pickZone(), CHAR_W / 2, CHAR_H / 2);
    }
    return { x: this.worldW / 2, y: this.worldH / 2 };
  }

  // Visible region of the world in pixels. Defaults to the full hero
  // image; if the tile grid carries an active-worlds viewport (1 world →
  // just that world's box, etc.) we crop to it so the canvas isn't
  // padded with dead cream space.
  getViewRect() {
    const vp = TILE_GRID && TILE_GRID.viewport;
    if (vp && vp.w > 0 && vp.h > 0) return vp;
    return { x: 0, y: 0, w: this.worldW, h: this.worldH };
  }

  resize() {
    const view = this.getViewRect();
    if (this.fitMode === "contain") {
      // Fit the whole grid inside the viewport — no scroll, all worlds
      // visible at once. Scale by whichever axis is the binding
      // constraint, then pin the canvas to the viewport.
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      this.scale = Math.min(vw / view.w, vh / view.h, 4);
      this.canvas.width = Math.round(view.w * this.scale);
      this.canvas.height = Math.round(view.h * this.scale);
      this.canvas.style.width = this.canvas.width + "px";
      this.canvas.style.height = this.canvas.height + "px";
      return;
    }
    if (this.fullscreen) {
      // Fill viewport height; width follows the visible aspect. User
      // pans the horizontal overflow to see whatever doesn't fit.
      const viewportH = window.innerHeight;
      this.scale = viewportH / view.h;
      // Cap scale so on huge displays the image doesn't become absurdly
      // wide (preserve pixel-art crispness rather than stretching past 4x).
      this.scale = Math.min(this.scale, 4);
      this.canvas.width = Math.round(view.w * this.scale);
      this.canvas.height = Math.round(view.h * this.scale);
      this.canvas.style.width = this.canvas.width + "px";
      this.canvas.style.height = this.canvas.height + "px";
      return;
    }

    // Match the map-editor: fill the container width and let height follow
    // the visible aspect. No height cap, no side gutter — the canvas
    // exactly covers the picker container.
    const container = this.canvas.parentElement;
    const maxW = container ? container.clientWidth : window.innerWidth;
    this.scale = Math.min(maxW / view.w, 4);
    this.canvas.width = Math.round(view.w * this.scale);
    this.canvas.height = Math.round(view.h * this.scale);
    this.canvas.style.width = this.canvas.width + "px";
    this.canvas.style.height = this.canvas.height + "px";
    this.canvas.style.maxWidth = "100%";
  }

  start() {
    this.lastTime = performance.now();
    const tick = (t) => {
      const dt = Math.min(0.1, (t - this.lastTime) / 1000);
      this.lastTime = t;
      this.update(dt);
      this.render();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  destroy() {
    this.stop();
    window.removeEventListener("resize", this.onResize);
  }

  pickNewTarget(c) {
    const fromFeetX = c.x + CHAR_W / 2;
    const fromFeetY = c.y + CHAR_H;
    // While the portal cooldown is active, BFS does NOT bridge portal
    // pairs — the agent can only path within their current 4-connected
    // island. Cross-island targets fail, the retry loop picks again,
    // they end up wandering locally until the cooldown expires.
    const bridgePortals = c.portalCooldown <= 0;

    let path = null;
    let attempts = 0;
    while (!path && attempts < 6) {
      attempts++;
      const feet = this.pickWalkTarget();
      if (!feet) break;
      if (TILE_GRID) {
        path = pathfindFeet(TILE_GRID, fromFeetX, fromFeetY, feet.x, feet.y, bridgePortals);
      } else {
        path = [{ x: feet.x, y: feet.y }];
      }
    }

    if (!path) {
      // Target unreachable after retries — idle and try again next tick.
      c.state = "idle";
      c.idleTimer = randRange(IDLE_PAUSE_MIN, IDLE_PAUSE_MAX);
      return;
    }

    c.path = path;
    c.pathStep = 0;
    c.state = "walk";
    c.frame = 0;
    c.frameTimer = 0;
  }

  update(dt) {
    for (const c of this.characters) {
      // Jump animation: visible parabolic arc from start to landing
      if (c.jumping) {
        c.jumpTime += dt;
        const t = Math.min(c.jumpTime / JUMP_ARC_DUR, 1);

        // Fast walk frame during flight
        c.frameTimer += dt;
        if (c.frameTimer > WALK_FRAME_SEC * 0.5) {
          c.frameTimer = 0;
          c.frame = (c.frame + 1) % 4;
        }

        // Lerp x and y from start to landing
        c.x = c.jumpStartX + (c.jumpLandX - c.jumpStartX) * t;
        c.y = c.jumpStartY + (c.jumpLandY - c.jumpStartY) * t;
        // Parabolic arc height: sin peaks at midpoint
        c.jumpOffset = JUMP_ARC_HEIGHT * Math.sin(Math.PI * t);
        c.jumpAlpha = 1; // always visible

        // Face the direction of travel
        if (c.jumpLandX > c.jumpStartX) {
          c.dir = ROW_RIGHT;
          c.mirrored = false;
        } else {
          c.dir = ROW_RIGHT;
          c.mirrored = true;
        }

        // Trail clouds mid-flight (every ~0.15s)
        c._trailTimer = (c._trailTimer || 0) + dt;
        if (c._trailTimer > 0.12 && t > 0.05 && t < 0.95) {
          c._trailTimer = 0;
          const cx = c.x + CHAR_W / 2;
          const cy = c.y + CHAR_H - c.jumpOffset;
          this.clouds.push({
            x: cx + (Math.random() - 0.5) * 16,
            y: cy + Math.random() * 8,
            vx: (Math.random() - 0.5) * 12,
            vy: 5 + Math.random() * 10,
            radius: 8 + Math.random() * 10,
            age: 0,
            lifetime: 0.5 + Math.random() * 0.3,
          });
        }

        if (t >= 1) {
          c.jumping = false;
          c.jumpOffset = 0;
          c.jumpAlpha = 1;
          c.jumpTime = 0;
          c.dir = ROW_DOWN;
          c.mirrored = false;
          // Landing cloud burst
          this._spawnClouds(c.x + CHAR_W / 2, c.y + CHAR_H);
          this.showBubble(c.agent.id, "I'm here!", 2500);
        }
        continue;
      }

      c.frameTimer += dt;
      if (c.frameTimer > WALK_FRAME_SEC) {
        c.frameTimer = 0;
        c.frame = (c.frame + 1) % 4;
      }

      if (c.state === "idle") {
        if (c.gathered) {
          c.gatherTime = (c.gatherTime || 0) + dt;

          // Face toward the center of the gathered group
          const gathered = this.characters.filter((o) => o.gathered && o !== c);
          if (gathered.length > 0) {
            let avgX = 0;
            for (const o of gathered) avgX += o.x + CHAR_W / 2;
            avgX /= gathered.length;
            const myCx = c.x + CHAR_W / 2;
            if (Math.abs(avgX - myCx) > 4) {
              c.dir = ROW_RIGHT;
              c.mirrored = avgX < myCx;
            }
          }

          // Gentle bob in place (like Animal Crossing idle)
          c._bobOffset = Math.sin(c.gatherTime * 2.5) * 5;

          // Idle frame — stay on frame 0 (standing still)
          c.frame = 0;

          continue;
        }
        c.idleTimer -= dt;
        if (c.idleTimer <= 0) this.pickNewTarget(c);
        continue;
      }

      // Walk along the BFS path waypoint by waypoint. Path entries are
      // feet positions; when feet reach the current waypoint, advance.
      const wp = c.path[c.pathStep];
      if (!wp) {
        c.state = "idle";
        c.idleTimer = randRange(IDLE_PAUSE_MIN, IDLE_PAUSE_MAX);
        continue;
      }
      const feetX = c.x + CHAR_W / 2;
      const feetY = c.y + CHAR_H;
      const dx = wp.x - feetX;
      const dy = wp.y - feetY;
      const d = Math.hypot(dx, dy);
      if (d < TARGET_RADIUS_PX) {
        c.pathStep += 1;
        continue;
      }
      const step = WALK_SPEED_PX_PER_SEC * dt;
      const nx = dx / d;
      const ny = dy / d;
      c.x += nx * step;
      c.y += ny * step;

      if (Math.abs(nx) > Math.abs(ny)) {
        c.dir = ROW_RIGHT;
        c.mirrored = nx < 0;
      } else {
        c.dir = ny < 0 ? ROW_UP : ROW_DOWN;
        c.mirrored = false;
      }

      // Portal teleport: only fires while no cooldown is active. We track
      // the previous cell so that landing on a partner portal cell on the
      // far side of the jump doesn't immediately re-teleport.
      if (c.portalCooldown > 0) c.portalCooldown -= dt;
      if (TILE_GRID && TILE_GRID.portalPartnerOf && c.portalCooldown <= 0) {
        const fx = c.x + CHAR_W / 2;
        const fy = c.y + CHAR_H;
        const cc = clampCol(TILE_GRID, fx);
        const cr = clampRow(TILE_GRID, fy);
        const cellIdx = cr * TILE_GRID.cols + cc;
        if (cellIdx !== c.lastCellIdx) {
          if (TILE_GRID.data[cellIdx] === TILE_PORTAL) {
            const partner = TILE_GRID.portalPartnerOf.get(cellIdx);
            if (partner && partner.length > 0) {
              // Land on the BOTTOM-most row of the partner cluster — the
              // door graphic typically sits at the top of the cells, so
              // arriving lower means the agent appears in front of it
              // rather than embedded in it.
              let maxRow = -1;
              for (const idx of partner) {
                const r = Math.floor(idx / TILE_GRID.cols);
                if (r > maxRow) maxRow = r;
              }
              const bottom = partner.filter(
                (idx) => Math.floor(idx / TILE_GRID.cols) === maxRow,
              );
              const dst = bottom[Math.floor(Math.random() * bottom.length)];
              const dCol = dst % TILE_GRID.cols;
              const dRow = (dst - dCol) / TILE_GRID.cols;
              c.x = (dCol + 0.5) * TILE_GRID.cellW - CHAR_W / 2;
              c.y = (dRow + 0.5) * TILE_GRID.cellH - CHAR_H;
              c.lastCellIdx = dst;
              c.portalCooldown = 30; // long cooldown — no quick re-teleport

              // Build a walk-south exit path so the agent strides away
              // from the door instead of drifting sideways across it.
              // Stop early if a wall is in the way.
              const exitPath = [];
              for (let off = 1; off <= 5; off++) {
                const outRow = dRow + off;
                if (outRow >= TILE_GRID.rows) break;
                const outIdx = outRow * TILE_GRID.cols + dCol;
                if (!isPassableTile(TILE_GRID.data[outIdx])) break;
                exitPath.push({
                  x: (dCol + 0.5) * TILE_GRID.cellW,
                  y: (outRow + 0.5) * TILE_GRID.cellH,
                });
              }

              if (exitPath.length > 0) {
                c.path = exitPath;
                c.pathStep = 0;
                c.state = "walk";
                c.dir = ROW_DOWN;
                c.mirrored = false;
              } else {
                c.path = [];
                c.pathStep = 0;
                c.state = "idle";
                c.idleTimer = 0.6;
              }
              continue;
            }
          }
          c.lastCellIdx = cellIdx;
        }
      } else if (TILE_GRID) {
        // Cooldown is active — still update lastCellIdx so the moment
        // cooldown ends, an agent already standing on a portal cell
        // doesn't immediately re-trigger off it.
        const fx = c.x + CHAR_W / 2;
        const fy = c.y + CHAR_H;
        const cc = clampCol(TILE_GRID, fx);
        const cr = clampRow(TILE_GRID, fy);
        c.lastCellIdx = cr * TILE_GRID.cols + cc;
      }
    }

    // Age out any bubbles
    const now = performance.now();
    for (const [id, b] of this.bubbles) {
      if (b.expiresAt < now) this.bubbles.delete(id);
    }

    // Update cloud particles
    for (let i = this.clouds.length - 1; i >= 0; i--) {
      const p = this.clouds[i];
      p.age += dt;
      if (p.age >= p.lifetime) {
        this.clouds.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      // Clouds drift upward and slow down
      p.vy -= 8 * dt;
      p.vx *= 0.97;
    }
  }

  render() {
    const ctx = this.ctx;
    const s = this.scale;
    const view = this.getViewRect();
    ctx.save();
    // Scale into world units, then translate so the active viewport
    // origin sits at canvas (0,0). World-coord drawing below works
    // unchanged — only the visible window has shifted.
    ctx.setTransform(s, 0, 0, s, -view.x * s, -view.y * s);
    ctx.clearRect(view.x, view.y, view.w, view.h);

    // Hero backdrop
    ctx.drawImage(this.heroImg, 0, 0, this.worldW, this.worldH);

    // Mask out worlds that aren't currently active. The combined image
    // bakes all worlds into a single bitmap, so without this overlay
    // unloaded worlds would still be visible. Cream matches the bottom
    // padding (#f5ead4 — same as .editorial-card) so the masked area
    // looks like uncut paper.
    if (TILE_GRID && Array.isArray(TILE_GRID.worlds) && TILE_GRID.worlds.length > 0) {
      const activeSet = new Set(TILE_GRID.activeWorldIndices);
      ctx.fillStyle = "#f5ead4";
      TILE_GRID.worlds.forEach((w, idx) => {
        if (activeSet.has(idx)) return;
        const b = w.tileBox || {};
        const x = (Number(b.col) || 0) * TILE_GRID.cellW;
        const y = (Number(b.row) || 0) * TILE_GRID.cellH;
        const w2 = (Number(b.cols) || 0) * TILE_GRID.cellW;
        const h2 = (Number(b.rows) || 0) * TILE_GRID.cellH;
        ctx.fillRect(x, y, w2, h2);
      });
    }

    // Sort characters by Y so closer ones draw over farther ones
    const ordered = [...this.characters].sort((a, b) => a.y - b.y);
    for (const c of ordered) {
      const sheet = this.charSheets[c.palette];
      if (!sheet) continue;
      const srcX = c.frame * SRC_W;
      const srcY = c.dir * SRC_H;
      // Apply jump offset (negative = upward)
      const drawY = c.y - c.jumpOffset - (c._bobOffset || 0);

      // Drop shadow during jump (stays on ground, shrinks as char rises)
      if (c.jumpOffset > 0) {
        const shadowAlpha = 0.25 * Math.max(0, 1 - c.jumpOffset / JUMP_ARC_HEIGHT);
        const shadowScale = Math.max(0.1, 1 - 0.6 * (c.jumpOffset / JUMP_ARC_HEIGHT));
        ctx.save();
        ctx.fillStyle = `rgba(0,0,0,${shadowAlpha})`;
        ctx.beginPath();
        ctx.ellipse(
          c.x + CHAR_W / 2,
          c.y + CHAR_H - 2,
          (CHAR_W / 2) * shadowScale,
          6 * shadowScale,
          0, 0, Math.PI * 2,
        );
        ctx.fill();
        ctx.restore();
      }

      // Garfield orange & oak brown aura pillar — 3× height
      if (c.gathered) {
        const gt = c.gatherTime || 0;
        const pulse = 0.6 + 0.4 * Math.sin(gt * 2.5);
        const auraCx = c.x + CHAR_W / 2;
        const auraTop = drawY - CHAR_H * 2.5;  // 3× taller — extends far above
        const auraBot = drawY + CHAR_H * 1.2;
        const auraW = CHAR_W * 2.2;
        const auraH = auraBot - auraTop;

        // Warm hue cycle: orange (25) → amber (35) → brown (15) → gold (45)
        const phase = (gt * 40) % 360;
        const hue1 = 25 + 15 * Math.sin(phase * Math.PI / 180);       // orange
        const hue2 = 35 + 10 * Math.sin((phase + 90) * Math.PI / 180); // amber
        const hue3 = 15 + 10 * Math.sin((phase + 180) * Math.PI / 180); // brown
        ctx.save();

        // Outer warm glow — wide ellipse
        const outerGrad = ctx.createRadialGradient(auraCx, drawY, 0, auraCx, drawY, auraW * 1.3);
        outerGrad.addColorStop(0, `hsla(${hue1}, 85%, 65%, ${pulse * 0.4})`);
        outerGrad.addColorStop(0.35, `hsla(${hue2}, 75%, 55%, ${pulse * 0.25})`);
        outerGrad.addColorStop(0.7, `hsla(${hue3}, 65%, 45%, ${pulse * 0.1})`);
        outerGrad.addColorStop(1, `hsla(20, 60%, 40%, 0)`);
        ctx.fillStyle = outerGrad;
        ctx.beginPath();
        ctx.ellipse(auraCx, drawY, auraW * 1.3, auraH * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();

        // Tall inner pillar — vertical warm gradient (3× height)
        const pillarGrad = ctx.createLinearGradient(auraCx, auraTop, auraCx, auraBot);
        pillarGrad.addColorStop(0, `hsla(40, 90%, 75%, 0)`);
        pillarGrad.addColorStop(0.08, `hsla(40, 90%, 75%, ${pulse * 0.25})`);
        pillarGrad.addColorStop(0.2, `hsla(${hue1}, 90%, 68%, ${pulse * 0.45})`);
        pillarGrad.addColorStop(0.4, `hsla(${hue2}, 85%, 62%, ${pulse * 0.6})`);
        pillarGrad.addColorStop(0.6, `hsla(30, 80%, 55%, ${pulse * 0.55})`);
        pillarGrad.addColorStop(0.8, `hsla(${hue3}, 70%, 48%, ${pulse * 0.35})`);
        pillarGrad.addColorStop(1, `hsla(15, 60%, 40%, 0)`);
        ctx.fillStyle = pillarGrad;
        ctx.beginPath();
        ctx.roundRect(auraCx - CHAR_W * 0.8, auraTop, CHAR_W * 1.6, auraH, CHAR_W * 0.4);
        ctx.fill();

        // Second inner layer — brighter core
        const coreGrad = ctx.createLinearGradient(auraCx, auraTop + auraH * 0.15, auraCx, auraBot);
        coreGrad.addColorStop(0, `hsla(45, 95%, 80%, 0)`);
        coreGrad.addColorStop(0.3, `hsla(35, 95%, 75%, ${pulse * 0.35})`);
        coreGrad.addColorStop(0.5, `hsla(25, 90%, 70%, ${pulse * 0.4})`);
        coreGrad.addColorStop(0.8, `hsla(20, 85%, 60%, ${pulse * 0.2})`);
        coreGrad.addColorStop(1, `hsla(15, 80%, 50%, 0)`);
        ctx.fillStyle = coreGrad;
        ctx.beginPath();
        ctx.roundRect(auraCx - CHAR_W * 0.4, auraTop + auraH * 0.1, CHAR_W * 0.8, auraH * 0.85, CHAR_W * 0.2);
        ctx.fill();

        // Bright warm ring at feet
        const ringGrad = ctx.createRadialGradient(auraCx, auraBot - 6, 0, auraCx, auraBot - 6, CHAR_W * 1.5);
        ringGrad.addColorStop(0, `hsla(30, 100%, 75%, ${pulse * 0.7})`);
        ringGrad.addColorStop(0.4, `hsla(25, 90%, 65%, ${pulse * 0.35})`);
        ringGrad.addColorStop(1, `hsla(20, 80%, 50%, 0)`);
        ctx.fillStyle = ringGrad;
        ctx.beginPath();
        ctx.ellipse(auraCx, auraBot - 6, CHAR_W * 1.5, CHAR_H * 0.25, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
      }

      // Apply alpha for fade in/out during jump
      const useAlpha = c.jumping && c.jumpAlpha < 1;
      if (useAlpha) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, c.jumpAlpha);
      }

      if (c.mirrored) {
        ctx.save();
        ctx.translate(c.x + CHAR_W, drawY);
        ctx.scale(-1, 1);
        ctx.drawImage(sheet, srcX, srcY, SRC_W, SRC_H, 0, 0, CHAR_W, CHAR_H);
        ctx.restore();
      } else {
        ctx.drawImage(sheet, srcX, srcY, SRC_W, SRC_H, c.x, drawY, CHAR_W, CHAR_H);
      }

      // Name label above the character's head
      const cx = c.x + CHAR_W / 2;
      const labelY = drawY - 20;
      ctx.font = "bold 48px system-ui, sans-serif";
      ctx.textAlign = "center";
      const label = c.agent.shortName || c.agent.name.split(" ")[0];
      const pad = 16;
      const metrics = ctx.measureText(label);
      const lw = metrics.width + pad * 2;
      const lh = 60;
      ctx.fillStyle = c.agent.id === this.hoveredAgentId
        ? "rgba(99,102,241,0.95)"
        : "rgba(15,17,23,0.85)";
      ctx.beginPath();
      ctx.roundRect(cx - lw / 2, labelY - lh, lw, lh, 14);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, cx, labelY - 14);

      // Speech bubble
      const bubble = this.bubbles.get(c.agent.id);
      if (bubble) {
        ctx.font = "bold 42px system-ui, sans-serif";
        const text = bubble.text.slice(0, 80);
        // Word-wrap into lines of max ~500px width
        const maxLineW = 600;
        const words = text.split(" ");
        const lines = [];
        let currentLine = "";
        for (const word of words) {
          const test = currentLine ? currentLine + " " + word : word;
          if (ctx.measureText(test).width > maxLineW && currentLine) {
            lines.push(currentLine);
            currentLine = word;
          } else {
            currentLine = test;
          }
        }
        if (currentLine) lines.push(currentLine);

        const lineH = 50;
        const padX = 24;
        const padY = 16;
        let widest = 0;
        for (const l of lines) {
          const w = ctx.measureText(l).width;
          if (w > widest) widest = w;
        }
        const bw = widest + padX * 2;
        const bh = lines.length * lineH + padY * 2;
        const by = labelY - lh - 14 - bh;

        // Bubble background with pointer triangle
        ctx.fillStyle = "rgba(255,255,255,0.96)";
        ctx.beginPath();
        ctx.roundRect(cx - bw / 2, by, bw, bh, 16);
        ctx.fill();
        // Small triangle pointer
        ctx.beginPath();
        ctx.moveTo(cx - 10, by + bh);
        ctx.lineTo(cx + 10, by + bh);
        ctx.lineTo(cx, by + bh + 12);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = "#111";
        for (let li = 0; li < lines.length; li++) {
          ctx.fillText(lines[li], cx, by + padY + lineH * (li + 0.75));
        }
      }

      if (useAlpha) ctx.restore();
    }

    // Draw cloud puffs
    for (const p of this.clouds) {
      const t = p.age / p.lifetime;
      const alpha = t < 0.3 ? t / 0.3 : 1 - (t - 0.3) / 0.7;
      const r = p.radius * (0.6 + 0.8 * t);
      ctx.save();
      ctx.globalAlpha = alpha * 0.75;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, r, r * 0.65, 0, 0, Math.PI * 2);
      ctx.fill();
      // Inner bright core
      ctx.globalAlpha = alpha * 0.4;
      ctx.fillStyle = "#f0f4ff";
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, r * 0.5, r * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore(); // end world transform

    // Animal Crossing dialogue — rendered in SCREEN PIXELS so it's always readable
    if (this._dialogue) {
      const d = this._dialogue;
      const canvasW = this.canvas.width;
      const canvasH = this.canvas.height;
      const boxW = canvasW * 0.92;
      const boxH = Math.max(160, canvasH * 0.25);
      const boxX = (canvasW - boxW) / 2;
      const boxY = canvasH - boxH - 12;
      const boxR = 18;

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0); // reset to screen pixels

      // Background
      ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
      ctx.strokeStyle = "rgba(0, 0, 0, 0.18)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(boxX, boxY, boxW, boxH, boxR);
      ctx.fill();
      ctx.stroke();

      // Speaker name badge
      ctx.font = "bold 18px system-ui, sans-serif";
      ctx.textAlign = "left";
      const nameW = ctx.measureText(d.speaker).width + 24;
      ctx.fillStyle = d.color || "#000";
      ctx.beginPath();
      ctx.roundRect(boxX + 16, boxY - 14, nameW, 28, 8);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillText(d.speaker, boxX + 28, boxY + 5);

      // Dialogue text — word wrap
      ctx.font = "16px system-ui, sans-serif";
      ctx.fillStyle = "#111";
      const maxTextW = boxW - 48;
      const words = d.text.split(" ");
      const lines = [];
      let line = "";
      for (const w of words) {
        const test = line ? line + " " + w : w;
        if (ctx.measureText(test).width > maxTextW && line) {
          lines.push(line);
          line = w;
        } else {
          line = test;
        }
      }
      if (line) lines.push(line);

      const lineH = 22;
      const maxLines = Math.floor((boxH - 50) / lineH);
      const textY = boxY + 34;
      for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
        ctx.fillText(lines[i], boxX + 24, textY + i * lineH);
      }
      if (lines.length > maxLines) {
        ctx.fillText("…", boxX + 24, textY + maxLines * lineH);
      }

      // Blinking ▼
      const triX = boxX + boxW / 2;
      const triY = boxY + boxH - 14;
      if (Math.sin(performance.now() / 300) > 0) {
        ctx.fillStyle = d.color || "#999";
        ctx.beginPath();
        ctx.moveTo(triX - 8, triY);
        ctx.lineTo(triX + 8, triY);
        ctx.lineTo(triX, triY + 10);
        ctx.closePath();
        ctx.fill();
      }

      // Store hit area in SCREEN coords for click detection
      this._dialogueBox = { x: boxX, y: boxY, w: boxW, h: boxH, screenSpace: true };

      ctx.restore();
    } else {
      this._dialogueBox = null;
    }
  }

  triggerJump(agentId) {
    // Pick a specific agent or random one
    let target;
    if (agentId) {
      target = this.characters.find((c) => c.agent.id === agentId);
    }
    if (!target) {
      target = this.characters[Math.floor(Math.random() * this.characters.length)];
    }
    if (!target || target.jumping) return;

    // Compute landing on opposite side of map
    const midX = this.worldW / 2;
    const onLeft = (target.x + CHAR_W / 2) < midX;
    const landing = this._pickLandingOnSide(onLeft ? "right" : "left");
    if (!landing) return;

    // Store start and landing as sprite top-left coords
    target.jumpStartX = target.x;
    target.jumpStartY = target.y;
    target.jumpLandX = landing.x - CHAR_W / 2;
    target.jumpLandY = landing.y - CHAR_H;
    target._trailTimer = 0;

    target.jumping = true;
    target.jumpTime = 0;
    target.jumpOffset = 0;
    target.jumpAlpha = 1;
    target.state = "idle";
    target.path = [];

    // Takeoff cloud burst
    this._spawnClouds(target.x + CHAR_W / 2, target.y + CHAR_H);
    this.showBubble(target.agent.id, "Jumping worlds!", 1500);
  }

  _spawnClouds(cx, cy) {
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const angle = (Math.PI * 2 * i) / CLOUD_COUNT + (Math.random() - 0.5) * 0.5;
      const speed = 25 + Math.random() * 35;
      this.clouds.push({
        x: cx + (Math.random() - 0.5) * 20,
        y: cy + (Math.random() - 0.5) * 10,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 15,
        radius: 12 + Math.random() * 14,
        age: 0,
        lifetime: CLOUD_LIFETIME + Math.random() * 0.3,
      });
    }
  }

  _pickLandingOnSide(side) {
    if (!TILE_GRID) return null;
    const midCol = Math.floor(TILE_GRID.cols / 2);
    const candidates = TILE_GRID.walkCells.filter((idx) => {
      const col = idx % TILE_GRID.cols;
      return side === "left" ? col < midCol : col >= midCol;
    });
    if (candidates.length === 0) return null;
    const idx = candidates[Math.floor(Math.random() * candidates.length)];
    return pointInCell(TILE_GRID, idx);
  }

  getCharAt(worldX, worldY) {
    // Click is a 16×32 hitbox centred on character feet
    for (const c of this.characters) {
      if (
        worldX >= c.x &&
        worldX <= c.x + CHAR_W &&
        worldY >= c.y &&
        worldY <= c.y + CHAR_H
      ) {
        return c;
      }
    }
    return null;
  }

  handleClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const view = this.getViewRect();
    const worldX = (e.clientX - rect.left) / this.scale + view.x;
    const worldY = (e.clientY - rect.top) / this.scale + view.y;

    // If dialogue box is showing, clicking on it fires the callback
    if (this._dialogue && this._dialogueBox) {
      const db = this._dialogueBox;
      // Dialogue is in screen pixels, use raw click coords
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (sx >= db.x && sx <= db.x + db.w &&
          sy >= db.y && sy <= db.y + db.h) {
        if (this._onDialogueClick) {
          this._onDialogueClick();
        }
        return;
      }
    }

    const hit = this.getCharAt(worldX, worldY);
    if (hit && this.onAgentClick) this.onAgentClick(hit.agent);
  }

  handleMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const view = this.getViewRect();
    const worldX = (e.clientX - rect.left) / this.scale + view.x;
    const worldY = (e.clientY - rect.top) / this.scale + view.y;
    const hit = this.getCharAt(worldX, worldY);
    this.hoveredAgentId = hit ? hit.agent.id : null;
    this.canvas.style.cursor = hit ? "pointer" : "default";
  }

  // Gather chosen agents — teleport them shoulder-to-shoulder around
  // the first agent's current walkable position, all facing inward.
  gatherAgents(agentIds) {
    if (!agentIds || agentIds.length === 0) return;

    const idSet = new Set(agentIds);
    const chosen = this.characters.filter((c) => idSet.has(c.agent.id));
    if (chosen.length === 0) return;

    // Anchor = first chosen character's feet position (already walkable)
    const anchorFeetX = chosen[0].x + CHAR_W / 2;
    const anchorFeetY = chosen[0].y + CHAR_H;

    // Place agents in a horizontal line, very close together
    const gap = CHAR_W * 0.55; // tight shoulder-to-shoulder
    const n = chosen.length;
    const totalW = (n - 1) * gap;
    const leftX = anchorFeetX - totalW / 2;

    chosen.forEach((c, i) => {
      const feetX = leftX + i * gap;
      c.x = feetX - CHAR_W / 2;
      c.y = anchorFeetY - CHAR_H;

      c.gathered = true;
      c.gatherTime = i * 0.4; // stagger bob phase
      c._bobOffset = 0;
      c.path = [];
      c.pathStep = 0;
      c.state = "idle";
      c.frame = 0;
      c.frameTimer = 0;
    });

    // Now set facing: everyone faces toward the group center
    const groupCenterX = leftX + totalW / 2;
    for (const c of chosen) {
      const myCx = c.x + CHAR_W / 2;
      const dx = groupCenterX - myCx;
      if (n === 1) {
        // Single agent — face down
        c.dir = ROW_DOWN;
        c.mirrored = false;
      } else if (Math.abs(dx) < 2) {
        // Dead center agent — face down
        c.dir = ROW_DOWN;
        c.mirrored = false;
      } else {
        // Face toward center
        c.dir = ROW_RIGHT;
        c.mirrored = dx < 0; // mirror if center is to the left
      }
    }

    // Spawn clouds at the huddle
    this._spawnClouds(groupCenterX, anchorFeetY);

    // Play gather music while agents are huddled — short 3-4s intro then fade
    this._gatherMusicStopped = false;
    if (!this._gatherAudio) {
      this._gatherAudio = new Audio("/sounds/gather.mp3");
      this._gatherAudio.loop = false;
      this._gatherAudio.volume = 0.25;
    }
    this._gatherAudio.currentTime = 0;
    this._gatherAudio.play().catch(() => {});
    // Fade out after 3s so it's a brief intro, not a loop
    clearTimeout(this._gatherFadeTimer);
    this._gatherFadeTimer = setTimeout(() => {
      if (!this._gatherMusicStopped) this._fadeOutGatherMusic();
    }, 3000);

    // Reset chatter queue for this gather session
    this._chatterQueue = [];
    this._chatterPlaying = false;
  }

  // Release all gathered agents back to free wandering.
  releaseAgents() {
    for (const c of this.characters) {
      if (c.gathered) {
        c.gathered = false;
        c.gatherTime = 0;
        c._bobOffset = 0;
        c.state = "idle";
        c.dir = ROW_DOWN;
        c.mirrored = false;
        c.idleTimer = randRange(IDLE_PAUSE_MIN, IDLE_PAUSE_MAX);
        this.bubbles.delete(c.agent.id);
      }
    }
    this._fadeOutGatherMusic();
  }

  _fadeOutGatherMusic() {
    clearTimeout(this._gatherFadeTimer);
    this._gatherMusicStopped = true;
    if (this._gatherAudio && !this._gatherAudio.paused) {
      const audio = this._gatherAudio;
      const fade = () => {
        if (audio.volume > 0.05) {
          audio.volume = Math.max(0, audio.volume - 0.03);
          setTimeout(fade, 50);
        } else {
          audio.pause();
          audio.volume = 0.3;
        }
      };
      fade();
    }
  }

  _playChatter() {
    // Queue chatter so voices play turn-by-turn, not over each other.
    const voices = ["/sounds/talking-1.mp3", "/sounds/talking-2.mp3", "/sounds/talking-3.mp3"];
    const src = voices[Math.floor(Math.random() * voices.length)];
    if (!this._chatterQueue) this._chatterQueue = [];
    this._chatterQueue.push(src);
    this._drainChatterQueue();
  }

  _drainChatterQueue() {
    if (this._chatterPlaying || !this._chatterQueue || this._chatterQueue.length === 0) return;
    this._chatterPlaying = true;
    const src = this._chatterQueue.shift();
    const a = new Audio(src);
    a.volume = 0.7 + Math.random() * 0.2;
    a.currentTime = Math.random() * 0.3;
    a.play().catch(() => {});
    // Let it play for 3.5s then fade out, then play next in queue
    const playDuration = 3500;
    setTimeout(() => {
      if (!a.paused) {
        const fade = () => {
          if (a.volume > 0.03) {
            a.volume = Math.max(0, a.volume - 0.04);
            setTimeout(fade, 40);
          } else {
            a.pause();
            this._chatterPlaying = false;
            this._drainChatterQueue();
          }
        };
        fade();
      } else {
        this._chatterPlaying = false;
        this._drainChatterQueue();
      }
    }, playDuration);
  }

  showBubble(agentId, text, durationMs = 5000) {
    this.bubbles.set(agentId, { text, expiresAt: performance.now() + durationMs });
    // Play chatter sound if this agent is gathered (real consult answer)
    const char = this.characters.find((c) => c.agent.id === agentId);
    if (char && char.gathered) {
      this._playChatter();
    }
  }

  // Animal Crossing-style dialogue box at the bottom of the canvas.
  // Stays until clearDialogue() or next showDialogue() call.
  showDialogue(speakerName, text, color = "#000", onClick = null) {
    this._dialogue = { speaker: speakerName, text, color };
    this._onDialogueClick = onClick;
    this._playChatter();
  }

  clearDialogue() {
    this._dialogue = null;
    this._onDialogueClick = null;
    this._dialogueBox = null;
  }
}
