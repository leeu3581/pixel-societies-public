"use client";

import { useEffect, useRef } from "react";

/* ── Sprite layout ──────────────────────────────────────────
   Each char_N.png is 112×96: 7 columns (16 px) × 3 rows (32 px).
   Row 0 = walk-down frames, Row 1 = walk-left, Row 2 = walk-right.
   We use 4 frames per walk cycle (cols 0-3). */
const FRAME_W = 16;
const FRAME_H = 32;
const SCALE = 1.8; // render size = ~29×58
const DRAW_W = FRAME_W * SCALE;
const DRAW_H = FRAME_H * SCALE;

const CHAT_LINES = [
  "Have you seen the new world?",
  "My portrait keeps posting memes...",
  "I just ingested my professor lol",
  "The reflections are so accurate",
  "Wait, your agent said WHAT?",
  "This is like Hogwarts but pixel",
  "I love visiting your gallery!",
  "My agents are arguing again",
  "The idle gate saved me $$$",
  "Who taught my portrait sarcasm?",
  "Check out my inner thoughts panel",
  "Your crew is way more chill than mine",
  "I can't stop running ticks",
  "The WhatsApp ingest is wild",
  "Do your portraits post at night?",
  "Mine just wrote a haiku...",
];

interface Agent {
  spriteIdx: number;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  frame: number;
  row: number; // 0=down 1=left 2=right
  frameTimer: number;
  moveTimer: number;
  bubble: string | null;
  bubbleTimer: number;
  chatCooldown: number;
}

function pickTarget(canvasW: number, canvasH: number) {
  return {
    targetX: 40 + Math.random() * (canvasW - 80),
    targetY: 40 + Math.random() * (canvasH - 80),
  };
}

export default function LoginBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Load map
    const mapImg = new Image();
    mapImg.src = "/maps/ucl-ai-festival-office.png";

    // Load 6 character sprites
    const sprites: HTMLImageElement[] = [];
    for (let i = 0; i < 6; i++) {
      const img = new Image();
      img.src = `/characters/char_${i}.png`;
      sprites.push(img);
    }

    // Resize canvas to fill viewport
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    // Create agents scattered across canvas
    const agents: Agent[] = [];
    for (let i = 0; i < 8; i++) {
      const x = 60 + Math.random() * (canvas.width - 120);
      const y = 60 + Math.random() * (canvas.height - 120);
      agents.push({
        spriteIdx: i % 6,
        x,
        y,
        ...pickTarget(canvas.width, canvas.height),
        frame: Math.floor(Math.random() * 4),
        row: 0,
        frameTimer: 0,
        moveTimer: 0,
        bubble: null,
        bubbleTimer: 0,
        chatCooldown: 2000 + Math.random() * 6000,
      });
    }

    let lastTime = performance.now();
    let animId = 0;

    const loop = (now: number) => {
      const dt = now - lastTime;
      lastTime = now;
      const cw = canvas.width;
      const ch = canvas.height;

      // Clear + draw map
      ctx.clearRect(0, 0, cw, ch);
      if (mapImg.complete && mapImg.naturalWidth) {
        // Cover the canvas with the map
        const mapAspect = mapImg.naturalWidth / mapImg.naturalHeight;
        const canvasAspect = cw / ch;
        let drawW: number, drawH: number, drawX: number, drawY: number;
        if (canvasAspect > mapAspect) {
          drawW = cw;
          drawH = cw / mapAspect;
          drawX = 0;
          drawY = (ch - drawH) / 2;
        } else {
          drawH = ch;
          drawW = ch * mapAspect;
          drawX = (cw - drawW) / 2;
          drawY = 0;
        }
        ctx.drawImage(mapImg, drawX, drawY, drawW, drawH);
      }

      // ── Update agent state + draw sprites (BELOW overlay) ──
      ctx.imageSmoothingEnabled = false;

      for (const agent of agents) {
        // Move toward target
        const dx = agent.targetX - agent.x;
        const dy = agent.targetY - agent.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const speed = 0.03; // px per ms

        if (dist > 3) {
          agent.x += (dx / dist) * speed * dt;
          agent.y += (dy / dist) * speed * dt;

          if (Math.abs(dx) > Math.abs(dy)) {
            agent.row = dx < 0 ? 1 : 2;
          } else {
            agent.row = 0;
          }

          agent.frameTimer += dt;
          if (agent.frameTimer > 180) {
            agent.frameTimer = 0;
            agent.frame = (agent.frame + 1) % 4;
          }
        } else {
          agent.frame = 0;
          agent.moveTimer += dt;
          if (agent.moveTimer > 2000 + Math.random() * 3000) {
            agent.moveTimer = 0;
            Object.assign(agent, pickTarget(cw, ch));
          }
        }

        // Bubble timers
        if (agent.bubble) {
          agent.bubbleTimer -= dt;
          if (agent.bubbleTimer <= 0) {
            agent.bubble = null;
            agent.chatCooldown = 4000 + Math.random() * 8000;
          }
        } else {
          agent.chatCooldown -= dt;
          if (agent.chatCooldown <= 0) {
            agent.bubble = CHAT_LINES[Math.floor(Math.random() * CHAT_LINES.length)];
            agent.bubbleTimer = 3000 + Math.random() * 2000;
          }
        }

        // Draw sprite
        const spr = sprites[agent.spriteIdx];
        if (spr.complete && spr.naturalWidth) {
          const sx = agent.frame * FRAME_W;
          const sy = agent.row * FRAME_H;
          ctx.drawImage(
            spr,
            sx, sy, FRAME_W, FRAME_H,
            agent.x - DRAW_W / 2, agent.y - DRAW_H, DRAW_W, DRAW_H,
          );
        }
      }

      // ── Dark overlay ON TOP of map + characters ──
      ctx.fillStyle = "rgba(12, 18, 27, 0.58)";
      ctx.fillRect(0, 0, cw, ch);

      // ── Draw chat bubbles ABOVE the overlay ──
      for (const agent of agents) {
        if (!agent.bubble) continue;
        const text = agent.bubble;
        ctx.font = "bold 9px monospace";
        const metrics = ctx.measureText(text);
        const pad = 6;
        const bw = Math.min(metrics.width + pad * 2, 160);
        const bh = 22;
        const bx = agent.x - bw / 2;
        const by = agent.y - DRAW_H - bh - 6;

        const alpha = Math.min(1, agent.bubbleTimer / 500);

        ctx.globalAlpha = alpha * 0.95;
        ctx.fillStyle = "#f9fafb";
        ctx.strokeStyle = "#1f2a3c";
        ctx.lineWidth = 2;

        // Rounded rect
        const r = 6;
        ctx.beginPath();
        ctx.moveTo(bx + r, by);
        ctx.lineTo(bx + bw - r, by);
        ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
        ctx.lineTo(bx + bw, by + bh - r);
        ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
        ctx.lineTo(bx + r, by + bh);
        ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
        ctx.lineTo(bx, by + r);
        ctx.quadraticCurveTo(bx, by, bx + r, by);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Tail triangle
        ctx.beginPath();
        ctx.moveTo(agent.x - 4, by + bh);
        ctx.lineTo(agent.x, by + bh + 6);
        ctx.lineTo(agent.x + 4, by + bh);
        ctx.closePath();
        ctx.fillStyle = "#f9fafb";
        ctx.fill();
        ctx.stroke();
        ctx.fillRect(agent.x - 5, by + bh - 1, 10, 2);

        // Text
        ctx.fillStyle = "#1f2a3c";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, agent.x, by + bh / 2, bw - pad * 2);

        ctx.globalAlpha = 1;
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";
      }

      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 z-0"
      style={{ display: "block" }}
      aria-hidden="true"
    />
  );
}
