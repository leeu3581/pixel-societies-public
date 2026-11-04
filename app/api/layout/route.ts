import { NextResponse } from "next/server";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const LAYOUT_PATH = path.join(
  process.cwd(),
  "public",
  "team-office",
  "default-layout-1.json",
);

export async function GET() {
  try {
    const data = await readFile(LAYOUT_PATH, "utf-8");
    return new NextResponse(data, {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "read failed", details: String(err) },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "disabled in production" }, { status: 403 });
  }
  try {
    const body = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: "bad payload" }, { status: 400 });
    }
    await writeFile(
      LAYOUT_PATH,
      JSON.stringify(body, null, 2) + "\n",
      "utf-8",
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: "write failed", details: String(err) },
      { status: 500 },
    );
  }
}
