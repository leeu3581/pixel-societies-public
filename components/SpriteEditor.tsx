"use client";

// Sprite appearance editor — lets users modify their agent's portrait
// by selecting presets (glasses, hair, outfit) or typing custom edits.
// Each edit re-generates the portrait via Gemini (~$0.02, ~10s).

import { useState, useCallback } from "react";
import { apiPost, apiGet } from "@/lib/api";

type Props = {
  agentId: string;
  portraitUrl: string | null;
  onUpdated?: () => void;
  onClose: () => void;
};

type EditCategory = {
  label: string;
  options: string[];
};

const EDIT_CATEGORIES: EditCategory[] = [
  {
    label: "Accessories",
    options: [
      "add round glasses",
      "add sunglasses",
      "add a hat",
      "add earrings",
      "add a scarf",
      "remove glasses",
      "remove hat",
    ],
  },
  {
    label: "Hair",
    options: [
      "change to short hair",
      "change to long hair",
      "change to curly hair",
      "change to straight hair",
      "change hair to black",
      "change hair to brown",
      "change hair to blonde",
      "change hair to red",
      "change hair to blue",
      "change hair to pink",
    ],
  },
  {
    label: "Outfit",
    options: [
      "change to casual outfit",
      "change to formal suit",
      "change to hoodie",
      "change to t-shirt",
      "change outfit to red",
      "change outfit to blue",
      "change outfit to black",
      "change outfit to white",
    ],
  },
];

export default function SpriteEditor({
  agentId,
  portraitUrl,
  onUpdated,
  onClose,
}: Props) {
  const [pendingEdits, setPendingEdits] = useState<string[]>([]);
  const [customEdit, setCustomEdit] = useState("");
  const [status, setStatus] = useState<"idle" | "generating" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const addEdit = useCallback((edit: string) => {
    setPendingEdits((prev) =>
      prev.includes(edit) ? prev.filter((e) => e !== edit) : [...prev, edit],
    );
  }, []);

  const addCustomEdit = useCallback(() => {
    const trimmed = customEdit.trim();
    if (trimmed && !pendingEdits.includes(trimmed)) {
      setPendingEdits((prev) => [...prev, trimmed]);
      setCustomEdit("");
    }
  }, [customEdit, pendingEdits]);

  const applyEdits = useCallback(async () => {
    if (pendingEdits.length === 0) return;
    setStatus("generating");
    setError(null);

    try {
      await apiPost(`/api/sprites/${encodeURIComponent(agentId)}/edit`, {
        edits: pendingEdits,
      });

      // Poll for completion (reuse the existing status endpoint pattern).
      let elapsed = 0;
      const interval = 3000;
      const maxWait = 60000;

      const poll = async (): Promise<void> => {
        if (elapsed >= maxWait) {
          setStatus("error");
          setError("Timed out waiting for edit to complete.");
          return;
        }
        await new Promise((r) => setTimeout(r, interval));
        elapsed += interval;

        try {
          const res = await apiGet<{
            status: string;
            portrait_url: string | null;
            error: string | null;
          }>(`/api/sprites/${encodeURIComponent(agentId)}/status`);

          if (res.portrait_url && res.status === "ready") {
            setStatus("done");
            setPendingEdits([]);
            onUpdated?.();
            return;
          }
          if (res.status === "failed") {
            setStatus("error");
            setError(res.error || "Edit generation failed.");
            return;
          }
        } catch {
          // Keep polling on transient errors.
        }
        return poll();
      };

      await poll();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Request failed.");
    }
  }, [agentId, pendingEdits, onUpdated]);

  if (!portraitUrl) {
    return (
      <div
        style={{
          padding: 16,
          background: "#1f2a3c",
          borderRadius: 8,
          color: "#fffaf0",
          fontFamily: "monospace",
          fontSize: 13,
        }}
      >
        <p>No portrait to edit. Generate a sprite first.</p>
        <button
          onClick={onClose}
          style={{
            marginTop: 8,
            padding: "4px 12px",
            background: "#2a3a52",
            color: "#fffaf0",
            border: "1px solid #3a4a62",
            borderRadius: 4,
            cursor: "pointer",
            fontFamily: "monospace",
          }}
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: 16,
        background: "#1f2a3c",
        borderRadius: 8,
        color: "#fffaf0",
        fontFamily: "monospace",
        fontSize: 12,
        maxWidth: 340,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 14 }}>Edit Sprite</span>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "#8899aa",
            cursor: "pointer",
            fontSize: 16,
            fontFamily: "monospace",
          }}
        >
          x
        </button>
      </div>

      {/* Current portrait preview */}
      <div style={{ textAlign: "center", marginBottom: 12 }}>
        <img
          src={portraitUrl}
          alt="Current sprite"
          style={{
            width: 64,
            height: 85,
            imageRendering: "pixelated",
            borderRadius: 4,
            background: "#0c1626",
          }}
        />
      </div>

      {/* Preset categories */}
      {EDIT_CATEGORIES.map((cat) => (
        <div key={cat.label} style={{ marginBottom: 10 }}>
          <div
            style={{
              fontSize: 11,
              color: "#8899aa",
              marginBottom: 4,
              textTransform: "uppercase",
              letterSpacing: 1,
            }}
          >
            {cat.label}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {cat.options.map((opt) => {
              const selected = pendingEdits.includes(opt);
              return (
                <button
                  key={opt}
                  onClick={() => addEdit(opt)}
                  disabled={status === "generating"}
                  style={{
                    padding: "3px 8px",
                    background: selected ? "#3a6a9a" : "#2a3a52",
                    color: selected ? "#fff" : "#bbb",
                    border: selected
                      ? "1px solid #5a8aba"
                      : "1px solid #3a4a62",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: 11,
                    fontFamily: "monospace",
                    opacity: status === "generating" ? 0.5 : 1,
                  }}
                >
                  {opt.replace(/^(add |change |remove )/, "")}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {/* Custom edit input */}
      <div style={{ marginBottom: 12 }}>
        <div
          style={{
            fontSize: 11,
            color: "#8899aa",
            marginBottom: 4,
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          Custom
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <input
            type="text"
            value={customEdit}
            onChange={(e) => setCustomEdit(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addCustomEdit()}
            placeholder="e.g. add a coffee cup"
            disabled={status === "generating"}
            style={{
              flex: 1,
              padding: "4px 8px",
              background: "#0c1626",
              color: "#fffaf0",
              border: "1px solid #3a4a62",
              borderRadius: 4,
              fontSize: 11,
              fontFamily: "monospace",
            }}
          />
          <button
            onClick={addCustomEdit}
            disabled={!customEdit.trim() || status === "generating"}
            style={{
              padding: "4px 8px",
              background: "#2a3a52",
              color: "#fffaf0",
              border: "1px solid #3a4a62",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 11,
              fontFamily: "monospace",
            }}
          >
            +
          </button>
        </div>
      </div>

      {/* Pending edits summary */}
      {pendingEdits.length > 0 && (
        <div
          style={{
            marginBottom: 12,
            padding: 8,
            background: "#0c1626",
            borderRadius: 4,
            fontSize: 11,
          }}
        >
          <strong>Pending:</strong>{" "}
          {pendingEdits.map((e, i) => (
            <span key={e}>
              {e}
              <button
                onClick={() =>
                  setPendingEdits((prev) => prev.filter((_, j) => j !== i))
                }
                style={{
                  background: "none",
                  border: "none",
                  color: "#ff6666",
                  cursor: "pointer",
                  fontSize: 10,
                  padding: "0 2px",
                  fontFamily: "monospace",
                }}
              >
                x
              </button>
              {i < pendingEdits.length - 1 ? ", " : ""}
            </span>
          ))}
        </div>
      )}

      {/* Status + action */}
      {error && (
        <div
          style={{
            marginBottom: 8,
            color: "#ff6666",
            fontSize: 11,
          }}
        >
          {error}
        </div>
      )}

      {status === "done" && (
        <div
          style={{
            marginBottom: 8,
            color: "#66cc88",
            fontSize: 11,
          }}
        >
          Portrait updated! Refresh the world to see changes.
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={applyEdits}
          disabled={pendingEdits.length === 0 || status === "generating"}
          style={{
            flex: 1,
            padding: "6px 12px",
            background:
              pendingEdits.length > 0 && status !== "generating"
                ? "#3a6a9a"
                : "#2a3a52",
            color: "#fffaf0",
            border: "1px solid #5a8aba",
            borderRadius: 4,
            cursor:
              pendingEdits.length > 0 && status !== "generating"
                ? "pointer"
                : "default",
            fontFamily: "monospace",
            fontSize: 12,
            opacity: status === "generating" ? 0.6 : 1,
          }}
        >
          {status === "generating" ? "Generating..." : "Apply Edits"}
        </button>
        <button
          onClick={onClose}
          style={{
            padding: "6px 12px",
            background: "#2a3a52",
            color: "#fffaf0",
            border: "1px solid #3a4a62",
            borderRadius: 4,
            cursor: "pointer",
            fontFamily: "monospace",
            fontSize: 12,
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}
