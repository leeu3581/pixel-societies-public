"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { apiUrl } from "@/lib/backend";
import {
  AGENT_BIOS,
  type AgentBio,
  type AgentMemory,
  type AgentTopic,
  type AgentRelationship,
  type AgentDimension,
} from "./agentBios";

// Server payload from /api/agent_bio — snake_case from FastAPI.
type ServerBio = {
  id: string;
  name: string;
  role: string;
  color: string;
  ingested: boolean;
  one_line: string;
  tags: string[];
  tensions: string[];
  voice: string[];
  ask_about: string[];
  goals: string[];
  sample_line: string;
  memories: Array<{ title: string; emotion: string; tags: string[]; gradient: [string, string]; blurb?: string }>;
  topics: Array<{ slug: string; title: string; blurb: string }>;
  relationships: Array<{ name: string; context: string }>;
  dimensions: Array<{ label: string; value: number }>;
};

function serverBioToBio(s: ServerBio): AgentBio {
  return {
    title: s.role,
    oneLine: s.one_line || "",
    tags: s.tags ?? [],
    tensions: s.tensions ?? [],
    voice: s.voice ?? [],
    sampleLine: s.sample_line ?? "",
    askAbout: s.ask_about ?? [],
    memories: (s.memories ?? []).map((m) => ({
      title: m.title,
      emotion: m.emotion,
      tags: m.tags,
      gradient: m.gradient,
    })),
    topics: (s.topics ?? []).map((t) => ({
      slug: t.slug,
      title: t.title,
      blurb: t.blurb,
    })),
    relationships: (s.relationships ?? []).map((r) => ({
      name: r.name,
      context: r.context,
    })),
    dimensions: s.dimensions ?? [],
  };
}

type Agent = {
  id: string;
  name: string;
  role: string;
  color: string;
  photo?: string;
};

// Fallback hardcoded map — used only if /api/agents doesn't include a
// `photo` field (older backend) or the wiki doesn't declare one for
// this agent. Source of truth is the `photo:` line in each agent's
// personality.md frontmatter.
import { PROFILE_PHOTOS } from "@/lib/profile-photos";

function profilePhotoFor(agent: Agent): string | null {
  return agent.photo || PROFILE_PHOTOS[agent.id] || null;
}

// Single 16×32 idle frame from /public/team-office/characters/char_N.png at 3× scale.
function PixelAvatar({ paletteIndex, size = 2 }: { paletteIndex: number; size?: number }) {
  const w = 16 * size;
  const h = 32 * size;
  return (
    <div
      style={{
        width: w,
        height: h,
        backgroundImage: `url(/team-office/characters/char_${paletteIndex}.png)`,
        backgroundRepeat: "no-repeat",
        backgroundPosition: "0 0",
        backgroundSize: `${112 * size}px ${96 * size}px`,
        imageRendering: "pixelated",
      }}
      aria-hidden
    />
  );
}

function SectionCard({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="editorial-tile overflow-hidden">
      <div className="px-5 pt-4 pb-2">
        <div className="eyebrow">{eyebrow}</div>
        <h3 className="serif-display mt-1 text-[20px] font-semibold leading-tight text-[var(--ink)]">
          {title}
        </h3>
      </div>
      <div className="px-5 pb-5 pt-2 text-[13.5px] leading-relaxed text-[var(--ink-soft)]">
        {children}
      </div>
    </section>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2.5 text-[13.5px] leading-relaxed text-[var(--ink-soft)]">
      {items.map((b, i) => (
        <li key={i} className="flex items-start gap-2.5">
          <span className="mt-[7px] inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ink-mute)]" />
          <span>{b}</span>
        </li>
      ))}
    </ul>
  );
}

// Themed memory tile — real photo if provided, gradient otherwise.
function MemoryCard({ memory }: { memory: AgentMemory }) {
  const [from, to] = memory.gradient;
  return (
    <div className="flex w-[230px] shrink-0 flex-col gap-2.5">
      <div
        className="relative h-[150px] w-full overflow-hidden rounded-2xl border border-[rgba(26,20,16,0.06)] shadow-[0_1px_2px_rgba(26,20,16,0.04)]"
        style={
          memory.photo
            ? undefined
            : { background: `linear-gradient(135deg, ${from} 0%, ${to} 100%)` }
        }
      >
        {memory.photo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={memory.photo}
            alt={memory.title}
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
        <span className="absolute top-2.5 left-2.5 z-10 inline-flex items-center gap-1.5 rounded-full bg-white/90 px-2.5 py-1 font-mono text-[9.5px] font-bold uppercase tracking-[0.16em] text-[var(--ink)] backdrop-blur-sm">
          emotion: {memory.emotion}
        </span>
        <span className="absolute right-2.5 bottom-2.5 left-2.5 z-10 inline-block truncate rounded-full bg-white/90 px-2.5 py-1 font-mono text-[9.5px] font-bold uppercase tracking-[0.16em] text-[var(--ink)] backdrop-blur-sm">
          tags: {memory.tags.join(", ")}
        </span>
      </div>
      <div className="serif-display px-1 text-[15px] font-semibold leading-tight text-[var(--ink)]">
        {memory.title}
      </div>
    </div>
  );
}

// Hexagonal radar chart — now driven by real knowledge-category scores.
function KnowledgeRadar({
  dims,
  fill,
}: {
  dims: AgentDimension[];
  fill: string;
}) {
  if (!dims.length || dims.every((d) => d.value < 0.1)) return null;
  const size = 240;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 84;
  const n = dims.length;

  const point = (i: number, value: number) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const r = radius * Math.max(0, Math.min(1, value));
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)] as const;
  };
  const labelPoint = (i: number) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const r = radius + 20;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)] as const;
  };
  const ringPoly = (frac: number) =>
    Array.from({ length: n }, (_, i) => {
      const [x, y] = point(i, frac);
      return `${x},${y}`;
    }).join(" ");
  const dataPoly = dims
    .map((d, i) => {
      const [x, y] = point(i, d.value);
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="block w-full"
      role="img"
      aria-label="Knowledge radar"
    >
      {[0.33, 0.66, 1].map((f) => (
        <polygon
          key={f}
          points={ringPoly(f)}
          fill="none"
          stroke="#1a1410"
          strokeOpacity={f === 1 ? 0.18 : 0.08}
          strokeWidth={1}
        />
      ))}
      {dims.map((_, i) => {
        const [x, y] = point(i, 1);
        return (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={x}
            y2={y}
            stroke="#1a1410"
            strokeOpacity={0.08}
            strokeWidth={1}
          />
        );
      })}
      <polygon
        points={dataPoly}
        fill={fill}
        fillOpacity={0.22}
        stroke={fill}
        strokeWidth={1.75}
      />
      {dims.map((d, i) => {
        const [x, y] = point(i, d.value);
        return <circle key={i} cx={x} cy={y} r={2.5} fill="#1a1410" />;
      })}
      {dims.map((d, i) => {
        const [x, y] = labelPoint(i);
        return (
          <text
            key={i}
            x={x}
            y={y}
            textAnchor="middle"
            dominantBaseline="middle"
            fontFamily="ui-monospace, SFMono-Regular, monospace"
            fontSize={9}
            fontWeight={700}
            fill="#5a4f3f"
            style={{ letterSpacing: "0.04em" }}
          >
            {d.label.toUpperCase()}
          </text>
        );
      })}
    </svg>
  );
}

// Topic card — shows what this agent knows about.
function TopicCard({ topic, color }: { topic: AgentTopic; color: string }) {
  return (
    <div
      className="rounded-2xl border px-4 py-3"
      style={{ borderColor: `${color}30`, background: `${color}08` }}
    >
      <div className="serif-display text-[14px] font-semibold leading-tight text-[var(--ink)]">
        {topic.title}
      </div>
      {topic.blurb && (
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--ink-soft)]">
          {topic.blurb}
        </p>
      )}
    </div>
  );
}

function TopicsSection({ topics, color }: { topics: AgentTopic[]; color: string }) {
  if (!topics.length) return null;
  return (
    <SectionCard eyebrow="Knowledge" title="Topics I know about">
      <div className="space-y-2.5">
        {topics.map((t) => (
          <TopicCard key={t.slug} topic={t} color={color} />
        ))}
      </div>
    </SectionCard>
  );
}

function RelationshipsSection({ relationships }: { relationships: AgentRelationship[] }) {
  if (!relationships.length) return null;
  return (
    <SectionCard eyebrow="Network" title="Key relationships">
      <div className="space-y-3">
        {relationships.map((r, i) => (
          <div key={i} className="flex items-start gap-2.5">
            <span className="mt-[3px] inline-block h-5 w-5 shrink-0 rounded-full bg-[var(--ink-mute)] opacity-30" />
            <div className="min-w-0 flex-1">
              <span className="text-[13.5px] font-semibold text-[var(--ink)]">{r.name}</span>
              <span className="ml-1.5 text-[12.5px] text-[var(--ink-soft)]">— {r.context}</span>
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

function NoBio({ name }: { name: string }) {
  return (
    <div className="editorial-tile p-5 text-center text-[13px] text-[var(--ink-mute)]">
      No biography drafted yet for {name}.
    </div>
  );
}

function Body({ agent, bio, paletteIndex }: { agent: Agent; bio: AgentBio | undefined; paletteIndex: number }) {
  if (!bio) return <NoBio name={agent.name} />;
  return (
    <>
      <section className="editorial-tile overflow-hidden">
        <div className="px-5 py-4">
          <div className="eyebrow">Overview — Snapshot</div>
          <div className="mt-2 flex items-start gap-3">
            <div className="shrink-0 pt-1">
              <div
                className="flex h-[72px] w-[56px] items-center justify-center overflow-hidden rounded-2xl border border-[rgba(26,20,16,0.08)]"
                style={{ background: `linear-gradient(135deg, ${agent.color}28, ${agent.color}10)` }}
              >
                {profilePhotoFor(agent) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={profilePhotoFor(agent)!} alt={agent.name} className="h-full w-full object-cover" />
                ) : (
                  <PixelAvatar paletteIndex={paletteIndex} size={2} />
                )}
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="serif-display text-[22px] font-semibold leading-tight text-[var(--ink)]">
                {bio.title}
              </h3>
              <p className="mt-2 text-[14px] leading-relaxed text-[var(--ink-soft)]">{bio.oneLine}</p>
            </div>
          </div>
        </div>
      </section>

      {(bio.askAbout.length > 0 || bio.topics.length > 0) && (
        <SectionCard eyebrow="Good for" title="What you can ask me about">
          {bio.askAbout.length > 0 ? (
            <Bullets items={bio.askAbout} />
          ) : (
            <Bullets items={bio.topics.map((t) => t.title)} />
          )}
        </SectionCard>
      )}

      <RelationshipsSection relationships={bio.relationships} />

      {bio.memories.length > 0 && (
        <section className="editorial-tile overflow-hidden">
          <div className="px-5 pt-4 pb-2">
            <div className="eyebrow">Memories — recent scenes</div>
            <h3 className="serif-display mt-1 text-[20px] font-semibold leading-tight text-[var(--ink)]">
              Where you{"'"}d find me
            </h3>
          </div>
          <div className="overflow-x-auto px-5 pb-5 pt-2">
            <div className="flex gap-3">
              {bio.memories.map((m, i) => (
                <MemoryCard key={i} memory={m} />
              ))}
            </div>
          </div>
        </section>
      )}

      {bio.dimensions.length > 0 && (
        <SectionCard eyebrow="Knowledge profile" title="What I know about">
          <KnowledgeRadar dims={bio.dimensions} fill={agent.color} />
        </SectionCard>
      )}

      <TopicsSection topics={bio.topics} color={agent.color} />

      {bio.tensions.length > 0 && (
        <SectionCard eyebrow="Internal conflicts" title="Recurring tensions">
          <Bullets items={bio.tensions} />
        </SectionCard>
      )}

      <SectionCard eyebrow="Voice" title="How I talk">
        <Bullets items={bio.voice} />
        {bio.sampleLine && (
          <figure className="mt-4 rounded-2xl border border-[rgba(26,20,16,0.06)] bg-[var(--cream-soft)] px-4 py-3">
            <blockquote className="serif-display text-[15px] italic leading-relaxed text-[var(--ink)]">
              &ldquo;{bio.sampleLine}&rdquo;
            </blockquote>
            <figcaption className="eyebrow mt-2">sample line</figcaption>
          </figure>
        )}
      </SectionCard>
    </>
  );
}

export default function AgentProfileDrawer({
  agent,
  paletteIndex,
  onClose,
  // Legacy "Pick as Friend A/B" props are accepted but ignored — the
  // drawer's primary action is now "Chat with X". Kept in the type so
  // existing call sites compile during the transition.
  isFriendA: _isFriendA = false,
  isFriendB: _isFriendB = false,
  pickerLocked: _pickerLocked = false,
  onPickA: _onPickA,
  onPickB: _onPickB,
  onDeselect: _onDeselect,
}: {
  agent: Agent;
  paletteIndex: number;
  onClose: () => void;
  isFriendA?: boolean;
  isFriendB?: boolean;
  pickerLocked?: boolean;
  onPickA?: () => void;
  onPickB?: () => void;
  onDeselect?: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Live bio from the backend — derived from the agent's wiki.
  // Falls back to the hardcoded AGENT_BIOS only if the fetch fails.
  const [bio, setBio] = useState<AgentBio | undefined>(undefined);
  const [loadingBio, setLoadingBio] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoadingBio(true);
    const url = apiUrl(`/api/agent_bio?id=${encodeURIComponent(agent.id)}`);
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: ServerBio) => {
        if (cancelled) return;
        setBio(serverBioToBio(data));
        setLoadingBio(false);
      })
      .catch(() => {
        if (cancelled) return;
        setBio(AGENT_BIOS[agent.id]);
        setLoadingBio(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id]);


  return (
    <>
      <button
        type="button"
        aria-label="Close profile"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-[rgba(26,20,16,0.18)] backdrop-blur-sm"
      />
      <aside
        role="dialog"
        aria-label={`${agent.name} profile`}
        className="fixed inset-y-3 right-3 z-50 flex w-[calc(100%-1.5rem)] max-w-md flex-col overflow-hidden rounded-[28px] border border-[rgba(26,20,16,0.06)] bg-[var(--cream-bg)] shadow-[0_24px_60px_rgba(26,20,16,0.16)] sm:inset-y-4 sm:right-4 sm:w-[calc(100%-2rem)]"
      >
        <header className="flex items-center justify-between border-b border-[rgba(26,20,16,0.06)] bg-[var(--cream-card)] px-5 py-3">
          <div className="eyebrow">Profile</div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-[rgba(26,20,16,0.12)] bg-white text-[16px] leading-none text-[var(--ink-soft)] transition-colors hover:bg-[var(--cream-soft)] hover:text-[var(--ink)]"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto bg-[var(--cream-bg)] p-5">
          {/* Profile photo + name */}
          <div className="flex items-center gap-4">
            {profilePhotoFor(agent) ? (
              <div
                className="h-20 w-20 shrink-0 overflow-hidden rounded-2xl border-2 shadow-md"
                style={{ borderColor: `${agent.color}66` }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={profilePhotoFor(agent)!}
                  alt={agent.name}
                  className="h-full w-full object-cover"
                />
              </div>
            ) : (
              <div
                className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl border-2"
                style={{ borderColor: `${agent.color}66`, background: `linear-gradient(135deg, ${agent.color}28, ${agent.color}10)` }}
              >
                <PixelAvatar paletteIndex={paletteIndex} size={3} />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <h2 className="serif-display truncate text-[28px] font-semibold leading-tight text-[var(--ink)]">
                {agent.name}
                {"'"}s Biography
              </h2>
              <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-[rgba(26,20,16,0.1)] bg-white px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ink-soft)]">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent-good)]" />
                Live narrative · Beta
              </div>
            </div>
          </div>

          {bio && (
            <div className="flex flex-wrap gap-1.5">
              {bio.tags.map((t) => (
                <span key={t} className="chip">
                  {t}
                </span>
              ))}
            </div>
          )}

          {loadingBio && !bio ? (
            <div className="editorial-tile p-5 text-center text-[13px] text-[var(--ink-mute)]">
              Loading biography from the wiki…
            </div>
          ) : (
            <Body agent={agent} bio={bio} paletteIndex={paletteIndex} />
          )}
        </div>

        <footer className="border-t border-[rgba(26,20,16,0.06)] bg-[var(--cream-card)] p-4">
          <Link
            href={`/chat?agent=${encodeURIComponent(agent.id)}`}
            onClick={onClose}
            className="btn-pill btn-pill-dark block w-full text-center"
          >
            Chat with {agent.name}
          </Link>
        </footer>
      </aside>
    </>
  );
}
