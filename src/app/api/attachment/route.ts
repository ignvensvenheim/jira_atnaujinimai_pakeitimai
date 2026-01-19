import { NextResponse } from "next/server";

function mustGetEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const contentUrl = searchParams.get("contentUrl");
    const filename = searchParams.get("filename") ?? "attachment";

    if (!contentUrl) {
      return NextResponse.json(
        { error: "Missing contentUrl" },
        { status: 400 },
      );
    }

    const email = mustGetEnv("JIRA_EMAIL");
    const token = mustGetEnv("JIRA_API_TOKEN");
    const auth = Buffer.from(`${email}:${token}`).toString("base64");

    const r = await fetch(contentUrl, {
      headers: { Authorization: `Basic ${auth}` },
      cache: "no-store",
    });

    if (!r.ok) {
      const text = await r.text();
      return NextResponse.json(
        { error: "Attachment fetch failed", status: r.status, details: text },
        { status: 502 },
      );
    }

    const contentType =
      r.headers.get("content-type") ?? "application/octet-stream";
    const arrayBuffer = await r.arrayBuffer();

    return new NextResponse(arrayBuffer, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `inline; filename="${filename.replaceAll('"', "")}"`,
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: "Server error", details: err?.message ?? String(err) },
      { status: 500 },
    );
  }
}
