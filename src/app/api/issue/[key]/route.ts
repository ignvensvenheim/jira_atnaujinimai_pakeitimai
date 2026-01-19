import { NextResponse } from "next/server";

function mustGetEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

/**
 * Jira description/comment bodies are often ADF (Atlassian Document Format).
 * This converts ADF to readable plain text, and adds placeholders for attachments/images.
 */
function adfToPlainText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToPlainText).join("");

  // Text node (also handle link marks on text)
  if (node.type === "text") {
    const text = node.text ?? "";
    const marks = node.marks ?? [];
    const linkMark = marks.find((m: any) => m?.type === "link");
    const href = linkMark?.attrs?.href;

    // If the text is the URL itself, keep it simple
    if (href) {
      if (text && text.trim() && text.trim() !== href)
        return `${text} (${href})`;
      return href;
    }

    return text;
  }

  // Line break
  if (node.type === "hardBreak") return "\n";

  // Smart links (Jira "embed via link")
  if (
    node.type === "inlineCard" ||
    node.type === "blockCard" ||
    node.type === "embedCard"
  ) {
    const url = node?.attrs?.url;
    return url ? `[Link: ${url}]\n` : "[Link]\n";
  }

  // Media nodes (images/files embedded in description/comments)
  if (node.type === "media") {
    const attrs = node.attrs ?? {};
    const id = attrs.id ?? "";
    return id ? `[ATTACHMENT_ID:${id}]` : "[ATTACHMENT]";
  }

  if (node.type === "mediaSingle" || node.type === "mediaGroup") {
    const content = node.content ? adfToPlainText(node.content) : "";
    return content ? content + "\n" : "[ATTACHMENT]\n";
  }

  // Recurse through children
  const content = node.content ? adfToPlainText(node.content) : "";

  // Add line breaks after block-ish nodes for readability
  const blockTypes = new Set([
    "doc",
    "paragraph",
    "heading",
    "blockquote",
    "listItem",
    "bulletList",
    "orderedList",
    "codeBlock",
    "panel",
    "rule",
    "table",
    "tableRow",
    "tableCell",
  ]);

  if (blockTypes.has(node.type)) return content + "\n";

  return content;
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ key: string }> },
) {
  try {
    const { key } = await context.params;
    const issueKey = key.trim();

    const baseUrl = mustGetEnv("JIRA_BASE_URL");
    const email = mustGetEnv("JIRA_EMAIL");
    const token = mustGetEnv("JIRA_API_TOKEN");

    const auth = Buffer.from(`${email}:${token}`).toString("base64");

    const url = new URL(
      `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
    );
    url.searchParams.set(
      "fields",
      [
        "summary",
        "description",
        "comment",
        "attachment",
        "fixVersions",
        "issuetype",
        "status",
        "assignee",
        "priority",
        "created",
      ].join(","),
    );

    const r = await fetch(url.toString(), {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
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
    const f = data.fields ?? {};

    // Attachments list + lookup by id
    const attachmentsRaw = f.attachment ?? [];
    const attachmentById = new Map<string, any>();
    for (const a of attachmentsRaw) {
      if (a?.id) attachmentById.set(String(a.id), a);
    }

    function placeholderLabelForAttachment(a: any): string {
      const mime = String(a?.mimeType ?? "").toLowerCase();
      const isImage = mime.startsWith("image/");
      const filename = a?.filename ?? "file";
      return isImage ? `[Image: ${filename}]` : `[File: ${filename}]`;
    }

    // Replace [ATTACHMENT_ID:123] placeholders with readable filename labels
    function enrichPlaceholders(text: string): string {
      if (!text) return "";
      return text
        .replace(/\[ATTACHMENT_ID:([^\]]+)\]/g, (_m, id) => {
          const a = attachmentById.get(String(id));
          if (!a) return "[Attachment]";
          return placeholderLabelForAttachment(a);
        })
        .replace(/\[ATTACHMENT\]/g, "[Attachment]");
    }

    const descriptionText = enrichPlaceholders(
      adfToPlainText(f.description).trim(),
    );

    const comments = (f.comment?.comments ?? []).map((c: any) => {
      const raw = adfToPlainText(c.body).trim();
      const bodyText = enrichPlaceholders(raw);

      return {
        id: c.id,
        author: c.author?.displayName ?? "Unknown",
        created: c.created ?? null,
        bodyText,
      };
    });

    const attachments = attachmentsRaw.map((a: any) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType ?? null,
      size: a.size ?? null,
      contentUrl: a.content,
    }));

    return NextResponse.json({
      key: data.key,
      url: `${baseUrl}/browse/${data.key}`,
      summary: f.summary ?? "",
      status: f.status?.name ?? null,
      assignee: f.assignee?.displayName ?? null,
      priority: f.priority?.name ?? null,
      issueType: f.issuetype?.name ?? null,
      created: f.created ?? null,
      fixVersions: (f.fixVersions ?? []).map((v: any) => v.name),
      descriptionText,
      comments,
      attachments,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: "Server error", details: err?.message ?? String(err) },
      { status: 500 },
    );
  }
}
