import { NextResponse } from "next/server";

function mustGetEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function escapePlaceholderValue(value: string) {
  return value.replace(/[|[\]]/g, " ").trim();
}

function placeholderFromAttachmentRef(attachment?: {
  id?: string | number;
  filename?: string;
}) {
  const id = attachment?.id ? escapePlaceholderValue(String(attachment.id)) : "";
  const name = attachment?.filename
    ? escapePlaceholderValue(String(attachment.filename))
    : "";

  if (id && name) return `[ATTACHMENT_REF:${id}|${name}]`;
  if (id) return `[ATTACHMENT_REF:${id}]`;
  if (name) return `[ATTACHMENT_REF:|${name}]`;
  return "[Attachment]";
}

function mediaPlaceholder(
  attrs: any,
  resolveAttachment?: (attrs: any) => { id?: string | number; filename?: string } | null,
): string {
  const resolved = resolveAttachment?.(attrs);
  if (resolved) return placeholderFromAttachmentRef(resolved);

  const id = attrs?.id ? escapePlaceholderValue(String(attrs.id)) : "";
  const nameCandidates = [
    attrs?.alt,
    attrs?.text,
    attrs?.title,
    attrs?.fileName,
    attrs?.filename,
    attrs?.name,
  ];
  const name = nameCandidates
    .map((v) => (typeof v === "string" ? escapePlaceholderValue(v) : ""))
    .find(Boolean);

  if (id && name) return `[ATTACHMENT_REF:${id}|${name}]`;
  if (id) return `[ATTACHMENT_REF:${id}]`;
  if (name) return `[ATTACHMENT_REF:|${name}]`;
  return "[ATTACHMENT]";
}

function adfToPlainText(
  node: any,
  resolveAttachment?: (attrs: any) => { id?: string | number; filename?: string } | null,
): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) {
    return node.map((child) => adfToPlainText(child, resolveAttachment)).join("");
  }

  if (node.type === "text") {
    const text = node.text ?? "";
    const marks = node.marks ?? [];
    const linkMark = marks.find((m: any) => m?.type === "link");
    const href = linkMark?.attrs?.href;

    if (href) {
      if (text && text.trim() && text.trim() !== href) {
        return `${text} (${href})`;
      }
      return href;
    }

    return text;
  }

  if (node.type === "hardBreak") return "\n";

  if (
    node.type === "inlineCard" ||
    node.type === "blockCard" ||
    node.type === "embedCard"
  ) {
    const url = node?.attrs?.url;
    return url ? `[Link: ${url}]\n` : "[Link]\n";
  }

  if (node.type === "media" || node.type === "mediaInline") {
    return mediaPlaceholder(node.attrs ?? {}, resolveAttachment);
  }

  if (node.type === "mediaSingle" || node.type === "mediaGroup") {
    const content = node.content
      ? adfToPlainText(node.content, resolveAttachment)
      : "";
    return content ? `${content}\n` : "[ATTACHMENT]\n";
  }

  const content = node.content
    ? adfToPlainText(node.content, resolveAttachment)
    : "";

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

  if (blockTypes.has(node.type)) return `${content}\n`;

  return content;
}

function toMs(value: string | null | undefined) {
  if (!value) return Number.NaN;
  return new Date(value).getTime();
}

function isPublicComment(comment: any) {
  if (comment?.jsdPublic === false) return false;
  if (comment?.internal === true) return false;

  const properties = Array.isArray(comment?.properties) ? comment.properties : [];

  for (const property of properties) {
    const key = String(property?.key ?? "");
    const value = property?.value;

    if (key === "sd.public.comment" && value?.internal === true) {
      return false;
    }

    if (key === "sd.allow.public.comment" && value?.allow === false) {
      return false;
    }
  }

  return true;
}

function createSequentialMediaResolver(
  attachments: Array<{
    id: string | number;
    filename: string;
    createdMs: number;
    authorAccountId: string | null;
  }>,
  usedAttachmentIds: Set<string>,
  options: {
    authorAccountId?: string | null;
    createdMs?: number;
  } = {},
) {
  const candidates = attachments
    .filter((attachment) => {
      if (usedAttachmentIds.has(String(attachment.id))) return false;
      if (
        options.authorAccountId &&
        attachment.authorAccountId &&
        attachment.authorAccountId !== options.authorAccountId
      ) {
        return false;
      }
      if (
        Number.isFinite(options.createdMs) &&
        Number.isFinite(attachment.createdMs) &&
        attachment.createdMs > Number(options.createdMs) + 1000
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) => a.createdMs - b.createdMs);

  let index = 0;

  return () => {
    const next = candidates[index];
    if (!next) return null;
    index += 1;
    usedAttachmentIds.add(String(next.id));
    return next;
  };
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
    url.searchParams.set("expand", "properties");

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

    const attachmentsRaw: Array<{
      id: string;
      filename: string;
      mimeType: string | null;
      size: number | null;
      contentUrl: string;
      createdMs: number;
      authorAccountId: string | null;
    }> = (f.attachment ?? []).map((a: any) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType ?? null,
      size: a.size ?? null,
      contentUrl: a.content,
      createdMs: toMs(a.created),
      authorAccountId: a.author?.accountId ?? null,
    }));

    const usedAttachmentIds = new Set<string>();

    function enrichPlaceholders(text: string): string {
      if (!text) return "";
      return text.replace(/\[ATTACHMENT\]/g, "[Attachment]");
    }

    const descriptionResolver = createSequentialMediaResolver(
      attachmentsRaw,
      usedAttachmentIds,
      { createdMs: toMs(f.created) },
    );

    const descriptionText = enrichPlaceholders(
      adfToPlainText(f.description, descriptionResolver).trim(),
    );

    const comments = (f.comment?.comments ?? [])
      .filter((c: any) => isPublicComment(c))
      .map((c: any) => {
        const commentResolver = createSequentialMediaResolver(
          attachmentsRaw,
          usedAttachmentIds,
          {
            authorAccountId: c.author?.accountId ?? null,
            createdMs: toMs(c.created),
          },
        );

        return {
          id: c.id,
          author: c.author?.displayName ?? "Unknown",
          created: c.created ?? null,
          bodyText: enrichPlaceholders(
            adfToPlainText(c.body, commentResolver).trim(),
          ),
        };
      });

    const attachments = attachmentsRaw.map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      contentUrl: a.contentUrl,
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
