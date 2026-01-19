import { NextResponse } from "next/server";

const LT_MONTH_TO_NUM: Record<string, number> = {
  sausis: 1,
  vasaris: 2,
  kovas: 3,
  balandis: 4,
  gegužė: 5,
  geguze: 5,
  birželis: 6,
  birzelis: 6,
  liepa: 7,
  rugpjūtis: 8,
  rugpjutis: 8,
  rugsėjis: 9,
  rugsejis: 9,
  spalis: 10,
  lapkritis: 11,
  gruodis: 12,
};

function parseLtFixVersion(
  name: string,
): { year: number; month: number } | null {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return null;

  const year = Number(parts[0]);
  if (!Number.isFinite(year) || year < 2000 || year > 2100) return null;

  const monthNameRaw = parts.slice(1).join(" ").toLowerCase();
  const month =
    LT_MONTH_TO_NUM[monthNameRaw] ?? LT_MONTH_TO_NUM[parts[1].toLowerCase()];
  if (!month) return null;

  return { year, month };
}

function monthKey(p: { year: number; month: number }) {
  return p.year * 100 + p.month;
}

function mustGetEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

type TrimmedIssue = { key: string; summary: string; url: string };

export async function GET() {
  try {
    const baseUrl = mustGetEnv("JIRA_BASE_URL");
    const email = mustGetEnv("JIRA_EMAIL");
    const token = mustGetEnv("JIRA_API_TOKEN");

    // NOTE: no statusCategory filter since you decided you want to see them all
    const jql = `project = IMOSHELP AND fixVersion IS NOT EMPTY ORDER BY updated DESC`;

    const url = `${baseUrl}/rest/api/3/search/jql`;
    const auth = Buffer.from(`${email}:${token}`).toString("base64");

    // Fetch all pages
    const allIssuesRaw: any[] = [];
    let nextPageToken: string | null = null;
    let safety = 0;

    while (safety < 30) {
      safety += 1;

      const body: any = {
        jql,
        maxResults: 100,
        fields: ["summary", "fixVersions"],
      };

      if (nextPageToken) body.nextPageToken = nextPageToken;

      const r = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
      });

      if (!r.ok) {
        const text = await r.text();
        return NextResponse.json(
          { error: "Jira request failed", status: r.status, details: text },
          { status: 502 },
        );
      }

      const data = await r.json();
      allIssuesRaw.push(...(data.issues ?? []));

      nextPageToken = data.nextPageToken ?? null;
      const isLast = data.isLast ?? true;
      if (isLast || !nextPageToken) break;
    }

    // Group by Fix Version
    const groupsMap = new Map<
      string,
      { fixVersion: string; released: boolean | null; issues: TrimmedIssue[] }
    >();

    for (const raw of allIssuesRaw) {
      const key: string = raw.key;
      const summary: string = raw.fields?.summary ?? "";
      const issue: TrimmedIssue = {
        key,
        summary,
        url: `${baseUrl}/browse/${key}`,
      };

      const fixVersions = raw.fields?.fixVersions ?? [];
      const seen = new Set<string>();

      for (const fv of fixVersions) {
        const name: string | undefined = fv?.name;
        if (!name) continue;
        if (seen.has(name)) continue;
        seen.add(name);

        if (!groupsMap.has(name)) {
          groupsMap.set(name, {
            fixVersion: name,
            released: fv?.released ?? null,
            issues: [],
          });
        }

        groupsMap.get(name)!.issues.push(issue);
      }
    }

    // Sort groups newest first
    const groups = Array.from(groupsMap.values()).sort((a, b) => {
      const pa = parseLtFixVersion(a.fixVersion);
      const pb = parseLtFixVersion(b.fixVersion);

      if (!pa && !pb) return a.fixVersion.localeCompare(b.fixVersion);
      if (!pa) return 1;
      if (!pb) return -1;

      return monthKey(pb) - monthKey(pa);
    });

    return NextResponse.json({
      total: allIssuesRaw.length,
      groups,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: "Server error", details: err?.message ?? String(err) },
      { status: 500 },
    );
  }
}
