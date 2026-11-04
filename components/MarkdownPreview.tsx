"use client";

// Lightweight markdown renderer for wiki pages — handles the constructs
// the agent wikis actually use: frontmatter, H1-H4, `-` bullets,
// `> blockquotes`, **bold**, *italic*, [[wikilink]], `inline code`.
// Tables / images / nested lists deliberately not supported (the wikis
// don't use them).
//
// Pixel-societies brutalist palette — 3px borders, mono-uppercase
// eyebrows, cream cards. Originally lifted from app/graph/GraphView.tsx
// (same shape, restyled).

import React from "react";

export default function MarkdownPreview({ text }: { text: string }) {
  // Strip leading frontmatter blocks (there can be more than one).
  let body = text;
  while (body.startsWith("---\n")) {
    const end = body.indexOf("\n---", 4);
    if (end === -1) break;
    body = body.slice(end + 4).replace(/^\n+/, "");
  }

  const inlineRe = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[\[[^\]\n]+\]\]|`[^`\n]+`)/g;
  function inline(t: string, k0: string) {
    const out: React.ReactNode[] = [];
    let last = 0;
    let i = 0;
    let m: RegExpExecArray | null;
    while ((m = inlineRe.exec(t)) !== null) {
      if (m.index > last) out.push(<span key={`${k0}-${i++}`}>{t.slice(last, m.index)}</span>);
      const tok = m[0];
      if (tok.startsWith("**")) {
        out.push(<strong key={`${k0}-${i++}`}>{tok.slice(2, -2)}</strong>);
      } else if (tok.startsWith("[[")) {
        const inner = tok.slice(2, -2);
        const display = inner.split("|")[1] || inner.split("|")[0];
        out.push(
          <span
            key={`${k0}-${i++}`}
            className="border-[2px] border-[#cdd5e0] bg-[#f6f4ea] px-1.5 py-[1px] font-mono text-[10px] text-[#1f2a3c]"
          >
            {display}
          </span>,
        );
      } else if (tok.startsWith("`")) {
        out.push(
          <code
            key={`${k0}-${i++}`}
            className="border-[1px] border-[#cdd5e0] bg-[#f6f4ea] px-1 font-mono text-[11px]"
          >
            {tok.slice(1, -1)}
          </code>,
        );
      } else {
        out.push(<em key={`${k0}-${i++}`}>{tok.slice(1, -1)}</em>);
      }
      last = m.index + tok.length;
    }
    if (last < t.length) out.push(<span key={`${k0}-${i++}`}>{t.slice(last)}</span>);
    return out;
  }

  const lines = body.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^#{4,}\s+/.test(line)) {
      blocks.push(
        <h4
          key={key++}
          className="mt-3 mb-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#637387]"
        >
          {line.replace(/^#+\s+/, "")}
        </h4>,
      );
      i++;
    } else if (line.startsWith("### ")) {
      blocks.push(
        <h3 key={key++} className="mt-3 mb-1 text-[14px] font-bold text-[#1f2a3c]">
          {line.slice(4)}
        </h3>,
      );
      i++;
    } else if (line.startsWith("## ")) {
      blocks.push(
        <h2 key={key++} className="mt-4 mb-1 text-[16px] font-bold text-[#1f2a3c]">
          {line.slice(3)}
        </h2>,
      );
      i++;
    } else if (line.startsWith("# ")) {
      blocks.push(
        <h1 key={key++} className="mt-2 mb-2 text-[20px] font-bold text-[#1f2a3c]">
          {line.slice(2)}
        </h1>,
      );
      i++;
    } else if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul
          key={key++}
          className="my-2 list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-[#4f5c6d]"
        >
          {items.map((it, idx) => (
            <li key={idx}>{inline(it, `b${key}-${idx}`)}</li>
          ))}
        </ul>,
      );
    } else if (line.startsWith("> ")) {
      blocks.push(
        <blockquote
          key={key++}
          className="my-2 border-l-[3px] border-[#1f2a3c] pl-3 text-[12px] italic text-[#637387]"
        >
          {inline(line.slice(2), `q${key}`)}
        </blockquote>,
      );
      i++;
    } else if (line.trim() === "") {
      i++;
    } else {
      const para: string[] = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== "" && !/^[#\->*]/.test(lines[i].trim())) {
        para.push(lines[i]);
        i++;
      }
      blocks.push(
        <p
          key={key++}
          className="my-2 text-[13px] leading-relaxed text-[#4f5c6d]"
        >
          {inline(para.join(" "), `p${key}`)}
        </p>,
      );
    }
  }
  return <div className="text-[#1f2a3c]">{blocks}</div>;
}
