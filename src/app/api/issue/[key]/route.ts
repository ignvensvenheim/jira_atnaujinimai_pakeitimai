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

function normalizeFilename(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function isTrueLike(value: unknown) {
  return value === true || value === "true";
}

function isFalseLike(value: unknown) {
  return value === false || value === "false";
}

function isPublicComment(comment: any) {
  if (isFalseLike(comment?.jsdPublic)) return false;
  if (isTrueLike(comment?.internal)) return false;

  const properties = Array.isArray(comment?.properties) ? comment.properties : [];

  for (const property of properties) {
    const key = String(property?.key ?? "");
    const value = property?.value;

    if (
      (key === "sd.public.comment" || key === "sd.comment.public") &&
      isTrueLike(value?.internal)
    ) {
      return false;
    }

    if (key === "sd.allow.public.comment" && isFalseLike(value?.allow)) {
      return false;
    }
  }

  return true;
}

async function fetchAllComments(
  baseUrl: string,
  issueKey: string,
  auth: string,
) {
  const comments: any[] = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const commentsUrl = new URL(
      `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
    );
    commentsUrl.searchParams.set("expand", "properties");
    commentsUrl.searchParams.set("startAt", String(startAt));
    commentsUrl.searchParams.set("maxResults", String(maxResults));

    const response = await fetch(commentsUrl.toString(), {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to load comments (${response.status}): ${text}`);
    }

    const page = await response.json();
    const values = Array.isArray(page?.comments) ? page.comments : [];
    comments.push(...values);

    const total = Number(page?.total ?? comments.length);
    const pageSize = Number(page?.maxResults ?? values.length);
    const nextStart = Number(page?.startAt ?? startAt) + pageSize;

    if (!values.length || nextStart >= total) break;
    startAt = nextStart;
  }

  return comments;
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

  function claimAttachment(attachment?: (typeof candidates)[number] | null) {
    if (!attachment) return null;
    usedAttachmentIds.add(String(attachment.id));
    return attachment;
  }

  let index = 0;

  return (attrs?: any) => {
    const filenameCandidates = [
      attrs?.alt,
      attrs?.fileName,
      attrs?.filename,
      attrs?.name,
      attrs?.title,
      attrs?.text,
    ]
      .map((value) => normalizeFilename(typeof value === "string" ? value : ""))
      .filter(Boolean);

    for (const filename of filenameCandidates) {
      const exactMatch = candidates.find(
        (attachment) =>
          !usedAttachmentIds.has(String(attachment.id)) &&
          normalizeFilename(attachment.filename) === filename,
      );
      if (exactMatch) return claimAttachment(exactMatch);

      const partialMatch = candidates.find(
        (attachment) =>
          !usedAttachmentIds.has(String(attachment.id)) &&
          normalizeFilename(attachment.filename).includes(filename),
      );
      if (partialMatch) return claimAttachment(partialMatch);
    }

    while (index < candidates.length) {
      const next = candidates[index];
      index += 1;
      if (usedAttachmentIds.has(String(next.id))) continue;
      return claimAttachment(next);
    }

    return null;
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

    const [r, commentEntries] = await Promise.all([
      fetch(url.toString(), {
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
        },
        cache: "no-store",
      }),
      fetchAllComments(baseUrl, issueKey, auth),
    ]);

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

    const comments = commentEntries
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
          isPublic: isPublicComment(c),
          id: c.id,
          author: c.author?.displayName ?? "Unknown",
          created: c.created ?? null,
          bodyText: enrichPlaceholders(
            adfToPlainText(c.body, commentResolver).trim(),
          ),
        };
      })
      .filter((c) => c.isPublic)
      .map(({ isPublic: _isPublic, ...comment }) => comment);

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
