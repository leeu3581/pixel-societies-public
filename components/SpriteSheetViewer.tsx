"use client";

// Visual sprite sheet viewer — shows the agent's portrait and/or
// spritesheet frames in a labeled grid, similar to a traditional
// game-dev spritesheet inspector. Entry point for the sprite editor.

import { useState } from "react";
import SpriteEditor from "@/components/SpriteEditor";

type Props = {
  agentId: string;
  displayName: string;
  portraitUrl: string | null;
  spriteSheetUrl: string | null;
  spriteUrl: string | null;
  onClose: () => void;
  onUpdated?: () => void;
};

// Row definitions for the 7×4 generated spritesheet layout.
const SHEET_ROWS = [
  { label: "IDLE POSES", row: 0, count: 7 },
  { label: "WALKING RIGHT", row: 1, count: 4 },
  { label: "WALKING LEFT", row: 2, count: 4 },
  { label: "EMOTES", row: 3, count: 4 },
];

const COLS = 7;
const FRAME_W = 128;
const FRAME_H = 256;

// Checkerboard pattern for transparency indication.
const CHECKER_BG =
  "repeating-conic-gradient(#2a3344 0% 25%, #222b3a 0% 50%) 0 0 / 12px 12px";

export default function SpriteSheetViewer({
  agentId,
  displayName,
  portraitUrl,
  spriteSheetUrl,
  spriteUrl,
  onClose,
  onUpdated,
}: Props) {
  const [editing, setEditing] = useState(false);
  const hasSheet = !!spriteSheetUrl;
  const hasPortrait = !!portraitUrl;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(12, 22, 38, 0.85)",
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(4px)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "#1a2236",
          border: "1px solid #2a3a52",
          borderRadius: 10,
          padding: 20,
          maxWidth: 520,
          width: "90vw",
          maxHeight: "85vh",
          overflowY: "auto",
          fontFamily: "monospace",
          color: "#fffaf0",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{displayName}</div>
            <div style={{ fontSize: 11, color: "#8899aa" }}>Sprite Sheet</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => setEditing(!editing)}
              style={{
                padding: "5px 12px",
                background: editing ? "#3a6a9a" : "#2a3a52",
                color: "#fffaf0",
                border: `1px solid ${editing ? "#5a8aba" : "#3a4a62"}`,
                borderRadius: 5,
                cursor: "pointer",
                fontFamily: "monospace",
                fontSize: 12,
              }}
            >
              {editing ? "Back to Sheet" : "Edit Sprite"}
            </button>
            <button
              onClick={onClose}
              style={{
                padding: "5px 10px",
                background: "none",
                color: "#8899aa",
                border: "none",
                cursor: "pointer",
                fontSize: 18,
                fontFamily: "monospace",
              }}
            >
              ×
            </button>
          </div>
        </div>

        {editing ? (
          <SpriteEditor
            agentId={agentId}
            portraitUrl={portraitUrl}
            onUpdated={onUpdated}
            onClose={() => setEditing(false)}
          />
        ) : (
          <>
            {/* Portrait section */}
            {hasPortrait && (
              <Section label="PORTRAIT">
                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "flex-end",
                  }}
                >
                  <FrameBox>
                    <img
                      src={portraitUrl!}
                      alt="Portrait"
                      style={{
                        width: 72,
                        height: 96,
                        imageRendering: "pixelated",
                        objectFit: "contain",
                      }}
                    />
                  </FrameBox>
                  {/* Show a few scaled versions */}
                  <FrameBox>
                    <img
                      src={portraitUrl!}
                      alt="Portrait 2x"
                      style={{
                        width: 48,
                        height: 64,
                        imageRendering: "pixelated",
                        objectFit: "contain",
                      }}
                    />
                  </FrameBox>
                  <FrameBox>
                    <img
                      src={portraitUrl!}
                      alt="Portrait 1x"
                      style={{
                        width: 24,
                        height: 32,
                        imageRendering: "pixelated",
                        objectFit: "contain",
                      }}
                    />
                  </FrameBox>
                  <div
                    style={{
                      fontSize: 10,
                      color: "#667788",
                      alignSelf: "center",
                      marginLeft: 4,
                    }}
                  >
                    3× 2× 1×
                  </div>
                </div>
              </Section>
            )}

            {/* Spritesheet frames */}
            {hasSheet ? (
              SHEET_ROWS.map(({ label, row, count }) => (
                <Section key={label} label={label}>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {Array.from({ length: count }, (_, col) => (
                      <FrameBox key={col}>
                        <div
                          style={{
                            width: 48,
                            height: 64,
                            backgroundImage: `url(${spriteSheetUrl})`,
                            backgroundSize: `${COLS * 48}px ${4 * 64}px`,
                            backgroundPosition: `-${col * 48}px -${row * 64}px`,
                            backgroundRepeat: "no-repeat",
                            imageRendering: "pixelated",
                          }}
                        />
                      </FrameBox>
                    ))}
                  </div>
                </Section>
              ))
            ) : hasPortrait ? (
              // Portrait-only: show animation preview info
              <Section label="ANIMATION">
                <div
                  style={{
                    padding: 12,
                    background: "#0c1626",
                    borderRadius: 6,
                    fontSize: 11,
                    color: "#8899aa",
                    lineHeight: 1.6,
                  }}
                >
                  This agent uses <strong style={{ color: "#fffaf0" }}>programmatic animation</strong> on the portrait:
                  <ul style={{ margin: "8px 0 0 16px", padding: 0 }}>
                    <li>Idle: breathing bob + personality fidget</li>
                    <li>Walk: bounce + direction lean</li>
                    <li>Emote: wave, nod, bounce reactions</li>
                  </ul>
                  <div style={{ marginTop: 8, color: "#667788" }}>
                    No spritesheet generated yet. The portrait animates via Phaser tweens.
                  </div>
                </div>
              </Section>
            ) : (
              // Placeholder sprite — show the bundled sheet
              <Section label="PLACEHOLDER">
                <div
                  style={{
                    padding: 12,
                    background: "#0c1626",
                    borderRadius: 6,
                    fontSize: 11,
                    color: "#8899aa",
                  }}
                >
                  Using bundled placeholder sprite. Upload a photo to generate a
                  custom portrait.
                </div>
              </Section>
            )}

            {/* Legacy sprite_url sheet (if present and different from spriteSheetUrl) */}
            {spriteUrl && spriteUrl !== spriteSheetUrl && (
              <Section label="LEGACY SHEET">
                <FrameBox>
                  <img
                    src={spriteUrl}
                    alt="Legacy sprite"
                    style={{
                      maxWidth: "100%",
                      height: "auto",
                      maxHeight: 120,
                      imageRendering: "pixelated",
                    }}
                  />
                </FrameBox>
              </Section>
            )}

            {/* Metadata footer */}
            <div
              style={{
                marginTop: 16,
                paddingTop: 12,
                borderTop: "1px solid #2a3a52",
                display: "flex",
                gap: 16,
                fontSize: 10,
                color: "#556677",
              }}
            >
              <span>
                portrait:{" "}
                <span style={{ color: hasPortrait ? "#66cc88" : "#ff6666" }}>
                  {hasPortrait ? "yes" : "no"}
                </span>
              </span>
              <span>
                sheet:{" "}
                <span style={{ color: hasSheet ? "#66cc88" : "#ff6666" }}>
                  {hasSheet ? "7×4 (128×256)" : "no"}
                </span>
              </span>
              <span>
                anim:{" "}
                <span style={{ color: "#66cc88" }}>
                  tween
                </span>
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          fontSize: 10,
          color: "#667788",
          textTransform: "uppercase",
          letterSpacing: 1.5,
          marginBottom: 6,
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function FrameBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: CHECKER_BG,
        borderRadius: 4,
        border: "1px solid #2a3a52",
        padding: 4,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </div>
  );
}
