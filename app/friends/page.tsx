"use client";

// Friends page — search for users, manage pending requests, see your
// friend list, and jump into a friend's world. Same brutalist tokens as
// /onboarding and /world. All data goes through the backend (no direct
// Supabase REST), so RLS rules + observability events live in one place.
//
// Two view modes for accepted friends:
//   • Photobook — grid of agent portrait cards (like /worlds)
//   • DM        — sidebar + chat panel (like talkTo.world)

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { fetchSession, getToken } from "@/lib/authClient";
import { apiDelete, apiGet, apiPost, ApiError } from "@/lib/api";
import { wsUrl } from "@/lib/backend";
import { photoForAgent } from "@/lib/profile-photos";
import SpriteFrame from "@/components/SpriteFrame";
import BrandChip from "@/components/BrandChip";
import posthog from "posthog-js";

const MAP_BG = "/onboarding/map-bg.png";

/* ── Types ──────────────────────────────────────────────────────────── */

type SearchUser = {
  id: string;
  display_name: string;
  friendship_id: string | null;
  friendship_status: "pending" | "accepted" | null;
  friendship_direction: "incoming" | "outgoing" | null;
};
type SearchResponse = { users: SearchUser[] };

type PendingItem = {
  friendship_id: string;
  requester_id: string;
  requester_display_name: string;
  addressee_id: string;
  addressee_display_name: string;
  created_at: string;
};
type PendingResponse = { incoming: PendingItem[]; outgoing: PendingItem[] };

type FriendItem = {
  friendship_id: string;
  friend_id: string;
  friend_display_name: string;
  since: string;
};
type FriendsResponse = { friends: FriendItem[] };

type WorldAgent = {
  id: string;
  display_name: string;
  subtitle: string | null;
  canonical_id: string | null;
  sprite_url: string | null;
  portrait_url: string | null;
};

type FriendWorld = {
  friend: FriendItem;
  worldId: string;
  agents: WorldAgent[];
};

type ChatMsg = {
  id: number | string;
  role: "user" | "agent";
  body: string;
  pending?: boolean;
};

type ViewMode = "photobook" | "dm";

/* ── Main page ──────────────────────────────────────────────────────── */

export default function FriendsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchUser[]>([]);
  const [pending, setPending] = useState<PendingResponse | null>(null);
  const [friends, setFriends] = useState<FriendsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("photobook");

  // Enriched friend data (worlds + agents)
  const [friendWorlds, setFriendWorlds] = useState<FriendWorld[]>([]);
  const [friendWorldsLoading, setFriendWorldsLoading] = useState(false);
  // User's own world — shown first in photobook
  const [ownWorld, setOwnWorld] = useState<FriendWorld | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [p, f] = await Promise.all([
        apiGet<PendingResponse>("/api/friends/pending"),
        apiGet<FriendsResponse>("/api/friends"),
      ]);
      setPending(p);
      setFriends(f);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.status}: ${err.message}`
          : "Failed to load friends",
      );
    }
  }, []);

  useEffect(() => {
    (async () => {
      const auth = await fetchSession();
      if (!auth) {
        router.replace("/login?next=/friends");
        return;
      }
      await refresh();
      // Fetch own world for "Your World" section in photobook
      try {
        type MeResp = { profile: { display_name: string } | null; home_world: { id: string } | null };
        const me = await apiGet<MeResp>("/api/me");
        if (me.home_world?.id && me.profile?.display_name) {
          const { agents } = await apiGet<{ agents: WorldAgent[] }>(
            `/api/worlds/${me.home_world.id}/agents`,
          );
          setOwnWorld({
            friend: {
              friendship_id: "__own__",
              friend_id: "",
              friend_display_name: me.profile.display_name,
              since: "",
            },
            worldId: me.home_world.id,
            agents,
          });
        }
      } catch { /* non-critical */ }
      setLoading(false);
    })();
  }, [router, refresh]);

  // Fetch friend worlds + agents when friends list loads or changes
  useEffect(() => {
    if (!friends || friends.friends.length === 0) {
      setFriendWorlds([]);
      return;
    }
    let cancelled = false;
    setFriendWorldsLoading(true);

    (async () => {
      const results: FriendWorld[] = [];
      // Fetch all friend worlds in parallel
      const promises = friends.friends.map(async (friend) => {
        try {
          const world = await apiGet<{ id: string }>(
            `/api/worlds/by-username/${encodeURIComponent(friend.friend_display_name)}`,
          );
          const { agents } = await apiGet<{
            agents: WorldAgent[];
          }>(`/api/worlds/${world.id}/agents`);
          return { friend, worldId: world.id, agents } as FriendWorld;
        } catch {
          return null;
        }
      });
      const settled = await Promise.all(promises);
      for (const fw of settled) {
        if (fw) results.push(fw);
      }
      if (!cancelled) {
        setFriendWorlds(results);
        setFriendWorldsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [friends]);

  // Debounced search
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const res = await apiGet<SearchResponse>(
          `/api/users/search?q=${encodeURIComponent(q)}`,
        );
        setSearchResults(res.users);
      } catch {
        setSearchResults([]);
      }
    }, 220);
    return () => clearTimeout(handle);
  }, [searchQuery]);

  const sendRequest = async (addresseeId: string) => {
    setBusyId(addresseeId);
    try {
      await apiPost("/api/friends/request", { addressee_id: addresseeId });
      posthog.capture("friend_request_sent");
      await refresh();
      if (searchQuery.trim()) {
        const res = await apiGet<SearchResponse>(
          `/api/users/search?q=${encodeURIComponent(searchQuery.trim())}`,
        );
        setSearchResults(res.users);
      }
    } catch (err) {
      setError(
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err),
      );
    } finally {
      setBusyId(null);
    }
  };

  const acceptRequest = async (friendshipId: string) => {
    setBusyId(friendshipId);
    try {
      await apiPost(`/api/friends/${encodeURIComponent(friendshipId)}/accept`, {});
      posthog.capture("friend_request_accepted");
      await refresh();
    } catch (err) {
      setError(
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err),
      );
    } finally {
      setBusyId(null);
    }
  };

  const removeFriendship = async (friendshipId: string) => {
    setBusyId(friendshipId);
    try {
      await apiDelete(`/api/friends/${encodeURIComponent(friendshipId)}`);
      await refresh();
    } catch (err) {
      setError(
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err),
      );
    } finally {
      setBusyId(null);
    }
  };

  const bgStyle = {
    backgroundImage: `linear-gradient(rgba(12, 22, 38, 0.78), rgba(12, 22, 38, 0.86)), url(${MAP_BG})`,
    backgroundPosition: "center top",
    backgroundSize: "cover",
  } as const;

  if (loading) {
    return (
      <main
        className="flex min-h-dvh items-center justify-center bg-[#0c1626] px-4"
        style={bgStyle}
      >
        <BrandChip />
        <div className="font-mono text-sm uppercase tracking-wider text-[#dcecf4]">
          Loading…
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-[#0c1626] pb-24" style={bgStyle}>
      <BrandChip />

      <div className="mx-auto max-w-5xl px-3 pt-20 sm:px-4 sm:pt-24">
        <div className="mb-4 border-[3px] border-[#1f2a3c] bg-[rgba(236,231,217,0.96)] p-4 text-[#1f2a3c] shadow-[4px_4px_0_#1f2a3c]">
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <span className="bg-[#e8f1ff] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em]">
                Friends
              </span>
              <h1 className="mt-2 font-mono text-2xl font-bold uppercase leading-tight">
                Find people, visit their world
              </h1>
            </div>
            <Link
              href="/world"
              className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-3 py-2 font-mono text-[11px] font-bold uppercase shadow-[3px_3px_0_#1f2a3c]"
            >
              ← Your world
            </Link>
          </div>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by name…"
            className="mt-3 w-full border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-4 py-3 text-base shadow-[3px_3px_0_#1f2a3c] outline-none placeholder:text-[#7f8b98]"
          />
          {searchResults.length > 0 && (
            <div className="mt-3 space-y-2">
              {searchResults.map((u) => {
                const label =
                  u.friendship_status === "accepted"
                    ? "Already friends"
                    : u.friendship_status === "pending" &&
                        u.friendship_direction === "outgoing"
                      ? "Request sent"
                      : u.friendship_status === "pending" &&
                          u.friendship_direction === "incoming"
                        ? "They sent you a request"
                        : "Send request";
                const disabled =
                  u.friendship_status !== null || busyId === u.id;
                return (
                  <Row
                    key={u.id}
                    title={u.display_name}
                    subtitle={`@${u.id.slice(0, 8)}`}
                    actions={
                      <Btn
                        label={label}
                        onClick={() => sendRequest(u.id)}
                        disabled={disabled}
                        tone={
                          u.friendship_status === null ? "primary" : undefined
                        }
                      />
                    }
                  />
                );
              })}
            </div>
          )}
          {searchQuery.trim() && searchResults.length === 0 && (
            <div className="mt-3 border-2 border-dashed border-[#9fb0bf] bg-[#fffaf0] p-4 text-center font-mono text-[11px] uppercase tracking-wider text-[#637387]">
              No matches.
            </div>
          )}
        </div>

        {error && (
          <div className="mb-3 border-[3px] border-[#1f2a3c] bg-[#f7ddd7] px-4 py-3 font-mono text-[11px] uppercase tracking-wider text-[#6d2d24] shadow-[3px_3px_0_#1f2a3c]">
            {error}
          </div>
        )}

        {/* Pending requests inbox */}
        {pending && pending.incoming.length > 0 && (
          <Section title="Incoming requests">
            {pending.incoming.map((p) => (
              <Row
                key={p.friendship_id}
                title={p.requester_display_name}
                subtitle={`Sent ${formatRelative(p.created_at)}`}
                actions={
                  <>
                    <Btn
                      label="Accept"
                      onClick={() => acceptRequest(p.friendship_id)}
                      disabled={busyId === p.friendship_id}
                      tone="primary"
                    />
                    <Btn
                      label="Decline"
                      onClick={() => { posthog.capture("friend_request_declined"); removeFriendship(p.friendship_id); }}
                      disabled={busyId === p.friendship_id}
                    />
                  </>
                }
              />
            ))}
          </Section>
        )}

        {pending && pending.outgoing.length > 0 && (
          <Section title="Sent — awaiting reply">
            {pending.outgoing.map((p) => (
              <Row
                key={p.friendship_id}
                title={p.addressee_display_name}
                subtitle={`Sent ${formatRelative(p.created_at)}`}
                actions={
                  <Btn
                    label="Cancel"
                    onClick={() => removeFriendship(p.friendship_id)}
                    disabled={busyId === p.friendship_id}
                  />
                }
              />
            ))}
          </Section>
        )}

        {/* Friends — Photobook / DM toggle */}
        <div className="mt-4 border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.98)] text-[#1f2a3c] shadow-[4px_4px_0_#1f2a3c]">
          {/* Tab header */}
          <div className="flex items-center justify-between border-b-[3px] border-[#1f2a3c] px-4 py-3">
            <h2 className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-[#637387]">
              Friends ({friends?.friends.length ?? 0})
            </h2>
            <div className="flex gap-0">
              <button
                type="button"
                onClick={() => setViewMode("photobook")}
                className={`border-[3px] border-[#1f2a3c] px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider shadow-[2px_2px_0_#1f2a3c] transition-colors ${
                  viewMode === "photobook"
                    ? "bg-[#e8f1ff] text-[#1f2a3c]"
                    : "bg-[#f6f4ea] text-[#7f8b98]"
                }`}
              >
                ▦ Photobook
              </button>
              <button
                type="button"
                onClick={() => setViewMode("dm")}
                className={`-ml-[3px] border-[3px] border-[#1f2a3c] px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider shadow-[2px_2px_0_#1f2a3c] transition-colors ${
                  viewMode === "dm"
                    ? "bg-[#e8f1ff] text-[#1f2a3c]"
                    : "bg-[#f6f4ea] text-[#7f8b98]"
                }`}
              >
                ✦ Messages
              </button>
            </div>
          </div>

          {/* Tab content — Your World always shows; the 0-friends
              hint is rendered inline by the views so the user can
              still see their own agents on /friends. */}
          <div className="p-4">
            {viewMode === "photobook" ? (
              <PhotobookView
                friendWorlds={friendWorlds}
                ownWorld={ownWorld}
                loading={friendWorldsLoading}
                onRemove={removeFriendship}
                busyId={busyId}
                noFriendsHint={!!friends && friends.friends.length === 0}
              />
            ) : (
              <DMView
                friendWorlds={ownWorld ? [ownWorld, ...friendWorlds] : friendWorlds}
                loading={friendWorldsLoading}
              />
            )}
          </div>
        </div>

      </div>
    </main>
  );
}

/* ── Photobook view ─────────────────────────────────────────────────── */

function PhotobookView({
  friendWorlds,
  ownWorld,
  loading,
  onRemove,
  busyId,
  noFriendsHint,
}: {
  friendWorlds: FriendWorld[];
  ownWorld: FriendWorld | null;
  loading: boolean;
  onRemove: (id: string) => void;
  busyId: string | null;
  noFriendsHint?: boolean;
}) {
  if (loading) {
    return (
      <div className="py-8 text-center font-mono text-[11px] uppercase tracking-wider text-[#7f8b98]">
        Loading worlds…
      </div>
    );
  }

  if (friendWorlds.length === 0 && !ownWorld) {
    return (
      <div className="border-2 border-dashed border-[#9fb0bf] bg-[#fffaf0] p-4 text-center font-mono text-[11px] uppercase tracking-wider text-[#637387]">
        No worlds to show yet.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Your world — always first */}
      {ownWorld && (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="font-mono text-sm font-bold uppercase">
                Your World
              </h3>
              <span className="font-mono text-[9px] uppercase tracking-wider text-[#7f8b98]">
                {ownWorld.agents.length} agent{ownWorld.agents.length !== 1 ? "s" : ""}
              </span>
            </div>
            <Link
              href="/world"
              className="border-[3px] border-[#1f2a3c] bg-[#d6f4d6] px-3 py-1.5 font-mono text-[10px] font-bold uppercase shadow-[2px_2px_0_#1f2a3c]"
            >
              Go to world
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {ownWorld.agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                ownerName={ownWorld.friend.friend_display_name}
                linkTo="/world"
              />
            ))}
          </div>
        </div>
      )}

      {/* No-friends hint, slotted after Your World so the user
          still sees their own agents while being nudged to add some. */}
      {noFriendsHint && friendWorlds.length === 0 && (
        <div className="border-2 border-dashed border-[#9fb0bf] bg-[#fffaf0] p-4 text-center font-mono text-[11px] uppercase tracking-wider text-[#637387]">
          No friends yet — search below to find people.
        </div>
      )}

      {/* Friends' worlds */}
      {friendWorlds.map((fw) => (
        <div key={fw.friend.friendship_id}>
          {/* Friend header */}
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="font-mono text-sm font-bold uppercase">
                {fw.friend.friend_display_name}
              </h3>
              <span className="font-mono text-[9px] uppercase tracking-wider text-[#7f8b98]">
                {fw.agents.length} agent{fw.agents.length !== 1 ? "s" : ""}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Link
                href={`/world/${encodeURIComponent(fw.friend.friend_display_name)}`}
                className="border-[3px] border-[#1f2a3c] bg-[#e8f1ff] px-3 py-1.5 font-mono text-[10px] font-bold uppercase shadow-[2px_2px_0_#1f2a3c]"
              >
                Visit world
              </Link>
              <button
                type="button"
                onClick={() => onRemove(fw.friend.friendship_id)}
                disabled={busyId === fw.friend.friendship_id}
                className="border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-3 py-1.5 font-mono text-[10px] font-bold uppercase shadow-[2px_2px_0_#1f2a3c] disabled:opacity-60"
              >
                Remove
              </button>
            </div>
          </div>
          {/* Agent card grid */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {fw.agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                ownerName={fw.friend.friend_display_name}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function AgentCard({
  agent,
  ownerName,
  linkTo,
}: {
  agent: WorldAgent;
  ownerName: string;
  linkTo?: string;
}) {
  const photo = photoForAgent(agent.canonical_id);
  return (
    <Link
      href={linkTo ?? `/world/${encodeURIComponent(ownerName)}`}
      className="group block border-[3px] border-[#1f2a3c] bg-[#fffaf0] shadow-[3px_3px_0_#1f2a3c] transition-transform hover:translate-x-[-1px] hover:translate-y-[-1px] hover:shadow-[4px_4px_0_#1f2a3c]"
    >
      {/* Badge */}
      <div className="px-2 pt-2">
        <span className="inline-block bg-[#e8f1ff] px-2 py-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.18em]">
          {ownerName}&apos;s world
        </span>
      </div>
      {/* Portrait */}
      <div className="flex h-[140px] items-center justify-center overflow-hidden bg-[linear-gradient(180deg,#b6cadf_0%,#dcecf4_55%,#fffaf0_55%)] px-2 pt-1">
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photo}
            alt={agent.display_name}
            className="h-full w-full object-cover"
          />
        ) : agent.portrait_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={agent.portrait_url}
            alt={agent.display_name}
            className="max-h-full object-contain"
            style={{ imageRendering: "pixelated" }}
          />
        ) : agent.sprite_url ? (
          <SpriteFrame
            src={agent.sprite_url}
            size={4}
            title={agent.display_name}
          />
        ) : (
          <div className="flex h-16 w-8 items-center justify-center font-mono text-[10px] text-[#7f8b98]">?</div>
        )}
      </div>
      {/* Name + subtitle */}
      <div className="border-t-[2px] border-[#e8e4d9] px-2 py-2">
        <p className="font-mono text-xs font-bold uppercase leading-tight">
          {agent.display_name}
        </p>
        {agent.subtitle && (
          <p className="mt-0.5 font-mono text-[9px] italic text-[#637387]">
            {agent.subtitle}
          </p>
        )}
      </div>
    </Link>
  );
}

/* ── DM view ────────────────────────────────────────────────────────── */

function DMView({
  friendWorlds,
  loading,
}: {
  friendWorlds: FriendWorld[];
  loading: boolean;
}) {
  const [selectedAgent, setSelectedAgent] = useState<{
    agent: WorldAgent;
    ownerName: string;
  } | null>(null);

  // Flatten all friends' agents into a contact list grouped by friend
  const contacts = useMemo(() => {
    return friendWorlds.map((fw) => ({
      friendName: fw.friend.friend_display_name,
      agents: fw.agents,
    }));
  }, [friendWorlds]);

  // Auto-select first contact so the chat isn't empty on tab open
  useEffect(() => {
    if (selectedAgent) return;
    for (const group of contacts) {
      if (group.agents.length > 0) {
        setSelectedAgent({ agent: group.agents[0], ownerName: group.friendName });
        return;
      }
    }
  }, [contacts, selectedAgent]);

  if (loading) {
    return (
      <div className="py-8 text-center font-mono text-[11px] uppercase tracking-wider text-[#7f8b98]">
        Loading contacts…
      </div>
    );
  }

  if (contacts.length === 0) {
    return (
      <div className="border-2 border-dashed border-[#9fb0bf] bg-[#fffaf0] p-4 text-center font-mono text-[11px] uppercase tracking-wider text-[#637387]">
        No contacts available.
      </div>
    );
  }

  return (
    <div className="flex gap-0 border-[3px] border-[#1f2a3c] bg-[#f6f4ea] shadow-[3px_3px_0_#1f2a3c]" style={{ minHeight: 420 }}>
      {/* Left sidebar — contact list */}
      <div className="w-[200px] shrink-0 overflow-y-auto border-r-[3px] border-[#1f2a3c] bg-[#fffaf0] sm:w-[220px]">
        <div className="border-b-[2px] border-[#e8e4d9] px-3 py-2.5">
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#637387]">
            Contacts ({friendWorlds.reduce((n, fw) => n + fw.agents.length, 0)})
          </span>
        </div>
        <div className="py-1">
          {contacts.map((group) => (
            <div key={group.friendName}>
              <div className="px-3 pt-3 pb-1 font-mono text-[8px] font-bold uppercase tracking-[0.2em] text-[#9fb0bf]">
                {group.friendName}
              </div>
              {group.agents.map((agent) => {
                const isActive = selectedAgent?.agent.id === agent.id;
                const photo = photoForAgent(agent.canonical_id);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() =>
                      setSelectedAgent({
                        agent,
                        ownerName: group.friendName,
                      })
                    }
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                      isActive
                        ? "bg-[#e8f1ff]"
                        : "hover:bg-[#f6f4ea]"
                    }`}
                  >
                    {/* Avatar */}
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden border-[2px] border-[#1f2a3c] bg-[#f6f4ea]">
                      {photo ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={photo}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : agent.sprite_url ? (
                        <SpriteFrame
                          src={agent.sprite_url}
                          size={1}
                          title={agent.display_name}
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center font-mono text-[9px] text-[#7f8b98]">?</div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className={`truncate text-[13px] font-bold leading-tight ${isActive ? "text-[#1f2a3c]" : ""}`}>
                        {agent.display_name}
                      </p>
                      {agent.subtitle && (
                        <p className="truncate font-mono text-[9px] text-[#7f8b98]">
                          {agent.subtitle}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Right panel — chat */}
      <div className="flex min-w-0 flex-1 flex-col bg-[#f6f4ea]">
        {selectedAgent ? (
          <InlineChat
            key={selectedAgent.agent.id}
            agentId={selectedAgent.agent.id}
            agentName={selectedAgent.agent.display_name}
            agentSubtitle={selectedAgent.agent.subtitle}
            agentCanonicalId={selectedAgent.agent.canonical_id}
            agentSpriteUrl={selectedAgent.agent.sprite_url}
            agentPortraitUrl={selectedAgent.agent.portrait_url}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <p className="font-mono text-[11px] uppercase tracking-wider text-[#7f8b98]">
              Pick someone to chat with
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Inline chat (embedded in DM panel) ─────────────────────────────── */

function InlineChat({
  agentId,
  agentName,
  agentSubtitle,
  agentCanonicalId,
  agentSpriteUrl,
  agentPortraitUrl,
}: {
  agentId: string;
  agentName: string;
  agentSubtitle: string | null;
  agentCanonicalId: string | null;
  agentSpriteUrl: string | null;
  agentPortraitUrl: string | null;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const photo = photoForAgent(agentCanonicalId);

  useEffect(() => {
    (async () => {
      setToken(getToken());
    })();
  }, []);

  useEffect(() => {
    if (!token) return;
    const url = `${wsUrl("/")}?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "chat.start", agent_id: agentId }));
    });

    ws.addEventListener("message", (ev) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        return;
      }
      const t = frame.type as string;
      if (t === "chat.history") {
        setMessages((frame.messages as ChatMsg[]) || []);
      } else if (t === "chat.agent_chunk") {
        const delta = String(frame.delta || "");
        setMessages((prev) => {
          if (!streamingRef.current) {
            streamingRef.current = true;
            return [
              ...prev,
              { id: `pending-${Date.now()}`, role: "agent", body: delta, pending: true },
            ];
          }
          const last = prev[prev.length - 1];
          if (!last || !last.pending) return prev;
          return [
            ...prev.slice(0, -1),
            { ...last, body: (last.body || "") + delta },
          ];
        });
      } else if (t === "chat.agent_done") {
        const fullText = String(frame.full_text || "");
        const messageId = frame.message_id as number;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (!last || !last.pending) {
            return [...prev, { id: messageId, role: "agent", body: fullText }];
          }
          return [
            ...prev.slice(0, -1),
            { id: messageId, role: "agent", body: fullText },
          ];
        });
        streamingRef.current = false;
        setBusy(false);
        // Human notification sound — DM reply received.
        try { new Audio("/sfx/human-notification.mp3").play(); } catch {}
      } else if (t === "chat.error") {
        setChatError(String(frame.message || "chat error"));
        setBusy(false);
        streamingRef.current = false;
      }
    });

    return () => {
      try {
        ws.close();
      } catch { /* noop */ }
      wsRef.current = null;
      streamingRef.current = false;
    };
  }, [token, agentId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = () => {
    const body = draft.trim();
    if (!body || busy) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setChatError("Connection isn't open yet.");
      return;
    }
    setChatError(null);
    setBusy(true);
    posthog.capture("friend_dm_sent", { agent_id: agentId, agent_name: agentName });
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: "user", body },
    ]);
    setDraft("");
    ws.send(
      JSON.stringify({ type: "chat.user_msg", agent_id: agentId, body }),
    );
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex flex-1 flex-col">
      {/* Chat header */}
      <div className="flex items-center gap-3 border-b-[3px] border-[#1f2a3c] bg-[#fffaf0] px-4 py-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden border-[2px] border-[#1f2a3c] bg-[#f6f4ea]">
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photo} alt="" className="h-full w-full object-cover" />
          ) : agentPortraitUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={agentPortraitUrl}
              alt=""
              className="max-h-full object-contain"
              style={{ imageRendering: "pixelated" }}
            />
          ) : agentSpriteUrl ? (
            <SpriteFrame src={agentSpriteUrl} size={1} title={agentName} />
          ) : (
            <div className="flex h-full w-full items-center justify-center font-mono text-[9px] text-[#7f8b98]">?</div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#637387]">
            Talking to
          </p>
          <p className="truncate text-base font-bold leading-tight">
            {agentName}
            {agentSubtitle && (
              <span className="ml-1.5 text-[11px] font-normal text-[#7f8b98]">
                · {agentSubtitle}
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Transcript */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-3"
        style={{ minHeight: 200 }}
      >
        {messages.length === 0 ? (
          <p className="font-mono text-[11px] uppercase tracking-wider text-[#7f8b98]">
            Send {agentName} a message to start.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {messages.map((m) => (
              <div
                key={String(m.id)}
                className={
                  m.role === "user"
                    ? "ml-12 self-end border-[3px] border-[#1f2a3c] bg-[#e8f1ff] px-3 py-2 shadow-[2px_2px_0_#1f2a3c]"
                    : "mr-12 self-start border-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2 shadow-[2px_2px_0_#1f2a3c]"
                }
              >
                <p className="font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-[#637387]">
                  {m.role === "user" ? "You" : agentName}
                </p>
                <p className="whitespace-pre-wrap text-sm leading-snug">
                  {m.body}
                  {m.pending && (
                    <span className="ml-1 inline-block h-2 w-2 animate-pulse bg-[#1f2a3c]" />
                  )}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Error */}
      {chatError && (
        <div className="border-t-[2px] border-[#1f2a3c] bg-[#f7ddd7] px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-[#6d2d24]">
          {chatError}
        </div>
      )}

      {/* Composer */}
      <div className="flex items-end gap-2 border-t-[3px] border-[#1f2a3c] bg-[#fffaf0] px-3 py-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder={`Message ${agentName}…`}
          rows={2}
          className="w-full resize-none border-[3px] border-[#1f2a3c] bg-[#f6f4ea] px-3 py-2 text-sm shadow-[2px_2px_0_#1f2a3c] outline-none placeholder:text-[#7f8b98]"
        />
        <button
          type="button"
          onClick={send}
          disabled={busy || !draft.trim()}
          className="border-[3px] border-[#1f2a3c] bg-[#d6f4d6] px-3 py-2 font-mono text-xs font-bold uppercase shadow-[2px_2px_0_#1f2a3c] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

/* ── Shared components ──────────────────────────────────────────────── */

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-4 border-[3px] border-[#1f2a3c] bg-[rgba(246,244,234,0.98)] p-4 text-[#1f2a3c] shadow-[4px_4px_0_#1f2a3c]">
      <h2 className="mb-3 font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-[#637387]">
        {title}
      </h2>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Row({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-[3px] border-[#1f2a3c] bg-[#fffaf0] p-3 shadow-[3px_3px_0_#1f2a3c]">
      <div className="min-w-0 flex-1">
        <p className="font-bold leading-tight">{title}</p>
        {subtitle && (
          <p className="font-mono text-[10px] uppercase tracking-wider text-[#7f8b98]">
            {subtitle}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {actions}
      </div>
    </div>
  );
}

function Btn({
  label,
  onClick,
  disabled,
  tone,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "primary";
}) {
  const bg = tone === "primary" ? "bg-[#e8f1ff]" : "bg-[#f6f4ea]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`border-[3px] border-[#1f2a3c] ${bg} px-3 py-2 font-mono text-[11px] font-bold uppercase text-[#1f2a3c] shadow-[3px_3px_0_#1f2a3c] disabled:cursor-not-allowed disabled:opacity-60`}
    >
      {label}
    </button>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const diffSec = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86_400)}d ago`;
}
