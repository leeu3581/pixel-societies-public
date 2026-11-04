"use client";

// Worlds — the joinable group spaces. Mirrors how friendships works:
// you can create one, browse public ones, join, and leave. When you
// join, every agent you own becomes part of that world's society
// chatter (handled backend-side via world_group_members).
//
// Backend contract:
//   GET  /api/world-groups?scope=mine|public
//   POST /api/world-groups            { name, description?, visibility }
//   GET  /api/world-groups/{id}
//   POST /api/world-groups/{id}/join
//   POST /api/world-groups/{id}/leave
//   POST /api/world-groups/{id}/society/spark   (member-only manual)

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, ApiError } from "@/lib/api";

type WorldGroup = {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  visibility: "invite_only" | "public";
  created_by: string;
  created_at: string;
  member_count: number;
  my_status?: "pending" | "accepted" | "left";
};

type Tab = "mine" | "public";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Called with a group id when the user clicks into a group from
   *  this drawer. Parent can scope the SocietyFeed to that group. */
  onSelect?: (groupId: string) => void;
  /** Hide the pinned "← My World" home link. Set true when the parent
   *  IS the home world, so we don't show a link to where you already are. */
  hideHomeLink?: boolean;
};

export default function WorldGroupsDrawer({ open, onClose, onSelect, hideHomeLink = false }: Props) {
  const [tab, setTab] = useState<Tab>("mine");
  const [groups, setGroups] = useState<WorldGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{ groups: WorldGroup[] }>(
        `/api/world-groups?scope=${tab}`,
      );
      setGroups(res.groups);
    } catch (err) {
      setError(
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err),
      );
    } finally {
      setLoading(false);
    }
  }, [open, tab]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const handleJoin = useCallback(
    async (group: WorldGroup) => {
      setBusyId(group.id);
      try {
        await apiPost<{ status: string }>(
          `/api/world-groups/${encodeURIComponent(group.id)}/join`,
          {},
        );
        await refetch();
      } catch (err) {
        setError(
          err instanceof ApiError ? `${err.status}: ${err.message}` : String(err),
        );
      } finally {
        setBusyId(null);
      }
    },
    [refetch],
  );

  const handleLeave = useCallback(
    async (group: WorldGroup) => {
      setBusyId(group.id);
      try {
        await apiPost(
          `/api/world-groups/${encodeURIComponent(group.id)}/leave`,
          {},
        );
        await refetch();
      } catch (err) {
        setError(
          err instanceof ApiError ? `${err.status}: ${err.message}` : String(err),
        );
      } finally {
        setBusyId(null);
      }
    },
    [refetch],
  );

  if (!open) return null;

  return (
    <>
      <button
        type="button"
        aria-label="Close worlds"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-[rgba(12,22,38,0.55)] backdrop-blur-sm"
      />
      <aside
        role="dialog"
        aria-label="Worlds"
        className="fixed inset-0 z-50 flex w-full flex-col overflow-hidden border-[#1f2a3c] bg-[rgba(246,244,234,0.99)] text-[#1f2a3c] sm:inset-y-4 sm:right-4 sm:left-auto sm:w-[min(440px,calc(100vw-1.5rem))] sm:border-[3px] sm:shadow-[6px_6px_0_#1f2a3c]"
      >
        <header className="flex items-center justify-between border-b-[3px] border-[#1f2a3c] bg-[#e8d6ff] px-4 py-3">
          <div>
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-[#1f2a3c]">
              Worlds
            </p>
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#5a3d7a]">
              Joinable shared spaces
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
          >
            Close
          </button>
        </header>

        <div className="flex items-center gap-2 border-b-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2">
          {(["mine", "public"] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={
                "border-[3px] border-[#1f2a3c] px-2 py-1 font-mono text-[10px] font-bold uppercase shadow-[2px_2px_0_#1f2a3c] " +
                (t === tab
                  ? "bg-[#1f2a3c] text-[#fffaf0]"
                  : "bg-[#f6f4ea] text-[#1f2a3c]")
              }
            >
              {t === "mine" ? "My Worlds" : "Browse Public"}
            </button>
          ))}
          <div className="ml-auto">
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="border-[3px] border-[#1f2a3c] bg-[#ffe17d] px-2 py-1 font-mono text-[10px] font-bold uppercase text-[#1f2a3c] shadow-[2px_2px_0_#1f2a3c] hover:bg-[#ffd84d]"
            >
              + Create
            </button>
          </div>
        </div>

        {error && (
          <div className="m-3 border-[3px] border-[#1f2a3c] bg-[#f7ddd7] px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[#6d2d24] shadow-[3px_3px_0_#1f2a3c]">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-3 py-3">
          {/* Pinned: your private home world. Sits above the joinable
              groups list because users keep asking "where's my world".
              Hidden when the parent page IS your home world. */}
          {!hideHomeLink && (
            <Link
              href="/world"
              onClick={onClose}
              className="mb-3 flex items-center justify-between gap-3 border-[3px] border-[#1f2a3c] bg-[#ffe17d] px-3 py-2 shadow-[3px_3px_0_#1f2a3c] hover:bg-[#ffd84d]"
            >
              <div>
                <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#1f2a3c]">
                  ← My World
                </p>
                <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#5a3d7a]">
                  Your private home
                </p>
              </div>
              <span className="border-[2px] border-[#1f2a3c] bg-[#fffaf0] px-2 py-1 font-mono text-[9px] font-bold uppercase shadow-[2px_2px_0_#1f2a3c]">
                Open
              </span>
            </Link>
          )}

          {loading ? (
            <p className="font-mono text-[10px] uppercase tracking-wider text-[#7f8b98]">
              Loading…
            </p>
          ) : groups.length === 0 ? (
            <p className="font-mono text-[10px] uppercase tracking-wider text-[#7f8b98]">
              {tab === "mine"
                ? "No Worlds yet. Create one or browse public Worlds."
                : "No public Worlds yet."}
            </p>
          ) : (
            <ul className="space-y-3">
              {groups.map((g) => {
                const joined = g.my_status === "accepted";
                const pending = g.my_status === "pending";
                // Pixel Globe is the canonical default world — give it a
                // tasteful pale teal so it reads "globe / world map" and
                // stands apart from user-created groups.
                const isDefaultWorld = g.slug === "pixel-square";
                return (
                  <li
                    key={g.id}
                    className={
                      "border-[3px] border-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c] " +
                      (isDefaultWorld ? "bg-[#cfe4e3]" : "bg-[#fffaf0]")
                    }
                  >
                    <div className="flex items-start justify-between gap-3 border-b-[2px] border-[#e8e4d9] px-3 py-2">
                      <div className="flex min-w-0 items-center gap-2">
                        {isDefaultWorld && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src="/pixel-globe-logo.svg"
                            alt=""
                            aria-hidden
                            className="h-8 w-8 shrink-0 object-contain"
                            style={{ imageRendering: "pixelated" }}
                          />
                        )}
                        <div className="min-w-0">
                          <p className="font-mono text-[12px] font-bold uppercase text-[#1f2a3c]">
                            {g.name}
                          </p>
                          <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#7f8b98]">
                            {g.member_count} {g.member_count === 1 ? "member" : "members"}
                            {" · "}
                            {g.visibility === "public" ? "public" : "invite only"}
                          </p>
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {joined ? (
                          <>
                            <Link
                              href={`/worlds/${encodeURIComponent(g.slug)}`}
                              className="border-[3px] border-[#1f2a3c] bg-[#d6f4d6] px-2 py-1 font-mono text-[9px] font-bold uppercase shadow-[2px_2px_0_#1f2a3c]"
                            >
                              Open
                            </Link>
                            <button
                              type="button"
                              onClick={() => handleLeave(g)}
                              disabled={busyId === g.id}
                              className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-2 py-1 font-mono text-[9px] font-bold uppercase shadow-[2px_2px_0_#1f2a3c] disabled:opacity-60"
                            >
                              {busyId === g.id ? "…" : "Leave"}
                            </button>
                          </>
                        ) : pending ? (
                          <span className="border-[3px] border-[#1f2a3c] bg-[#fff3cd] px-2 py-1 font-mono text-[9px] font-bold uppercase shadow-[2px_2px_0_#1f2a3c]">
                            Pending
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleJoin(g)}
                            disabled={busyId === g.id}
                            className="border-[3px] border-[#1f2a3c] bg-[#ffe17d] px-2 py-1 font-mono text-[9px] font-bold uppercase shadow-[2px_2px_0_#1f2a3c] disabled:opacity-60"
                          >
                            {busyId === g.id ? "…" : "Join"}
                          </button>
                        )}
                      </div>
                    </div>
                    {g.description && (
                      <p className="px-3 py-2 text-[12px] leading-snug text-[#425166]">
                        {g.description}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {createOpen && (
        <CreateWorldModal
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            setCreateOpen(false);
            setTab("mine");
            await refetch();
          }}
        />
      )}
    </>
  );
}

function CreateWorldModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"invite_only" | "public">(
    "invite_only",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/world-groups", {
        name: name.trim(),
        description: description.trim() || null,
        visibility,
      });
      onCreated();
    } catch (err) {
      setError(
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close create"
        onClick={onClose}
        className="fixed inset-0 z-[55] bg-[rgba(12,22,38,0.65)]"
      />
      <div className="fixed left-1/2 top-1/2 z-[60] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 border-[3px] border-[#1f2a3c] bg-[#fffaf0] shadow-[6px_6px_0_#1f2a3c]">
        <header className="border-b-[3px] border-[#1f2a3c] bg-[#ffe17d] px-4 py-3">
          <p className="font-mono text-[11px] font-bold uppercase tracking-[0.18em]">
            New World
          </p>
        </header>
        <div className="space-y-3 px-4 py-3">
          {error && (
            <div className="border-[3px] border-[#1f2a3c] bg-[#f7ddd7] px-3 py-2 font-mono text-[10px] uppercase text-[#6d2d24] shadow-[2px_2px_0_#1f2a3c]">
              {error}
            </div>
          )}
          <label className="block">
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-[#637387]">
              Name
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              className="mt-1 w-full border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2 text-sm shadow-[2px_2px_0_#1f2a3c] outline-none"
              placeholder="e.g. The Owl Pub"
              autoFocus
            />
          </label>
          <label className="block">
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-[#637387]">
              Description (optional)
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={240}
              rows={2}
              className="mt-1 w-full resize-none border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2 text-sm shadow-[2px_2px_0_#1f2a3c] outline-none"
              placeholder="What's this World for?"
            />
          </label>
          <fieldset className="flex gap-2">
            {(["invite_only", "public"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setVisibility(v)}
                className={
                  "flex-1 border-[3px] border-[#1f2a3c] px-2 py-1.5 font-mono text-[10px] font-bold uppercase shadow-[2px_2px_0_#1f2a3c] " +
                  (v === visibility
                    ? "bg-[#1f2a3c] text-[#fffaf0]"
                    : "bg-[#f6f4ea] text-[#1f2a3c]")
                }
              >
                {v === "invite_only" ? "Invite only" : "Public"}
              </button>
            ))}
          </fieldset>
        </div>
        <footer className="flex justify-end gap-2 border-t-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-3 py-2">
          <button
            type="button"
            onClick={onClose}
            className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-3 py-1.5 font-mono text-[10px] font-bold uppercase shadow-[2px_2px_0_#1f2a3c]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!name.trim() || busy}
            className="border-[3px] border-[#1f2a3c] bg-[#ffe17d] px-3 py-1.5 font-mono text-[10px] font-bold uppercase shadow-[2px_2px_0_#1f2a3c] disabled:opacity-60"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </footer>
      </div>
    </>
  );
}
