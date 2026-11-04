// Tween-based animation engine for chibi portrait sprites.
//
// Instead of generating multi-frame spritesheets (which Gemini does
// inconsistently), we apply parametric Phaser tweens to a single
// high-quality portrait: breathing bob, walk bounce, direction lean,
// idle fidget, and a grounding shadow.
//
// PersonalityParams drive the animation curves so each agent feels
// distinct — confident agents stride, shy ones shuffle, energetic
// ones fidget.

import * as Phaser from "phaser";

export type PersonalityParams = {
  /** 0..1 — bob amplitude, walk bounce intensity, fidget speed. */
  energy: number;
  /** 0..1 — idle fidget frequency, wander eagerness. */
  sociability: number;
  /** 0..1 — walk speed multiplier, scale during walk. */
  confidence: number;
  /** Unique idle micro-animation. */
  quirk: "none" | "bounce" | "sway" | "fidget";
};

export const DEFAULT_PERSONALITY: PersonalityParams = {
  energy: 0.5,
  sociability: 0.5,
  confidence: 0.5,
  quirk: "none",
};

// Internal tween keys so we can stop specific tweens without nuking all.
const TWEEN_BREATH = "anim:breath";
const TWEEN_FIDGET = "anim:fidget";
const TWEEN_WALK_BOUNCE = "anim:walkBounce";
const TWEEN_WALK_LEAN = "anim:walkLean";

export class SpriteAnimator {
  private scene: Phaser.Scene;
  private sprite: Phaser.GameObjects.Sprite;
  private params: PersonalityParams;
  private shadow: Phaser.GameObjects.Ellipse | null = null;

  // Base position stored at construction — tweens offset from this.
  private baseY = 0;
  private baseX = 0;

  // Original scale captured after setDisplaySize — tweens must use these
  // as the baseline, NOT 1.0 (sprites are scaled down from source res).
  private origScaleX = 1;
  private origScaleY = 1;

  // Active tween references for cleanup.
  private breathTween: Phaser.Tweens.Tween | null = null;
  private fidgetTimer: Phaser.Time.TimerEvent | null = null;
  private fidgetTween: Phaser.Tweens.Tween | null = null;
  private walkBounceTween: Phaser.Tweens.Tween | null = null;
  private walkLeanTween: Phaser.Tweens.Tween | null = null;

  private isWalking = false;

  constructor(
    scene: Phaser.Scene,
    sprite: Phaser.GameObjects.Sprite,
    params?: Partial<PersonalityParams>,
  ) {
    this.scene = scene;
    this.sprite = sprite;
    this.params = { ...DEFAULT_PERSONALITY, ...params };
    this.baseX = sprite.x;
    this.baseY = sprite.y;
    // Capture scale AFTER setDisplaySize has been called by the caller.
    // For generated sprites (128×256 source, displayed at 16×32) this is ~0.125.
    // For portraits this varies by source image dimensions.
    // Tweens must operate relative to these, NOT relative to 1.0.
    this.origScaleX = sprite.scaleX;
    this.origScaleY = sprite.scaleY;
    this.createShadow();
  }

  // ── Shadow ──────────────────────────────────────────────────────────

  private createShadow() {
    // Small dark ellipse at the sprite's feet for grounding.
    const sw = 14;
    const sh = 5;
    this.shadow = this.scene.add.ellipse(
      this.sprite.x,
      this.sprite.y + 2,
      sw,
      sh,
      0x000000,
      0.18,
    );
    this.shadow.setDepth(this.sprite.depth - 1);
  }

  /** Keep shadow glued to sprite position. Call during movement tweens. */
  syncShadow() {
    if (!this.shadow) return;
    this.shadow.setPosition(this.sprite.x, this.baseY + 2);
    this.shadow.setDepth(this.sprite.depth - 1);
  }

  // ── Idle ────────────────────────────────────────────────────────────

  /** Start idle animation: gentle breathing bob + optional fidget. */
  idle() {
    this.isWalking = false;
    this.stopWalkTweens();
    // Reset lean.
    this.sprite.setAngle(0);
    this.startBreathing();
    this.startFidget();
  }

  private startBreathing() {
    this.stopBreathing();
    // Amplitude: 1px (calm) to 3px (energetic).
    const amplitude = 1 + this.params.energy * 2;
    // Period: 4000ms (calm) to 2000ms (energetic).
    const period = 4000 - this.params.energy * 2000;

    this.breathTween = this.scene.tweens.add({
      targets: this.sprite,
      y: this.baseY - amplitude,
      duration: period / 2,
      yoyo: true,
      repeat: -1,
      ease: "Sine.InOut",
      onUpdate: () => this.syncShadow(),
    });
  }

  private stopBreathing() {
    if (this.breathTween) {
      this.breathTween.stop();
      this.breathTween = null;
    }
  }

  private startFidget() {
    this.stopFidget();
    if (this.params.quirk === "none" && this.params.energy < 0.4) return;

    // Interval: 3s (high energy) to 8s (low energy).
    const minInterval = 3000;
    const maxInterval = 8000;
    const interval =
      maxInterval - this.params.energy * (maxInterval - minInterval);

    this.fidgetTimer = this.scene.time.addEvent({
      delay: interval,
      loop: true,
      callback: () => this.doFidget(),
    });
  }

  private doFidget() {
    if (this.isWalking) return;
    if (this.fidgetTween) {
      this.fidgetTween.stop();
      this.fidgetTween = null;
    }

    const quirk = this.params.quirk;
    if (quirk === "sway" || quirk === "none") {
      // Horizontal sway.
      this.fidgetTween = this.scene.tweens.add({
        targets: this.sprite,
        x: this.baseX + 2,
        duration: 100,
        yoyo: true,
        repeat: 1,
        ease: "Sine.InOut",
        onComplete: () => {
          this.sprite.x = this.baseX;
          this.syncShadow();
        },
      });
    } else if (quirk === "bounce") {
      // Quick vertical bounce.
      this.fidgetTween = this.scene.tweens.add({
        targets: this.sprite,
        y: this.baseY - 4,
        duration: 120,
        yoyo: true,
        ease: "Quad.Out",
        onComplete: () => this.syncShadow(),
      });
    } else if (quirk === "fidget") {
      // Tiny angle wobble (looking around).
      this.fidgetTween = this.scene.tweens.add({
        targets: this.sprite,
        angle: 3,
        duration: 150,
        yoyo: true,
        repeat: 1,
        ease: "Sine.InOut",
        onComplete: () => {
          this.sprite.setAngle(0);
        },
      });
    }
  }

  private stopFidget() {
    if (this.fidgetTimer) {
      this.fidgetTimer.remove(false);
      this.fidgetTimer = null;
    }
    if (this.fidgetTween) {
      this.fidgetTween.stop();
      this.fidgetTween = null;
    }
  }

  // ── Walk ────────────────────────────────────────────────────────────

  /**
   * Start walk animation overlays. Called at the start of a wander tween.
   * `dx`/`dy` are tile deltas (e.g. 1,0 for right). `durationMs` is the
   * walk tween length so the bounce cycles fit inside it.
   */
  walk(dx: number, dy: number, durationMs: number) {
    this.isWalking = true;
    this.stopBreathing();
    this.stopFidget();
    this.startWalkBounce(durationMs);
    this.startWalkLean(dx, dy, durationMs);
  }

  private startWalkBounce(durationMs: number) {
    this.stopWalkTweens();

    // Squash/stretch: 0.95..1.05 for default, wider for confident agents.
    const intensity = 0.03 + this.params.confidence * 0.04;
    const cycleMs = durationMs / 2; // Two bounce cycles per walk.

    this.walkBounceTween = this.scene.tweens.add({
      targets: this.sprite,
      scaleY: { from: this.origScaleY, to: this.origScaleY * (1.0 + intensity) },
      duration: cycleMs / 2,
      yoyo: true,
      repeat: 3, // 4 half-cycles = 2 full bounces
      ease: "Sine.InOut",
    });
  }

  private startWalkLean(dx: number, dy: number, durationMs: number) {
    if (this.walkLeanTween) {
      this.walkLeanTween.stop();
      this.walkLeanTween = null;
    }

    // Lean 2-5° toward movement direction.
    const maxLean = 2 + this.params.confidence * 3;
    let targetAngle = 0;
    if (dx > 0) targetAngle = maxLean;
    else if (dx < 0) targetAngle = -maxLean;
    else if (dy > 0) targetAngle = maxLean * 0.3;
    else if (dy < 0) targetAngle = -maxLean * 0.3;

    this.walkLeanTween = this.scene.tweens.add({
      targets: this.sprite,
      angle: targetAngle,
      duration: 120,
      ease: "Sine.Out",
    });
  }

  /** Stop walk-specific tweens. Called when walk finishes or idle starts. */
  private stopWalkTweens() {
    if (this.walkBounceTween) {
      this.walkBounceTween.stop();
      this.walkBounceTween = null;
    }
    if (this.walkLeanTween) {
      this.walkLeanTween.stop();
      this.walkLeanTween = null;
    }
    // Reset transforms to the original display scale (NOT 1.0 — sprites
    // are scaled down from source resolution via setDisplaySize).
    this.sprite.setScale(this.origScaleX, this.origScaleY);
    this.sprite.setAngle(0);
  }

  /** Called when the walk tween completes. Transitions back to idle. */
  walkComplete() {
    this.stopWalkTweens();
    this.idle();
  }

  // ── Emote ───────────────────────────────────────────────────────────

  emote(type: "wave" | "nod" | "bounce") {
    // Quick expressive animation. Does not interrupt idle loop — runs
    // on top then idle resumes naturally.
    const intensity = 0.5 + this.params.energy * 0.5;

    if (type === "bounce") {
      this.scene.tweens.add({
        targets: this.sprite,
        y: this.baseY - 6 * intensity,
        duration: 150,
        yoyo: true,
        repeat: 2,
        ease: "Quad.Out",
        onComplete: () => this.syncShadow(),
      });
    } else if (type === "wave") {
      this.scene.tweens.add({
        targets: this.sprite,
        angle: { from: -8 * intensity, to: 8 * intensity },
        duration: 200,
        yoyo: true,
        repeat: 2,
        ease: "Sine.InOut",
        onComplete: () => this.sprite.setAngle(0),
      });
    } else if (type === "nod") {
      this.scene.tweens.add({
        targets: this.sprite,
        y: this.baseY + 2 * intensity,
        duration: 180,
        yoyo: true,
        repeat: 1,
        ease: "Sine.InOut",
        onComplete: () => this.syncShadow(),
      });
    }
  }

  // ── Position sync ───────────────────────────────────────────────────

  /** Update base position. Call when the sprite's world position changes
   *  (after a wander tween updates sprite.x/y). */
  updateBase(x: number, y: number) {
    this.baseX = x;
    this.baseY = y;
    this.syncShadow();
  }

  /** Update personality params (e.g. when API data arrives late). */
  updatePersonality(params: Partial<PersonalityParams>) {
    this.params = { ...this.params, ...params };
    // Restart idle to pick up new params if currently idling.
    if (!this.isWalking) {
      this.idle();
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────

  destroy() {
    this.stopBreathing();
    this.stopFidget();
    this.stopWalkTweens();
    if (this.shadow) {
      this.shadow.destroy();
      this.shadow = null;
    }
  }
}
