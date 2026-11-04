// Phaser 3 scene — Pixel Societies-style immersive world.
//
// World dims = map asset native size (1536x1024). Tile grid is logical
// (32x24, used only to place agents); we never draw it. Sprites render
// at NATIVE 16x32 — they look small on the wide map. The camera starts
// at the "overview" zoom that fits the whole map in the viewport, then
// wheel zooms and drag pans (mobile pinch is wired too). Click an agent
// to dispatch `phaser:agent-tap` for the React side to handle.
//
// This mirrors the architecture in apps/pixel-client/src/scenes/GameScene.ts
// from Pixel Societies (~2000 LOC), pared down to the essentials we need
// for v0: tap, idle wander, sprite swap on prop change.

// Webpack on Next.js 16 doesn't accept `import Phaser from "phaser"` —
// the package exposes a namespace, not a default export. Use the
// namespace form so both module systems are happy.
import * as Phaser from "phaser";
import { BadgeRenderer, type BadgeData } from "./BadgeRenderer";
import { SpriteAnimator, type PersonalityParams } from "./SpriteAnimator";

export type WorldAgent = {
  id: string;
  display_name: string;
  canonical_id: string | null;
  sprite_url: string | null;
  /** Single-image pixel portrait from the two-step Gemini pipeline.
   *  When present, takes precedence over sprite_url and renders as a
   *  static 3:4 character (no spritesheet slicing, no walk animation). */
  portrait_url: string | null;
  /** Full spritesheet URL (7×4, 128×256 per frame). */
  sprite_sheet_url: string | null;
  tile_x: number;
  tile_y: number;
  /** Bundled placeholder sprite path (used until any generated url lands). */
  placeholder_sprite_url: string;
  /** Animation personality params (from backend personality_anim). */
  personality?: Partial<PersonalityParams>;
  /** Community signal data for badge overlays. */
  badge?: Partial<BadgeData>;
};

export type WorldMode = "own" | "visit";

// Logical placement grid — converted to absolute world pixels using
// TILE_W / TILE_H. Keeping the 32×24 grid means tile_x / tile_y stored
// in DB stay valid as the map asset evolves; only TILE_W / TILE_H change.
export const GRID_W = 32;
export const GRID_H = 24;

// Native size of the office map asset.
const WORLD_W_PX = 1536;
const WORLD_H_PX = 1024;

// One tile in absolute world pixels.
const TILE_W = WORLD_W_PX / GRID_W; // 48
const TILE_H = WORLD_H_PX / GRID_H; // ~42.67

// Sprite sheet metadata for the bundled char_N.png (7 cols × 3 rows of
// 16×32 frames). Phaser slices via load.spritesheet.
const SPRITE_FRAME_W = 16;
const SPRITE_FRAME_H = 32;
const GENERATED_SHEET_FRAME_W = 128;
const GENERATED_SHEET_FRAME_H = 256;

const MAP_TEXTURE_KEY = "world-map";
const MAP_URL = "/onboarding/map-bg.png";

// Idle wander timing.
const WANDER_MIN_MS = 6_000;
const WANDER_MAX_MS = 12_000;
const WALK_DURATION_MS = 600;

// Bubble system — first-sentence speech bubble above an agent's sprite
// when chat.agent_done fires. Max 12 simultaneous bubbles; auto-fade
// after BUBBLE_LIFETIME_MS so the map stays clean.
const BUBBLE_LIFETIME_MS = 5_000;
const BUBBLE_FADE_MS = 600;
const BUBBLE_MAX_ON_SCREEN = 12;
const BUBBLE_MAX_CHARS = 100;

// Camera zoom limits.
//   - MIN_ZOOM is dynamic = the overview zoom (cover the viewport).
//     This guarantees the user can never zoom out far enough to see the
//     blue background — the world always fills the screen on at least
//     one axis.
//   - MAX_ZOOM 3.5 lets you get right up to a single agent.
const MAX_ZOOM = 3.5;
// Zoom level to use when focusing on a tapped agent.
const FOCUS_ZOOM = 2.4;
const FOCUS_PAN_MS = 500;

// Re-export legacy constant for any caller that imports it.
export const TILE_SIZE = TILE_W;

// Walk-animation frame sequences.
// Placeholder sheets (7 cols × 3 rows, 16×32):
//   Row 0 = walk-down, Row 1 = walk-left, Row 2 = walk-right.
const PH_COLS = 7;
const PH_WALK_DOWN = [0, 1, 2, 3];
const PH_WALK_LEFT = [PH_COLS + 0, PH_COLS + 1, PH_COLS + 2, PH_COLS + 3];
const PH_WALK_RIGHT = [PH_COLS * 2 + 0, PH_COLS * 2 + 1, PH_COLS * 2 + 2, PH_COLS * 2 + 3];
const PH_IDLE = 0;

// Generated sheets (7 cols × 4 rows, 128×256):
//   Row 0 = idle poses, Row 1 = walk right, Row 2 = walk left, Row 3 = emotes.
const GEN_COLS = 7;
const GEN_WALK_RIGHT = [GEN_COLS, GEN_COLS + 1, GEN_COLS + 2, GEN_COLS + 3];
const GEN_WALK_LEFT = [GEN_COLS * 2, GEN_COLS * 2 + 1, GEN_COLS * 2 + 2, GEN_COLS * 2 + 3];
const GEN_IDLE = 0;

// ms per walk-animation frame — 4 frames fit neatly in WALK_DURATION_MS.
const WALK_FRAME_MS = 150;

// Player character constants.
const PLAYER_TEXTURE_KEY = "player-char";
const PLAYER_SPRITE_URL = "/characters/char_0.png";
const PLAYER_MOVE_MS = 220; // snappy tile-to-tile movement
const PLAYER_START_TILE_X = 16;
const PLAYER_START_TILE_Y = 14;

// Idle-facing frame indices for 3-row placeholder sheets.
const PH_FACE_DOWN = 0;
const PH_FACE_LEFT = PH_COLS;
const PH_FACE_RIGHT = PH_COLS * 2;

type PlayerCharacter = {
  sprite: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  tileX: number;
  tileY: number;
  facing: { dx: number; dy: number };
  isMoving: boolean;
  walkTimer: Phaser.Time.TimerEvent | null;
};

type SpawnedAgent = {
  data: WorldAgent;
  sprite: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  tileX: number;
  tileY: number;
  /** "placeholder" | "generated" — portraits are single images, no walk anim. */
  spriteKind: SpriteKind;
  walkTimer: Phaser.Time.TimerEvent | null;
  // Active speech bubble container (null if none). Replaced on each new
  // bubble so the latest reply is what shows.
  bubble: Phaser.GameObjects.Container | null;
  /** Tween-based animation engine (breathing, walk bounce, fidget). */
  animator: SpriteAnimator;
  /** Community signal overlays (role glow, activity spark, etc.). */
  badges: BadgeRenderer | null;
};

type SpriteKind = "placeholder" | "generated" | "portrait";

function spriteKind(a: WorldAgent): SpriteKind {
  if (a.portrait_url) return "portrait";
  if (a.sprite_url) return "generated";
  return "placeholder";
}

function spriteUrl(a: WorldAgent): string {
  return a.portrait_url || a.sprite_url || a.placeholder_sprite_url;
}

function textureKey(url: string, kind: SpriteKind): string {
  // Distinguish the load paths so a sprite that flips between sources
  // (placeholder → portrait → generated sheet) doesn't reuse the wrong
  // cached texture metadata.
  return `${kind}:${url}`;
}

export class WorldScene extends Phaser.Scene {
  private spawned = new Map<string, SpawnedAgent>();
  private wanderTimers: Phaser.Time.TimerEvent[] = [];
  private mode: WorldMode = "own";
  private dragStartCam = new Phaser.Math.Vector2();
  private dragStartPtr = new Phaser.Math.Vector2();

  // Player character state.
  private player: PlayerCharacter | null = null;
  private playerName = "You";
  private playerSpriteUrl: string | null = null;
  private playerSpriteType: "portrait" | "sheet" | null = null;
  /** Resolved texture key — changes based on whether custom URL is set. */
  private _playerTextureKey = PLAYER_TEXTURE_KEY;
  private cursors: Phaser.Types.Input.Keyboard.CursorKeys | null = null;
  private keyZ: Phaser.Input.Keyboard.Key | null = null;
  private keyX: Phaser.Input.Keyboard.Key | null = null;
  private keyEnter: Phaser.Input.Keyboard.Key | null = null;
  private keySpace: Phaser.Input.Keyboard.Key | null = null;
  private keyEsc: Phaser.Input.Keyboard.Key | null = null;
  /** Virtual D-pad + A/B state from GameControls touch events. */
  private virtualInput = { up: false, down: false, left: false, right: false, a: false, b: false };
  private prevA = false;
  private prevB = false;
  /** Interaction prompt shown above NPC when player faces them. */
  private interactTarget: SpawnedAgent | null = null;
  private interactIndicator: Phaser.GameObjects.Text | null = null;

  constructor() {
    super("WorldScene");
  }

  init(data: { agents: WorldAgent[]; mode?: WorldMode; playerName?: string; playerSpriteUrl?: string | null; playerSpriteType?: "portrait" | "sheet" | null }) {
    this.registry.set("agents", data.agents);
    this.mode = data.mode ?? "own";
    this.playerName = data.playerName ?? "You";
    this.playerSpriteUrl = data.playerSpriteUrl ?? null;
    this.playerSpriteType = data.playerSpriteType ?? null;
  }

  preload() {
    // Phaser's texture cache lives on the Game and survives scene
    // restarts (which we trigger every time the agents prop changes).
    // Two race conditions to guard against:
    //  1. Texture finished loading: `textures.exists(key)` covers it.
    //  2. Texture still in-flight from a prior preload: `exists` returns
    //     false (cache not populated yet) but queueing the same key again
    //     trips Phaser's "Texture key already in use" warning.
    // We dedupe via a registry-backed Set that survives scene.restart().
    const queued = (this.registry.get("__queued_keys") as Set<string>) ||
      new Set<string>();
    this.registry.set("__queued_keys", queued);

    const queueOnce = (key: string, fn: () => void) => {
      if (this.textures.exists(key) || queued.has(key)) return;
      queued.add(key);
      fn();
    };

    queueOnce(MAP_TEXTURE_KEY, () => this.load.image(MAP_TEXTURE_KEY, MAP_URL));

    // Player character sprite — portrait or stock placeholder.
    // Use the same textureKey() helper as NPC portraits so the
    // loading path is identical (no special player keys).
    if (this.playerSpriteUrl && this.playerSpriteType === "portrait") {
      this._playerTextureKey = textureKey(this.playerSpriteUrl, "portrait");
      queueOnce(this._playerTextureKey, () => {
        this.load.image(this._playerTextureKey, this.playerSpriteUrl!);
      });
    } else {
      this._playerTextureKey = PLAYER_TEXTURE_KEY;
      queueOnce(PLAYER_TEXTURE_KEY, () =>
        this.load.spritesheet(PLAYER_TEXTURE_KEY, PLAYER_SPRITE_URL, {
          frameWidth: SPRITE_FRAME_W,
          frameHeight: SPRITE_FRAME_H,
        }),
      );
    }

    const agents = (this.registry.get("agents") as WorldAgent[]) || [];
    // Three sprite flavours, in preference order:
    //   - portrait_url present → two-step Gemini pipeline. Single 3:4
    //     PNG; load as a regular image (no slicing), display at 24×32.
    //   - sprite_url present (legacy) → old Ai-Engine v2 sheet (8×4,
    //     128×256 cells). Load frame 0.
    //   - neither → bundled char_N.png sheet (7×3, 16×32 cells).
    for (const a of agents) {
      const kind = spriteKind(a);
      const url = spriteUrl(a);
      const key = textureKey(url, kind);
      queueOnce(key, () => {
        if (kind === "portrait") {
          this.load.image(key, url);
        } else {
          this.load.spritesheet(key, url, {
            frameWidth: kind === "generated" ? GENERATED_SHEET_FRAME_W : SPRITE_FRAME_W,
            frameHeight: kind === "generated" ? GENERATED_SHEET_FRAME_H : SPRITE_FRAME_H,
          });
        }
      });
    }
  }

  create() {
    this.cameras.main.setBackgroundColor("#0c1626");

    // Map fills the world from (0,0). Anchor top-left so tile coords map
    // straight onto the map.
    const map = this.add
      .image(0, 0, MAP_TEXTURE_KEY)
      .setOrigin(0, 0)
      .setDisplaySize(WORLD_W_PX, WORLD_H_PX);
    map.setDepth(-100);
    if (this.textures.exists(MAP_TEXTURE_KEY)) {
      this.textures.get(MAP_TEXTURE_KEY).setFilter(Phaser.Textures.FilterMode.NEAREST);
    }

    const agents = (this.registry.get("agents") as WorldAgent[]) || [];
    for (const a of agents) this.spawnAgent(a);
    for (const s of this.spawned.values()) {
      this.scheduleNextWander(s);
      s.animator.idle();
    }

    // Spawn the player-controlled character.
    this.spawnPlayer();

    // Keyboard input — arrow keys + Z (A) / X (B) / Enter / Space / Esc.
    if (this.input.keyboard) {
      this.cursors = this.input.keyboard.createCursorKeys();
      this.keyZ = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.Z);
      this.keyX = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.X);
      this.keyEnter = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ENTER);
      this.keySpace = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
      this.keyEsc = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);

      // Stop Phaser from preventDefault'ing keys that text inputs
      // need. The per-key `preventDefault` flag isn't enough — the
      // KeyboardPlugin holds a separate `captures` array, and any
      // keycode in there gets `event.preventDefault()` called at the
      // manager level *before* per-key handling. Remove the keys we
      // care about from that capture set so the browser delivers the
      // event to focused textareas / inputs untouched.
      // Player movement still works because `isDown` state is updated
      // from the same window-level listener — we just stop hijacking
      // the browser default. Pair with the focus check in
      // getCombinedInput() so player input pauses while typing.
      const passthrough: Array<Phaser.Input.Keyboard.Key | undefined> = [
        this.keySpace ?? undefined,
        this.keyEnter ?? undefined,
        this.keyZ ?? undefined,
        this.keyX ?? undefined,
        this.cursors?.up,
        this.cursors?.down,
        this.cursors?.left,
        this.cursors?.right,
      ];
      for (const k of passthrough) {
        if (k) (k as { preventDefault?: boolean }).preventDefault = false;
      }
      this.input.keyboard.removeCapture([
        Phaser.Input.Keyboard.KeyCodes.SPACE,
        Phaser.Input.Keyboard.KeyCodes.ENTER,
        Phaser.Input.Keyboard.KeyCodes.UP,
        Phaser.Input.Keyboard.KeyCodes.DOWN,
        Phaser.Input.Keyboard.KeyCodes.LEFT,
        Phaser.Input.Keyboard.KeyCodes.RIGHT,
        Phaser.Input.Keyboard.KeyCodes.Z,
        Phaser.Input.Keyboard.KeyCodes.X,
      ]);
    }

    // Camera bounds = world. Initial zoom = overview (entire map fits in
    // the viewport). Re-evaluated on resize too.
    this.cameras.main.setBounds(0, 0, WORLD_W_PX, WORLD_H_PX);
    // Start focused on player at a comfortable game zoom.
    const startZoom = Math.max(this.getOverviewZoom(), 2.2);
    this.cameras.main.setZoom(startZoom);
    if (this.player) {
      this.cameras.main.startFollow(this.player.sprite, true, 1, 1);
    } else {
      this.cameras.main.centerOn(WORLD_W_PX / 2, WORLD_H_PX / 2);
    }
    this.scale.on("resize", this.handleResize, this);

    // Pan + zoom — owner can drag the map and wheel to zoom; visit mode
    // is the same (the *agents* are read-only, the camera isn't).
    this.setupCameraControls();

    // Signal React that assets are loaded and the scene is painted.
    // Delay by one game tick so the first frame actually renders before
    // the loading overlay drops — firing in create() itself is too early
    // (WebGL hasn't flushed the first draw call yet).
    this.time.delayedCall(0, () => {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("phaser:scene-ready"));
      }
    });
  }

  // ── Player character ──────────────────────────────────────────────

  private spawnPlayer() {
    // Find an unoccupied tile near the default start position.
    const start = this.findEmptyTileNear(PLAYER_START_TILE_X, PLAYER_START_TILE_Y);
    const px = start.x * TILE_W + TILE_W / 2;
    const py = start.y * TILE_H + TILE_H / 2;

    // Determine sprite kind based on explicit type.
    const isPortrait = this.playerSpriteType === "portrait";
    const isGenerated = this.playerSpriteType === "sheet";

    const texKey = this._playerTextureKey;
    // Identical to NPC spawnAgent — portrait: image with setDisplaySize(24,32),
    // placeholder: spritesheet frame 0.
    const sprite = this.add.sprite(px, py, texKey, isPortrait ? undefined : PH_FACE_DOWN);
    if (isPortrait) sprite.setDisplaySize(24, SPRITE_FRAME_H);
    sprite.setOrigin(0.5, 0.95);
    sprite.setDepth(Math.round(py));
    if (this.textures.exists(texKey)) {
      this.textures.get(texKey).setFilter(Phaser.Textures.FilterMode.NEAREST);
    }

    const labelOffsetY = sprite.displayHeight || SPRITE_FRAME_H;
    const label = this.add.text(px, py - labelOffsetY + 2, this.playerName, {
      fontFamily: "monospace",
      fontSize: "8px",
      color: "#ffe17d",
      backgroundColor: "#1f2a3cdd",
      padding: { left: 2, right: 2, top: 1, bottom: 1 },
      resolution: 2,
    });
    label.setOrigin(0.5, 1);
    label.setDepth(Math.round(py) + 1);

    this.player = {
      sprite,
      label,
      tileX: start.x,
      tileY: start.y,
      facing: { dx: 0, dy: 1 },
      isMoving: false,
      walkTimer: null,
    };
  }

  private findEmptyTileNear(cx: number, cy: number): { x: number; y: number } {
    for (let r = 0; r <= 10; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const tx = cx + dx;
          const ty = cy + dy;
          if (tx < 1 || tx >= GRID_W - 1 || ty < 1 || ty >= GRID_H - 1) continue;
          let free = true;
          for (const s of this.spawned.values()) {
            if (s.tileX === tx && s.tileY === ty) { free = false; break; }
          }
          if (free) return { x: tx, y: ty };
        }
      }
    }
    return { x: cx, y: cy };
  }

  /** Combined input from keyboard + virtual D-pad/buttons. When the
   *  user is typing in a text input we drop all keyboard input so the
   *  player doesn't sprint around while they type and so Z/Space don't
   *  fire chat actions. Virtual D-pad still works (touch controls). */
  private getCombinedInput() {
    const ae = typeof document !== "undefined" ? document.activeElement : null;
    const typing = !!(
      ae &&
      (ae.tagName === "INPUT" ||
        ae.tagName === "TEXTAREA" ||
        (ae as HTMLElement).isContentEditable)
    );
    if (typing) {
      return {
        up: this.virtualInput.up,
        down: this.virtualInput.down,
        left: this.virtualInput.left,
        right: this.virtualInput.right,
        a: this.virtualInput.a,
        b: this.virtualInput.b,
      };
    }
    return {
      up: !!this.cursors?.up.isDown || this.virtualInput.up,
      down: !!this.cursors?.down.isDown || this.virtualInput.down,
      left: !!this.cursors?.left.isDown || this.virtualInput.left,
      right: !!this.cursors?.right.isDown || this.virtualInput.right,
      a: !!this.keyZ?.isDown || !!this.keyEnter?.isDown || !!this.keySpace?.isDown || this.virtualInput.a,
      b: !!this.keyX?.isDown || !!this.keyEsc?.isDown || this.virtualInput.b,
    };
  }

  update() {
    if (!this.player) return;
    const input = this.getCombinedInput();

    // A/B edge-triggered (fire on press, not hold).
    if (input.a && !this.prevA) this.handleAPress();
    if (input.b && !this.prevB) this.handleBPress();
    this.prevA = input.a;
    this.prevB = input.b;

    // Movement — only when not already mid-step.
    if (!this.player.isMoving) {
      let dx = 0;
      let dy = 0;
      if (input.up) dy = -1;
      else if (input.down) dy = 1;
      else if (input.left) dx = -1;
      else if (input.right) dx = 1;

      if (dx !== 0 || dy !== 0) {
        this.player.facing = { dx, dy };
        this.setPlayerIdleFrame(); // face direction even if blocked
        this.tryMovePlayer(dx, dy);
      }
    }

    // Update interaction prompt.
    this.updateInteractPrompt();
  }

  private tryMovePlayer(dx: number, dy: number) {
    if (!this.player) return;
    const tx = this.player.tileX + dx;
    const ty = this.player.tileY + dy;

    // Bounds check.
    if (tx < 0 || tx >= GRID_W || ty < 0 || ty >= GRID_H) return;

    // NPC collision check.
    for (const s of this.spawned.values()) {
      if (s.tileX === tx && s.tileY === ty) return;
    }

    this.player.tileX = tx;
    this.player.tileY = ty;
    this.player.isMoving = true;

    const targetX = tx * TILE_W + TILE_W / 2;
    const targetY = ty * TILE_H + TILE_H / 2;

    // Re-enable camera follow whenever the player moves.
    this.cameras.main.startFollow(this.player.sprite, true, 1, 1);

    this.startPlayerWalk(dx, dy);

    this.tweens.add({
      targets: this.player.sprite,
      x: targetX,
      y: targetY,
      duration: PLAYER_MOVE_MS,
      ease: "Linear",
      onUpdate: () => {
        if (!this.player) return;
        this.player.sprite.setDepth(Math.round(this.player.sprite.y));
        this.player.label.setPosition(
          this.player.sprite.x,
          this.player.sprite.y - SPRITE_FRAME_H + 2,
        );
        this.player.label.setDepth(Math.round(this.player.sprite.y) + 1);
      },
      onComplete: () => {
        if (!this.player) return;
        this.player.isMoving = false;
        this.stopPlayerWalk();
      },
    });

    this.tweens.add({
      targets: this.player.label,
      x: targetX,
      y: targetY - SPRITE_FRAME_H + 2,
      duration: PLAYER_MOVE_MS,
      ease: "Linear",
    });
  }

  private startPlayerWalk(dx: number, dy: number) {
    if (!this.player) return;
    if (this.playerSpriteType === "portrait") return; // portraits can't animate
    this.stopPlayerWalk();
    const isGen = this.playerSpriteType === "sheet";
    let frames: number[];
    if (isGen) {
      // Generated 7×4 sheet: row 1 = walk right, row 2 = walk left.
      this.player.sprite.setFlipX(false);
      if (dx < 0) frames = GEN_WALK_LEFT;
      else if (dx > 0) frames = GEN_WALK_RIGHT;
      else if (dy < 0) frames = GEN_WALK_LEFT;  // up — walk left as "away"
      else frames = GEN_WALK_RIGHT;               // down — walk right
    } else {
      // Placeholder 7×3 sheet.
      if (dx < 0) frames = PH_WALK_LEFT;
      else if (dx > 0) frames = PH_WALK_RIGHT;
      else frames = PH_WALK_DOWN;
    }
    let idx = 0;
    this.player.sprite.setFrame(frames[0]);
    this.player.walkTimer = this.time.addEvent({
      delay: WALK_FRAME_MS,
      repeat: -1,
      callback: () => {
        idx = (idx + 1) % frames.length;
        this.player?.sprite.setFrame(frames[idx]);
      },
    });
  }

  private stopPlayerWalk() {
    if (!this.player) return;
    if (this.player.walkTimer) {
      this.player.walkTimer.remove(false);
      this.player.walkTimer = null;
    }
    this.setPlayerIdleFrame();
  }

  private setPlayerIdleFrame() {
    if (!this.player) return;
    if (this.playerSpriteType === "portrait") return;
    const isGen = this.playerSpriteType === "sheet";
    const { dx, dy } = this.player.facing;
    if (isGen) {
      // Use the first walk frame as the directional idle so the
      // character faces the direction they're walking, not always
      // staring at the camera.
      if (dx < 0) {
        this.player.sprite.setFrame(GEN_WALK_LEFT[0]);
        this.player.sprite.setFlipX(false);
      } else if (dx > 0) {
        this.player.sprite.setFrame(GEN_WALK_RIGHT[0]);
        this.player.sprite.setFlipX(false);
      } else if (dy < 0) {
        // Facing up — use left walk frame as "back" view.
        this.player.sprite.setFrame(GEN_WALK_LEFT[0]);
        this.player.sprite.setFlipX(false);
      } else {
        // Facing down — front-facing idle.
        this.player.sprite.setFrame(GEN_IDLE);
        this.player.sprite.setFlipX(false);
      }
    } else {
      if (dx < 0) this.player.sprite.setFrame(PH_FACE_LEFT);
      else if (dx > 0) this.player.sprite.setFrame(PH_FACE_RIGHT);
      else this.player.sprite.setFrame(PH_FACE_DOWN);
    }
  }

  /** Return the NPC at the tile the player is facing, or null. */
  private getAdjacentNPC(): SpawnedAgent | null {
    if (!this.player) return null;
    const tx = this.player.tileX + this.player.facing.dx;
    const ty = this.player.tileY + this.player.facing.dy;
    for (const s of this.spawned.values()) {
      if (s.tileX === tx && s.tileY === ty) return s;
    }
    return null;
  }

  private handleAPress() {
    const npc = this.getAdjacentNPC();
    if (npc) {
      // Make the NPC face toward the player.
      this.faceNpcTowardPlayer(npc);
      this.emitChat(npc.data);
      // Also trigger agents to talk to each other (tick the world).
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("phaser:trigger-tick"));
      }
    }
  }

  /** Turn an NPC sprite to face the player character. */
  private faceNpcTowardPlayer(npc: SpawnedAgent) {
    if (!this.player || npc.spriteKind === "portrait") return;
    // Cancel any active wander so the NPC doesn't walk away mid-chat.
    if (npc.walkTimer) {
      npc.walkTimer.remove(false);
      npc.walkTimer = null;
    }
    const dx = this.player.tileX - npc.tileX;
    const dy = this.player.tileY - npc.tileY;
    if (npc.spriteKind === "generated") {
      // Generated sheets don't have a down-facing row — just flip for left/right.
      npc.sprite.setFrame(GEN_IDLE);
      npc.sprite.setFlipX(dx < 0);
    } else {
      // Placeholder sheets: row 0 = down, row 1 = left, row 2 = right.
      if (Math.abs(dx) >= Math.abs(dy)) {
        npc.sprite.setFrame(dx < 0 ? PH_FACE_LEFT : PH_FACE_RIGHT);
      } else {
        npc.sprite.setFrame(PH_FACE_DOWN);
      }
    }
  }

  private handleBPress() {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("phaser:b-press"));
  }

  /** Show/hide a "!" indicator above the NPC the player faces. */
  private updateInteractPrompt() {
    const adjacent = this.getAdjacentNPC();
    if (adjacent && adjacent !== this.interactTarget) {
      // New target — create indicator.
      if (this.interactIndicator) this.interactIndicator.destroy();
      this.interactIndicator = this.add.text(
        adjacent.sprite.x,
        adjacent.sprite.y - SPRITE_FRAME_H - 10,
        "!",
        {
          fontFamily: "monospace",
          fontSize: "12px",
          color: "#ffe17d",
          fontStyle: "bold",
          stroke: "#1f2a3c",
          strokeThickness: 3,
          resolution: 2,
        },
      ).setOrigin(0.5);
      this.interactIndicator.setDepth(9999);
      this.tweens.add({
        targets: this.interactIndicator,
        y: adjacent.sprite.y - SPRITE_FRAME_H - 14,
        yoyo: true,
        repeat: -1,
        duration: 500,
        ease: "Sine.InOut",
      });
      this.interactTarget = adjacent;
    } else if (!adjacent && this.interactTarget) {
      // No target — remove indicator.
      if (this.interactIndicator) {
        this.tweens.killTweensOf(this.interactIndicator);
        this.interactIndicator.destroy();
      }
      this.interactIndicator = null;
      this.interactTarget = null;
    } else if (adjacent && this.interactIndicator) {
      // Same target — sync position (NPC may have wandered).
      this.tweens.killTweensOf(this.interactIndicator);
      this.interactIndicator.setPosition(
        adjacent.sprite.x,
        adjacent.sprite.y - SPRITE_FRAME_H - 10,
      );
      this.tweens.add({
        targets: this.interactIndicator,
        y: adjacent.sprite.y - SPRITE_FRAME_H - 14,
        yoyo: true,
        repeat: -1,
        duration: 500,
        ease: "Sine.InOut",
      });
    }
  }

  // ── NPC agents ───────────────────────────────────────────────────

  private spawnAgent(a: WorldAgent) {
    const kind = spriteKind(a);
    const url = spriteUrl(a);
    const key = textureKey(url, kind);
    const px = a.tile_x * TILE_W + TILE_W / 2;
    const py = a.tile_y * TILE_H + TILE_H / 2;

    // Display size by source:
    //   - portrait → 24×32 (3:4 aspect — slightly wider than placeholders)
    //   - generated 8×4 sheet → 16×32 (slice frame 0 down to footprint)
    //   - placeholder 7×3 sheet → native 16×32, no resize
    const sprite = this.add.sprite(px, py, key, 0);
    if (kind === "portrait") sprite.setDisplaySize(24, SPRITE_FRAME_H);
    else if (kind === "generated") sprite.setDisplaySize(SPRITE_FRAME_W, SPRITE_FRAME_H);
    sprite.setOrigin(0.5, 0.95);
    sprite.setInteractive({ useHandCursor: true });
    // Capture `scene` explicitly — Phaser's InputPlugin sometimes rebinds
    // `this` on its event callbacks even when they're arrow functions
    // (depends on bundler), so the safe pattern is a closure variable.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const scene = this;
    sprite.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      // Distinguish a tap from a drag — only emit + focus if pointer
      // didn't move between down and up.
      const start = { x: pointer.x, y: pointer.y };
      const onUp = (up: Phaser.Input.Pointer) => {
        const dx = up.x - start.x;
        const dy = up.y - start.y;
        if (Math.hypot(dx, dy) < 4) {
          scene.focusOnAgent(a.id);
          scene.approachAndChat(a);
        }
        scene.input.off("pointerup", onUp);
      };
      scene.input.on("pointerup", onUp);
    });
    sprite.setDepth(Math.round(py)); // y-sort so closer agents render on top.
    if (this.textures.exists(key)) {
      this.textures.get(key).setFilter(Phaser.Textures.FilterMode.NEAREST);
    }

    const label = this.add.text(px, py - SPRITE_FRAME_H + 2, a.display_name, {
      fontFamily: "monospace",
      fontSize: "8px",
      color: "#fffaf0",
      backgroundColor: "#1f2a3cdd",
      padding: { left: 2, right: 2, top: 1, bottom: 1 },
      resolution: 2,
    });
    label.setOrigin(0.5, 1);
    label.setDepth(Math.round(py) + 1);

    const animator = new SpriteAnimator(this, sprite, a.personality);

    // Community signal badges (role glow, activity spark, etc.).
    const badgeData: BadgeData = {
      role: a.canonical_id ?? null,
      recentlyActive: a.badge?.recentlyActive ?? false,
      isVisitorTwin: a.badge?.isVisitorTwin ?? false,
      hasReflections: a.badge?.hasReflections ?? false,
    };
    const hasBadges =
      badgeData.role ||
      badgeData.recentlyActive ||
      badgeData.isVisitorTwin ||
      badgeData.hasReflections;
    const badges = hasBadges ? new BadgeRenderer(this, sprite, badgeData) : null;

    this.spawned.set(a.id, {
      data: a,
      sprite,
      label,
      tileX: a.tile_x,
      tileY: a.tile_y,
      spriteKind: kind,
      walkTimer: null,
      bubble: null,
      animator,
      badges,
    });
  }

  /**
   * Pop a speech bubble above the agent's sprite. Replaces any existing
   * bubble for that agent. Truncates to BUBBLE_MAX_CHARS, ensures we
   * don't exceed BUBBLE_MAX_ON_SCREEN globally (oldest bubble wins).
   */
  showBubble(agentId: string, text: string) {
    // Window-level "phaser:agent-bubble" events can arrive while the
    // scene is mid-restart (Phaser tears down `this.add` between
    // SHUTDOWN and CREATE). The cleanest defence is just to attempt
    // the work, swallow any error silently. Don't call `isActive()` —
    // Phaser's ScenePlugin throws synchronously when accessed on a
    // stale scene, defeating the purpose of the guard.
    if (!this.add) return;
    try {
      this._showBubbleInner(agentId, text);
    } catch {
      // Bubbles are decorative — silent skip.
    }
  }

  private _showBubbleInner(agentId: string, text: string) {
    const s = this.spawned.get(agentId);
    if (!s) return;

    // Drop existing bubble for this agent.
    if (s.bubble) {
      s.bubble.destroy();
      s.bubble = null;
    }

    // Cap total bubbles on screen.
    let active = 0;
    let oldest: SpawnedAgent | null = null;
    let oldestStartedAt = Number.POSITIVE_INFINITY;
    for (const o of this.spawned.values()) {
      if (!o.bubble) continue;
      active += 1;
      const startedAt = (o.bubble.getData("startedAt") as number) ?? 0;
      if (startedAt < oldestStartedAt) {
        oldestStartedAt = startedAt;
        oldest = o;
      }
    }
    if (active >= BUBBLE_MAX_ON_SCREEN && oldest) {
      oldest.bubble?.destroy();
      oldest.bubble = null;
    }

    // Strip markdown markers so *bold* and _italic_ render as plain text.
    const cleaned = text.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
    const display =
      cleaned.length > BUBBLE_MAX_CHARS
        ? cleaned.slice(0, BUBBLE_MAX_CHARS - 1) + "…"
        : cleaned;
    const padding = 6;
    const radius = 6;
    const txt = this.add
      .text(0, 0, display, {
        fontFamily: "sans-serif",
        fontSize: "10px",
        color: "#1f2a3c",
        wordWrap: { width: 180, useAdvancedWrap: true },
        resolution: 2,
      })
      .setOrigin(0.5, 1);
    const w = Math.ceil(txt.width) + padding * 2;
    const h = Math.ceil(txt.height) + padding * 2;
    const bg = this.add.graphics();
    bg.fillStyle(0xffffff, 0.97);
    bg.lineStyle(2, 0x1f2a3c, 1);
    bg.fillRoundedRect(-w / 2, -h, w, h, radius);
    bg.strokeRoundedRect(-w / 2, -h, w, h, radius);
    // Bubble tail pointing down toward the sprite.
    bg.fillStyle(0xffffff, 0.97);
    bg.fillTriangle(-4, 0, 4, 0, 0, 6);
    bg.lineStyle(2, 0x1f2a3c, 1);
    bg.lineBetween(-4, 0, 0, 6);
    bg.lineBetween(4, 0, 0, 6);
    txt.setPosition(0, -padding);

    const x = s.sprite.x;
    const y = s.sprite.y - SPRITE_FRAME_H - 4;
    const container = this.add.container(x, y, [bg, txt]);
    container.setDepth(Math.round(s.sprite.y) + 100);
    container.setData("startedAt", performance.now());
    s.bubble = container;

    // Auto-fade.
    this.time.delayedCall(BUBBLE_LIFETIME_MS, () => {
      if (s.bubble !== container) return; // a newer bubble took over
      this.tweens.add({
        targets: container,
        alpha: 0,
        duration: BUBBLE_FADE_MS,
        ease: "Sine.Out",
        onComplete: () => {
          container.destroy();
          if (s.bubble === container) s.bubble = null;
        },
      });
    });
  }

  private emitTap(a: WorldAgent) {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("phaser:agent-tap", {
        detail: {
          agent_id: a.id,
          display_name: a.display_name,
          canonical_id: a.canonical_id,
          mode: this.mode,
        },
      }),
    );
  }

  /** Z-key chat — opens RPG dialog instead of profile. */
  private emitChat(a: WorldAgent) {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("phaser:agent-chat", {
        detail: {
          agent_id: a.id,
          display_name: a.display_name,
          canonical_id: a.canonical_id,
          mode: this.mode,
        },
      }),
    );
  }

  private scheduleNextWander(s: SpawnedAgent) {
    // Sociable/energetic agents wander more often, introverted ones less.
    const p = s.data.personality;
    const sociability = p?.sociability ?? 0.5;
    // Lerp: high sociability → shorter delay (4s), low → longer (14s).
    const minMs = 4_000;
    const maxMs = 14_000;
    const base = maxMs - sociability * (maxMs - minMs);
    const jitter = Phaser.Math.Between(-1500, 1500);
    const delay = Math.max(2000, Math.round(base + jitter));
    const t = this.time.delayedCall(delay, () => this.wander(s));
    this.wanderTimers.push(t);
  }

  /** Start cycling walk-animation frames on a sprite. */
  private startWalk(s: SpawnedAgent, dx: number, dy: number, walkMs = WALK_DURATION_MS) {
    this.stopWalk(s);
    // Tween-based walk overlay (bounce + lean) for ALL sprite kinds.
    s.animator.walk(dx, dy, walkMs);
    // Portraits are single images — no frame animation possible.
    if (s.spriteKind === "portrait") return;

    let frames: number[];
    if (s.spriteKind === "generated") {
      // Generated sheets: row 1 = walk right, row 2 = walk left.
      frames = dx < 0 ? GEN_WALK_LEFT : GEN_WALK_RIGHT;
      s.sprite.setFlipX(false);
    } else {
      // Placeholder sheets: distinct rows per direction.
      if (Math.abs(dx) > Math.abs(dy)) {
        frames = dx < 0 ? PH_WALK_LEFT : PH_WALK_RIGHT;
      } else {
        frames = PH_WALK_DOWN;
      }
      s.sprite.setFlipX(false);
    }

    let idx = 0;
    s.sprite.setFrame(frames[0]);
    s.walkTimer = this.time.addEvent({
      delay: WALK_FRAME_MS,
      repeat: -1,
      callback: () => {
        idx = (idx + 1) % frames.length;
        s.sprite.setFrame(frames[idx]);
      },
    });
  }

  /** Stop walk animation and return to idle frame. */
  private stopWalk(s: SpawnedAgent) {
    if (s.walkTimer) {
      s.walkTimer.remove(false);
      s.walkTimer = null;
    }
    s.animator.walkComplete();
    if (s.spriteKind === "portrait") return;
    s.sprite.setFrame(s.spriteKind === "generated" ? GEN_IDLE : PH_IDLE);
    s.sprite.setFlipX(false);
  }

  private wander(s: SpawnedAgent) {
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    Phaser.Utils.Array.Shuffle(dirs);
    let nextX = s.tileX;
    let nextY = s.tileY;
    for (const [dx, dy] of dirs) {
      const tx = s.tileX + dx;
      const ty = s.tileY + dy;
      if (tx < 1 || tx >= GRID_W - 1 || ty < 1 || ty >= GRID_H - 1) continue;
      let occupied = false;
      for (const other of this.spawned.values()) {
        if (other === s) continue;
        if (other.tileX === tx && other.tileY === ty) {
          occupied = true;
          break;
        }
      }
      // Also avoid the player's tile.
      if (!occupied && this.player && this.player.tileX === tx && this.player.tileY === ty) {
        occupied = true;
      }
      if (occupied) continue;
      nextX = tx;
      nextY = ty;
      break;
    }
    if (nextX === s.tileX && nextY === s.tileY) {
      this.scheduleNextWander(s);
      return;
    }

    const dx = nextX - s.tileX;
    const dy = nextY - s.tileY;
    s.tileX = nextX;
    s.tileY = nextY;
    const targetX = nextX * TILE_W + TILE_W / 2;
    const targetY = nextY * TILE_H + TILE_H / 2;
    const newDepth = Math.round(targetY);

    // Confident agents walk faster (400ms), shy ones slower (900ms).
    const confidence = s.data.personality?.confidence ?? 0.5;
    const walkMs = Math.round(900 - confidence * 500);

    // Start walk animation for the duration of the movement.
    this.startWalk(s, dx, dy, walkMs);

    this.tweens.add({
      targets: s.sprite,
      x: targetX,
      y: targetY,
      duration: walkMs,
      ease: "Sine.InOut",
      onUpdate: () => {
        s.sprite.setDepth(Math.round(s.sprite.y));
        s.label.setDepth(Math.round(s.sprite.y) + 1);
        // Sync animator base so shadow tracks and breathing re-centers.
        s.animator.updateBase(s.sprite.x, s.sprite.y);
        if (s.badges) s.badges.syncPosition();
        // Keep the bubble glued above the sprite as it walks.
        if (s.bubble) {
          s.bubble.setPosition(s.sprite.x, s.sprite.y - SPRITE_FRAME_H - 4);
        }
      },
      onComplete: () => {
        // Update animator base to final position before stopping walk.
        s.animator.updateBase(targetX, targetY);
        this.stopWalk(s);
        s.sprite.setDepth(newDepth);
        s.label.setDepth(newDepth + 1);
        this.scheduleNextWander(s);
      },
    });
    this.tweens.add({
      targets: s.label,
      x: targetX,
      y: targetY - SPRITE_FRAME_H + 2,
      duration: walkMs,
      ease: "Sine.InOut",
    });
  }

  // ── Camera ─────────────────────────────────────────────────────────

  /**
   * Zoom that makes the map cover (envelop) the viewport — fills the
   * screen, may crop a tiny bit on whichever axis is the "wrong" ratio.
   * Mirrors Pixel Societies' `getOverviewZoom`. We use Math.max so the
   * user never sees the blue background — at this zoom or higher, the
   * world fills both axes (one of them perfectly).
   *
   * This is also the floor for the wheel/pinch zoom (see clampZoom).
   */
  private getOverviewZoom(): number {
    const w = this.scale.width || 1920;
    const h = this.scale.height || 1080;
    const sx = w / WORLD_W_PX;
    const sy = h / WORLD_H_PX;
    return Math.max(sx, sy);
  }

  private clampZoom(target: number): number {
    return Phaser.Math.Clamp(target, this.getOverviewZoom(), MAX_ZOOM);
  }

  private applyOverviewZoom() {
    const cam = this.cameras.main;
    cam.setZoom(this.getOverviewZoom());
    cam.centerOn(WORLD_W_PX / 2, WORLD_H_PX / 2);
  }

  private handleResize() {
    // Only snap back to overview if we're already near it, otherwise
    // respect the user's zoom level on resize.
    const cam = this.cameras.main;
    const overview = this.getOverviewZoom();
    if (Math.abs(cam.zoom - overview) < 0.05) {
      this.applyOverviewZoom();
    }
  }

  /**
   * Agent walks toward the camera center, then emits the chat tap event.
   * Gives a Pokemon-style "approach to talk" feel.
   */
  private approachAndChat(a: WorldAgent) {
    const s = this.spawned.get(a.id);
    if (!s) {
      this.emitTap(a);
      return;
    }

    // Cancel any pending wander so the agent doesn't walk away.
    if (s.walkTimer) {
      s.walkTimer.remove(false);
      s.walkTimer = null;
    }

    // Compute camera center in tile coords.
    const cam = this.cameras.main;
    const centerWorldX = cam.scrollX + cam.width / (2 * cam.zoom);
    const centerWorldY = cam.scrollY + cam.height / (2 * cam.zoom);
    const targetTileX = Math.round(centerWorldX / TILE_W);
    const targetTileY = Math.round(centerWorldY / TILE_H);

    // Build axis-aligned path: close X gap first, then Y.
    // Stop 1 tile away from the target so the agent doesn't overlap the focus point.
    const steps: { dx: number; dy: number }[] = [];
    let cx = s.tileX;
    let cy = s.tileY;

    // Limit to 4 steps max for snappy feel.
    for (let i = 0; i < 4; i++) {
      const gapX = targetTileX - cx;
      const gapY = targetTileY - cy;
      // Stop when within 1 tile of target.
      if (Math.abs(gapX) <= 1 && Math.abs(gapY) <= 1) break;
      if (Math.abs(gapX) > Math.abs(gapY)) {
        const dx = gapX > 0 ? 1 : -1;
        steps.push({ dx, dy: 0 });
        cx += dx;
      } else {
        const dy = gapY > 0 ? 1 : -1;
        steps.push({ dx: 0, dy });
        cy += dy;
      }
    }

    if (steps.length === 0) {
      // Already close — just emit tap.
      this.emitTap(a);
      return;
    }

    // Emit approach-start event for React to show indicator if desired.
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("phaser:agent-approach-start", {
          detail: { agent_id: a.id, display_name: a.display_name },
        }),
      );
    }

    this.walkPath(s, steps, () => {
      this.stopWalk(s);
      // Brief pause, then emit chat event.
      this.time.delayedCall(200, () => {
        this.emitTap(a);
        // Resume wandering after chat closes (React will dispatch phaser:map-tap).
      });
    });
  }

  /**
   * Walk an agent along a sequence of single-tile steps, chaining tweens.
   */
  private walkPath(
    s: SpawnedAgent,
    steps: { dx: number; dy: number }[],
    onDone: () => void,
  ) {
    if (steps.length === 0) {
      onDone();
      return;
    }
    const [step, ...rest] = steps;
    const nextX = s.tileX + step.dx;
    const nextY = s.tileY + step.dy;

    // Clamp to grid bounds.
    if (nextX < 1 || nextX >= GRID_W - 1 || nextY < 1 || nextY >= GRID_H - 1) {
      onDone();
      return;
    }

    s.tileX = nextX;
    s.tileY = nextY;
    const targetPx = nextX * TILE_W + TILE_W / 2;
    const targetPy = nextY * TILE_H + TILE_H / 2;
    const walkMs = 400; // Brisk approach pace.

    this.startWalk(s, step.dx, step.dy, walkMs);

    this.tweens.add({
      targets: s.sprite,
      x: targetPx,
      y: targetPy,
      duration: walkMs,
      ease: "Sine.InOut",
      onUpdate: () => {
        s.sprite.setDepth(Math.round(s.sprite.y));
        s.label.setDepth(Math.round(s.sprite.y) + 1);
        s.animator.updateBase(s.sprite.x, s.sprite.y);
        if (s.badges) s.badges.syncPosition();
        if (s.bubble) {
          s.bubble.setPosition(s.sprite.x, s.sprite.y - SPRITE_FRAME_H - 4);
        }
      },
      onComplete: () => {
        s.animator.updateBase(targetPx, targetPy);
        this.stopWalk(s);
        // Continue to next step.
        this.walkPath(s, rest, onDone);
      },
    });
    this.tweens.add({
      targets: s.label,
      x: targetPx,
      y: targetPy - SPRITE_FRAME_H + 2,
      duration: walkMs,
      ease: "Sine.InOut",
    });
  }

  /**
   * Pan and zoom to an agent, then start following so they stay centered
   * during their idle wander. Click anywhere off-agent (drag) to release.
   */
  focusOnAgent(agentId: string) {
    const s = this.spawned.get(agentId);
    if (!s) return;
    const cam = this.cameras.main;
    cam.stopFollow();
    cam.pan(s.sprite.x, s.sprite.y, FOCUS_PAN_MS, "Power2");
    cam.zoomTo(FOCUS_ZOOM, FOCUS_PAN_MS);
    cam.once("camerapancomplete", () => {
      cam.startFollow(s.sprite, true, 0.08, 0.08);
    });
  }

  /** Zoom back to the overview (called from React UI).
   *  Also resumes wandering for any agents that were mid-approach. */
  resetCamera() {
    const cam = this.cameras?.main;
    if (!cam) return;
    // Resume wandering for all agents that may have had their timer cancelled.
    for (const s of this.spawned.values()) {
      if (!s.walkTimer) this.scheduleNextWander(s);
    }
    cam.stopFollow();
    cam.pan(WORLD_W_PX / 2, WORLD_H_PX / 2, FOCUS_PAN_MS, "Power2");
    cam.zoomTo(this.getOverviewZoom(), FOCUS_PAN_MS);
  }

  zoomBy(delta: number) {
    const cam = this.cameras?.main;
    if (!cam) return;
    cam.stopFollow();
    cam.zoomTo(this.clampZoom(cam.zoom + delta), 160, "Power2");
  }

  private setupCameraControls() {
    const cam = this.cameras.main;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const scene = this;

    // Drag to pan (only when the pointer is NOT over an agent — agents
    // capture their own pointerdown). Any drag also breaks the
    // startFollow lock so the user is never trapped on a focused agent.
    let dragging = false;
    let dragMoved = false;
    this.input.on("pointerdown", (p: Phaser.Input.Pointer, hit: unknown[]) => {
      if (Array.isArray(hit) && hit.length > 0) return;
      dragging = true;
      dragMoved = false;
      scene.dragStartCam.set(cam.scrollX, cam.scrollY);
      scene.dragStartPtr.set(p.x, p.y);
    });
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!dragging) return;
      const dx = p.x - scene.dragStartPtr.x;
      const dy = p.y - scene.dragStartPtr.y;
      if (!dragMoved && Math.hypot(dx, dy) > 4) {
        dragMoved = true;
        cam.stopFollow();
      }
      if (dragMoved) {
        cam.setScroll(
          scene.dragStartCam.x - dx / cam.zoom,
          scene.dragStartCam.y - dy / cam.zoom,
        );
      }
    });
    this.input.on("pointerup", (p: Phaser.Input.Pointer, hit: unknown[]) => {
      const wasDrag = dragMoved;
      dragging = false;
      dragMoved = false;
      // A clean click on empty map (no drag, no agent) clears focus and
      // dismisses any open toast on the React side.
      if (!wasDrag && Array.isArray(hit) && hit.length === 0) {
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("phaser:map-tap"));
        }
      }
    });

    // Wheel to zoom — also breaks follow so the user can scroll out
    // after focusing on an agent. Zoom-out is clamped to the overview
    // zoom so the blue background never appears around the world.
    this.input.on(
      "wheel",
      (
        _p: Phaser.Input.Pointer,
        _objs: unknown,
        _dx: number,
        dy: number,
      ) => {
        cam.stopFollow();
        cam.setZoom(scene.clampZoom(cam.zoom - dy * 0.001));
      },
    );

    // React → scene control: dispatch `phaser:reset-camera` from anywhere
    // (e.g. a HUD "Back to overview" button) to release follow and zoom
    // back out. Mirrors `phaser:agent-tap` on the way back.
    if (typeof window !== "undefined") {
      const onReset = () => scene.resetCamera();
      const onZoomIn = () => scene.zoomBy(0.18);
      const onZoomOut = () => scene.zoomBy(-0.18);
      const onBubble = (e: Event) => {
        const detail = (e as CustomEvent).detail as
          | { agent_id?: string; text?: string }
          | undefined;
        if (!detail?.agent_id || !detail?.text) return;
        scene.showBubble(detail.agent_id, detail.text);
      };
      window.addEventListener("phaser:reset-camera", onReset);
      window.addEventListener("phaser:zoom-in", onZoomIn);
      window.addEventListener("phaser:zoom-out", onZoomOut);
      // Virtual D-pad + A/B input from GameControls.
      const onGameInput = (e: Event) => {
        const d = (e as CustomEvent).detail as { key: string; pressed: boolean } | undefined;
        if (!d) return;
        if (d.key in scene.virtualInput) {
          (scene.virtualInput as Record<string, boolean>)[d.key] = d.pressed;
        }
      };

      window.addEventListener("phaser:agent-bubble", onBubble);
      window.addEventListener("game:input", onGameInput);
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
        window.removeEventListener("phaser:reset-camera", onReset);
        window.removeEventListener("phaser:zoom-in", onZoomIn);
        window.removeEventListener("phaser:zoom-out", onZoomOut);
        window.removeEventListener("phaser:agent-bubble", onBubble);
        window.removeEventListener("game:input", onGameInput);
      });
    }

    // Mobile pinch.
    let pinchStartDist = 0;
    let pinchStartZoom = 1;
    const canvas = this.game.canvas;
    canvas.addEventListener(
      "touchstart",
      (e: TouchEvent) => {
        if (e.touches.length === 2) {
          pinchStartDist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY,
          );
          pinchStartZoom = cam.zoom;
        }
      },
      { passive: true },
    );
    canvas.addEventListener(
      "touchmove",
      (e: TouchEvent) => {
        if (e.touches.length !== 2 || !pinchStartDist) return;
        e.preventDefault();
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY,
        );
        cam.stopFollow();
        cam.setZoom(scene.clampZoom(pinchStartZoom * (dist / pinchStartDist)));
      },
      { passive: false },
    );
    canvas.addEventListener(
      "touchend",
      () => {
        pinchStartDist = 0;
      },
      { passive: true },
    );
  }

  shutdown() {
    for (const t of this.wanderTimers) t.remove(false);
    this.wanderTimers = [];
    for (const s of this.spawned.values()) {
      if (s.walkTimer) s.walkTimer.remove(false);
      s.animator.destroy();
      if (s.badges) s.badges.destroy();
    }
    this.spawned.clear();
    // Cleanup player.
    if (this.player?.walkTimer) this.player.walkTimer.remove(false);
    this.player = null;
    if (this.interactIndicator) this.interactIndicator.destroy();
    this.interactIndicator = null;
    this.interactTarget = null;
    this.scale.off("resize", this.handleResize, this);
  }
}
