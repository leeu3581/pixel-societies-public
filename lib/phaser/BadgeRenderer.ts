// Community signal overlays for agent sprites.
//
// Visual indicators rendered as Phaser objects that follow the sprite:
//   - Role glow: colored ellipse under the sprite (from canonical_id)
//   - Activity spark: brief star particle for recently-active agents
//   - Visitor badge: pulsing outline for the visiting user's twin
//   - Reflection crown: tiny sparkle for agents with reflections
//
// These are NOT baked into the sprite image — they're dynamic Phaser
// overlays that can change without re-generating sprites.

import * as Phaser from "phaser";

export type BadgeData = {
  /** canonical_id or custom role for color mapping. */
  role: string | null;
  /** Whether this agent posted recently (within last 2 engine ticks). */
  recentlyActive: boolean;
  /** Whether this agent belongs to a visitor (visit mode). */
  isVisitorTwin: boolean;
  /** Whether this agent has generated reflections. */
  hasReflections: boolean;
};

// Role → glow color. Matches the canonical agent roles from the DB.
const ROLE_COLORS: Record<string, number> = {
  support: 0x4fc3f7,   // light blue
  engineering: 0x81c784, // green
  design: 0xce93d8,     // purple
  sales: 0xffb74d,      // orange
  marketing: 0xf06292,   // pink
  product: 0x64b5f6,    // blue
  data: 0xa5d6a7,       // pale green
  research: 0x90caf9,    // light blue
};
const DEFAULT_GLOW_COLOR = 0xb0bec5; // grey for unknown roles

export class BadgeRenderer {
  private scene: Phaser.Scene;
  private sprite: Phaser.GameObjects.Sprite;
  private data: BadgeData;

  private glow: Phaser.GameObjects.Ellipse | null = null;
  private sparkTimer: Phaser.Time.TimerEvent | null = null;
  private sparkGraphics: Phaser.GameObjects.Graphics | null = null;
  private visitorRing: Phaser.GameObjects.Graphics | null = null;
  private visitorPulseTween: Phaser.Tweens.Tween | null = null;
  private reflectionStar: Phaser.GameObjects.Graphics | null = null;
  private reflectionTween: Phaser.Tweens.Tween | null = null;

  constructor(
    scene: Phaser.Scene,
    sprite: Phaser.GameObjects.Sprite,
    data: BadgeData,
  ) {
    this.scene = scene;
    this.sprite = sprite;
    this.data = data;
    this.create();
  }

  private create() {
    this.createGlow();
    if (this.data.recentlyActive) this.createActivitySpark();
    if (this.data.isVisitorTwin) this.createVisitorBadge();
    if (this.data.hasReflections) this.createReflectionCrown();
  }

  // ── Role Glow ──────────────────────────────────────────────────────

  private createGlow() {
    if (!this.data.role) return;
    const color = ROLE_COLORS[this.data.role] ?? DEFAULT_GLOW_COLOR;
    this.glow = this.scene.add.ellipse(
      this.sprite.x,
      this.sprite.y + 4,
      20,
      7,
      color,
      0.15,
    );
    this.glow.setDepth(this.sprite.depth - 2);
  }

  // ── Activity Spark ─────────────────────────────────────────────────

  private createActivitySpark() {
    this.sparkGraphics = this.scene.add.graphics();
    this.sparkGraphics.setDepth(this.sprite.depth + 50);
    this.sparkGraphics.setAlpha(0);

    // Periodic spark: flash a small star above the agent's head.
    const doSpark = () => {
      if (!this.sparkGraphics) return;
      const x = this.sprite.x;
      const y = this.sprite.y - 36;
      this.sparkGraphics.clear();
      this.sparkGraphics.fillStyle(0xffd54f, 1);
      // 4-pointed star.
      this.drawStar(this.sparkGraphics, x, y, 3, 1.2);
      this.sparkGraphics.setAlpha(1);

      this.scene.tweens.add({
        targets: this.sparkGraphics,
        alpha: 0,
        duration: 800,
        ease: "Sine.Out",
      });
    };

    // Spark immediately, then every 8-12s.
    doSpark();
    this.sparkTimer = this.scene.time.addEvent({
      delay: Phaser.Math.Between(8000, 12000),
      loop: true,
      callback: doSpark,
    });
  }

  // ── Visitor Badge ──────────────────────────────────────────────────

  private createVisitorBadge() {
    this.visitorRing = this.scene.add.graphics();
    this.visitorRing.setDepth(this.sprite.depth - 1);
    this.drawVisitorRing(1.0);

    // Pulsing alpha.
    this.visitorPulseTween = this.scene.tweens.add({
      targets: this.visitorRing,
      alpha: { from: 0.6, to: 0.2 },
      duration: 1200,
      yoyo: true,
      repeat: -1,
      ease: "Sine.InOut",
    });
  }

  private drawVisitorRing(alpha: number) {
    if (!this.visitorRing) return;
    this.visitorRing.clear();
    this.visitorRing.lineStyle(1.5, 0x4fc3f7, alpha);
    this.visitorRing.strokeEllipse(this.sprite.x, this.sprite.y - 10, 22, 34);
  }

  // ── Reflection Crown ───────────────────────────────────────────────

  private createReflectionCrown() {
    this.reflectionStar = this.scene.add.graphics();
    this.reflectionStar.setDepth(this.sprite.depth + 51);
    this.drawReflectionStar();

    // Gentle twinkle.
    this.reflectionTween = this.scene.tweens.add({
      targets: this.reflectionStar,
      alpha: { from: 0.9, to: 0.3 },
      duration: 1800,
      yoyo: true,
      repeat: -1,
      ease: "Sine.InOut",
    });
  }

  private drawReflectionStar() {
    if (!this.reflectionStar) return;
    this.reflectionStar.clear();
    const x = this.sprite.x + 8;
    const y = this.sprite.y - 34;
    this.reflectionStar.fillStyle(0xfff176, 0.9);
    this.drawStar(this.reflectionStar, x, y, 2.5, 1);
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private drawStar(
    g: Phaser.GameObjects.Graphics,
    cx: number,
    cy: number,
    outerR: number,
    innerR: number,
  ) {
    // Simple 4-pointed star (cross pattern).
    g.fillRect(cx - innerR / 2, cy - outerR, innerR, outerR * 2);
    g.fillRect(cx - outerR, cy - innerR / 2, outerR * 2, innerR);
  }

  /** Sync all overlays to the sprite's current position. Call each frame
   *  or in movement tween onUpdate. */
  syncPosition() {
    const x = this.sprite.x;
    const y = this.sprite.y;
    const depth = this.sprite.depth;

    if (this.glow) {
      this.glow.setPosition(x, y + 4);
      this.glow.setDepth(depth - 2);
    }
    if (this.sparkGraphics) {
      // Spark redraws on trigger — just update depth.
      this.sparkGraphics.setDepth(depth + 50);
    }
    if (this.visitorRing) {
      this.visitorRing.clear();
      this.visitorRing.lineStyle(1.5, 0x4fc3f7, this.visitorRing.alpha);
      this.visitorRing.strokeEllipse(x, y - 10, 22, 34);
      this.visitorRing.setDepth(depth - 1);
    }
    if (this.reflectionStar) {
      this.reflectionStar.clear();
      this.reflectionStar.fillStyle(0xfff176, 0.9);
      this.drawStar(this.reflectionStar, x + 8, y - 34, 2.5, 1);
      this.reflectionStar.setDepth(depth + 51);
    }
  }

  destroy() {
    if (this.glow) {
      this.glow.destroy();
      this.glow = null;
    }
    if (this.sparkTimer) {
      this.sparkTimer.remove(false);
      this.sparkTimer = null;
    }
    if (this.sparkGraphics) {
      this.sparkGraphics.destroy();
      this.sparkGraphics = null;
    }
    if (this.visitorRing) {
      this.visitorRing.destroy();
      this.visitorRing = null;
    }
    if (this.visitorPulseTween) {
      this.visitorPulseTween.stop();
      this.visitorPulseTween = null;
    }
    if (this.reflectionStar) {
      this.reflectionStar.destroy();
      this.reflectionStar = null;
    }
    if (this.reflectionTween) {
      this.reflectionTween.stop();
      this.reflectionTween = null;
    }
  }
}
