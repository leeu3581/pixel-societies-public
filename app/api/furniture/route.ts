import { NextResponse } from "next/server";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const FURNITURE_DIR = path.join(
  process.cwd(),
  "public",
  "team-office",
  "furniture",
);

type ManifestMember = {
  type?: string;
  id: string;
  file: string;
  width: number;
  height: number;
  footprintW?: number;
  footprintH?: number;
  orientation?: string;
  mirrorSide?: boolean;
  url?: string;
};

type Manifest = {
  id: string;
  name: string;
  category?: string;
  type?: string;
  members?: ManifestMember[];
};

export async function GET() {
  try {
    const entries = await readdir(FURNITURE_DIR, { withFileTypes: true });
    const manifests: Manifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const data = await readFile(
          path.join(FURNITURE_DIR, entry.name, "manifest.json"),
          "utf-8",
        );
        const m = JSON.parse(data) as Manifest;
        if (Array.isArray(m.members)) {
          m.members = m.members.map((mem) => ({
            ...mem,
            url: `/team-office/furniture/${entry.name}/${mem.file}`,
          }));
        }
        manifests.push(m);
      } catch {
        // skip groups whose manifest is missing or unparseable
      }
    }
    manifests.sort((a, b) => {
      const ca = a.category ?? "";
      const cb = b.category ?? "";
      if (ca !== cb) return ca.localeCompare(cb);
      return a.name.localeCompare(b.name);
    });
    return NextResponse.json(
      { manifests },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: "scan failed", details: String(err) },
      { status: 500 },
    );
  }
}
