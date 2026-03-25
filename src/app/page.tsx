"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./page.module.css";
import logo from "../../public/logo.svg";

type Issue = {
  key: string;
  summary: string;
  url: string;
};

type Group = {
  fixVersion: string;
  released: boolean | null;
  issues: Issue[];
};

type ApiResponse = {
  total: number;
  groups: Group[];
};

type Attachment = {
  id: string;
  filename: string;
  mimeType: string | null;
  size: number | null;
  contentUrl: string;
};

type IssueDetails = {
  key: string;
  url: string;
  summary: string;
  status: string | null;
  assignee: string | null;
  priority: string | null;
  issueType: string | null;
  created: string | null;
  fixVersions: string[];
  descriptionText: string;
  comments: Array<{
    id: string;
    author: string;
    created: string | null;
    bodyText: string;
  }>;
  attachments: Attachment[];
};

function normalize(s: string) {
  return s.trim().toLowerCase();
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function attachmentProxyUrl(attachment: Attachment) {
  return `/api/attachment?contentUrl=${encodeURIComponent(attachment.contentUrl)}&filename=${encodeURIComponent(attachment.filename)}`;
}

function renderLinkedText(text: string) {
  const urlRegex = /(https?:\/\/[^\s)]+)(?=[)\]}]?(?:\s|$))/g;
  const parts = text.split(urlRegex);

  return parts.map((part, index) => {
    if (!part) return null;
    if (/^https?:\/\/[^\s)]+$/.test(part)) {
      return (
        <a
          key={`link-${index}`}
          className={styles.modal__textLink}
          href={part}
          target="_blank"
          rel="noreferrer"
        >
          {part}
        </a>
      );
    }

    return <span key={`text-${index}`}>{part}</span>;
  });
}

function normalizeFilename(name: string) {
  return name.trim().toLowerCase();
}

function isDwgLikeFile(filename: string) {
  const lower = normalizeFilename(filename);
  return lower.endsWith(".dwg") || lower.endsWith(".fxf");
}

function isPdfFile(filename: string) {
  return normalizeFilename(filename).endsWith(".pdf");
}

function isOutlookFile(filename: string, mimeType: string | null) {
  const lower = normalizeFilename(filename);
  const mime = (mimeType ?? "").toLowerCase();
  return lower.endsWith(".msg") || mime.includes("vnd.ms-outlook");
}

function findAttachment(
  attachments: Attachment[],
  refId?: string,
  refName?: string,
) {
  if (refId) {
    const byId = attachments.find((a) => String(a.id) === refId);
    if (byId) return byId;
  }

  if (refName) {
    const normalizedRef = normalizeFilename(refName);
    const byName = attachments.find(
      (a) => normalizeFilename(a.filename) === normalizedRef,
    );
    if (byName) return byName;

    const byPartialName = attachments.find((a) =>
      normalizeFilename(a.filename).includes(normalizedRef),
    );
    if (byPartialName) return byPartialName;
  }

  return null;
}

function renderTextWithAttachments(
  text: string,
  attachments: Attachment[],
  emptyFallback = "—",
) {
  const content = text.trim();
  if (!content) {
    return <div className={styles.modal__pre}>{emptyFallback}</div>;
  }

  const parts = content
    .split(/(\[ATTACHMENT_REF:[^\]]+\]|\[ATTACHMENT_ID:[^\]]+\])/g)
    .filter(Boolean);

  return (
    <div className={styles.modal__contentFlow}>
      {parts.map((part, index) => {
        const refMatch = /^\[ATTACHMENT_REF:([^|\]]*)(?:\|([^\]]*))?\]$/.exec(
          part,
        );
        const legacyIdMatch = /^\[ATTACHMENT_ID:([^\]]+)\]$/.exec(part);

        const refId = refMatch?.[1]?.trim() || legacyIdMatch?.[1]?.trim() || "";
        const refName = refMatch?.[2]?.trim() || "";

        if (!refMatch && !legacyIdMatch) {
          if (!part.trim()) return null;
          return (
            <div key={`text-${index}`} className={styles.modal__pre}>
              {renderLinkedText(part)}
            </div>
          );
        }

        const attachment = findAttachment(attachments, refId, refName);
        if (!attachment) {
          return (
            <div key={`missing-${index}`} className={styles.modal__pre}>
              {refName ? `[Attachment: ${refName}]` : "[Attachment]"}
            </div>
          );
        }

        const proxyUrl = attachmentProxyUrl(attachment);
        const isImage = (attachment.mimeType ?? "")
          .toLowerCase()
          .startsWith("image/");
        const isDwgLike = isDwgLikeFile(attachment.filename);
        const isPdf = isPdfFile(attachment.filename);
        const isOutlook = isOutlookFile(
          attachment.filename,
          attachment.mimeType,
        );
        const showImagePreview =
          isImage && !isDwgLike && !isPdf && !isOutlook;

        return (
          <div
            key={`attachment-${attachment.id}-${index}`}
            className={styles.modal__attachmentInline}
          >
            {isDwgLike && (
              <div className={styles.modal__fileIcon} aria-hidden="true">
                DWG
              </div>
            )}

            {isPdf && (
              <div
                className={`${styles.modal__fileIcon} ${styles["modal__fileIcon--pdf"]}`}
                aria-hidden="true"
              >
                PDF
              </div>
            )}

            {isOutlook && (
              <div
                className={`${styles.modal__fileIcon} ${styles["modal__fileIcon--outlook"]}`}
                aria-hidden="true"
              >
                MAIL
              </div>
            )}

            {showImagePreview && (
              <img
                className={styles.modal__img}
                src={proxyUrl}
                alt={attachment.filename}
                loading="lazy"
              />
            )}

            <a
              className={styles.modal__link}
              href={proxyUrl}
              target="_blank"
              rel="noreferrer"
            >
              {showImagePreview ? "Open image ↗" : "Open attachment ↗"}
            </a>
          </div>
        );
      })}
    </div>
  );
}

async function apiJson<T>(
  url: string,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = json?.details
        ? `${json.error}: ${json.details}`
        : (json?.error ?? `Request failed (${res.status})`);
      return { ok: false, error: msg };
    }

    return { ok: true, data: json as T };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export default function Page() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [query, setQuery] = useState("");
  const [openMonths, setOpenMonths] = useState<Record<string, boolean>>({});

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [details, setDetails] = useState<IssueDetails | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

  useEffect(() => {
    let alive = true;

    (async () => {
      setLoading(true);
      setError(null);

      const result = await apiJson<ApiResponse>("/api/issues");

      if (!alive) return;

      if (!result.ok) {
        setError(result.error);
        setData(null);
        setLoading(false);
        return;
      }

      setData(result.data);

      const initial: Record<string, boolean> = {};
      for (const g of result.data.groups ?? []) initial[g.fixVersion] = true;
      setOpenMonths(initial);

      setLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, []);

  const filteredGroups = useMemo(() => {
    if (!data) return [];
    const q = normalize(query);
    if (!q) return data.groups;

    return data.groups
      .map((g) => {
        const issues = g.issues.filter((i) =>
          normalize(`${i.key} ${i.summary} ${g.fixVersion}`).includes(q),
        );
        return { ...g, issues };
      })
      .filter((g) => g.issues.length > 0);
  }, [data, query]);

  const shownTicketsCount = useMemo(() => {
    return filteredGroups.reduce((acc, g) => acc + g.issues.length, 0);
  }, [filteredGroups]);

  const timelineComments = useMemo(() => {
    if (!details) return [];
    return [...details.comments].sort((a, b) => {
      const aTime = a.created ? new Date(a.created).getTime() : 0;
      const bTime = b.created ? new Date(b.created).getTime() : 0;
      return aTime - bTime;
    });
  }, [details]);

  const toggleMonth = useCallback((name: string) => {
    setOpenMonths((prev) => ({ ...prev, [name]: !prev[name] }));
  }, []);

  const openAll = useCallback(() => {
    setOpenMonths((prev) => {
      const next: Record<string, boolean> = { ...prev };
      for (const g of data?.groups ?? []) next[g.fixVersion] = true;
      return next;
    });
  }, [data]);

  const closeAll = useCallback(() => {
    setOpenMonths((prev) => {
      const next: Record<string, boolean> = { ...prev };
      for (const g of data?.groups ?? []) next[g.fixVersion] = false;
      return next;
    });
  }, [data]);

  const closeModal = useCallback(() => {
    setSelectedKey(null);
    setDetails(null);
    setDetailsError(null);
    setDetailsLoading(false);
  }, []);

  const openIssue = useCallback(async (key: string) => {
    const cleanKey = key.trim();
    setSelectedKey(cleanKey);
    setDetails(null);
    setDetailsError(null);
    setDetailsLoading(true);

    const result = await apiJson<IssueDetails>(
      `/api/issue/${encodeURIComponent(cleanKey)}`,
    );

    if (!result.ok) {
      setDetailsError(result.error);
      setDetailsLoading(false);
      return;
    }

    setDetails(result.data);
    setDetailsLoading(false);
  }, []);

  useEffect(() => {
    if (!selectedKey) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeModal();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedKey, closeModal]);

  return (
    <>
      <header className={styles.header}>
        <div className={styles.header__content}>
          <div className={styles.header__left}>
            <Image src={logo} alt="Logo" width={114} height={59} priority />
          </div>

          <div className={styles.header__right}>
            <h1 className={styles.header__title}>IMOS mėnesiniai atnaujinimai</h1>
            {data && (
              <div className={styles.header__meta}>
                Months: <b>{data.groups.length}</b> • Tickets:{" "}
                <b>{shownTicketsCount}</b>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className={styles.dashboard}>
        <div className={styles.dashboard__container}>
          <div
            className={`${styles.dashboard__card} ${styles.dashboard__controls}`}
          >
            <div className={styles.dashboard__controlsRow}>
              <div className={styles.dashboard__searchWrap}>
                <input
                  className={styles.dashboard__search}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search (key, summary, month...)"
                />

                {query && (
                  <button
                    type="button"
                    className={styles.dashboard__clearBtn}
                    onClick={() => setQuery("")}
                    aria-label="Clear search"
                    title="Clear search"
                  >
                    ×
                  </button>
                )}
              </div>

              <button className={styles.dashboard__btn} onClick={openAll}>
                Open all
              </button>
              <button className={styles.dashboard__btn} onClick={closeAll}>
                Close all
              </button>
              <button
                className={styles.dashboard__btn}
                onClick={() => window.location.reload()}
              >
                Refresh
              </button>
            </div>
          </div>

          {loading && <div className={styles.dashboard__status}>Loading...</div>}

          {error && (
            <div className={styles.dashboard__error}>
              <b>Error:</b> {error}
            </div>
          )}

          <div className={styles.dashboard__content}>
            {filteredGroups.map((g) => {
              const isOpen = openMonths[g.fixVersion] ?? true;

              return (
                <div key={g.fixVersion} className={styles.month}>
                  <button
                    className={styles.month__headerBtn}
                    onClick={() => toggleMonth(g.fixVersion)}
                  >
                    <span className={styles.month__title}>{g.fixVersion}</span>
                    <span className={styles.month__chevron}>
                      {isOpen ? "▾" : "▸"}
                    </span>
                  </button>

                  {isOpen && (
                    <div className={styles.month__body}>
                      <table className={styles.tickets}>
                        <colgroup>
                          <col style={{ width: "11%" }} />
                          <col />
                        </colgroup>

                        <thead>
                          <tr>
                            <th className={styles.tickets__headCell}>Key</th>
                            <th className={styles.tickets__headCell}>
                              Summary
                            </th>
                          </tr>
                        </thead>

                        <tbody>
                          {g.issues.map((i) => (
                            <tr
                              key={i.key}
                              className={styles.tickets__row}
                              onClick={() => openIssue(i.key)}
                              role="button"
                              tabIndex={0}
                            >
                              <td
                                className={`${styles.tickets__cell} ${styles["tickets__cell--key"]}`}
                              >
                                <button
                                  className={styles.tickets__keyBtn}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openIssue(i.key);
                                  }}
                                  title="Open details"
                                >
                                  <code className={styles.tickets__keyCode}>
                                    {i.key}
                                  </code>
                                </button>
                              </td>

                              <td
                                className={`${styles.tickets__cell} ${styles["tickets__cell--summary"]}`}
                              >
                                <span className={styles.tickets__summaryText}>
                                  {i.summary}
                                </span>
                              </td>
                            </tr>
                          ))}

                          {g.issues.length === 0 && (
                            <tr>
                              <td className={styles.tickets__cell} colSpan={2}>
                                No tickets.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {selectedKey && (
          <div className={styles.modal} onClick={closeModal}>
            <div
              className={styles.modal__panel}
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
            >
              <div className={styles.modal__top}>
                <div className={styles.modal__hero}>
                  <div className={styles.modal__heading}>
                    {details?.key ?? selectedKey} — {details?.summary ?? ""}
                  </div>
                </div>

                <div className={styles.modal__actions}>
                  {details?.url && (
                    <a
                      className={styles.modal__jiraBtn}
                      href={details.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View in Jira ↗
                    </a>
                  )}

                  <button
                    className={styles.modal__closeBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeModal();
                    }}
                  >
                    Close
                  </button>
                </div>
              </div>

              {detailsLoading && (
                <div className={styles.dashboard__status}>Loading details...</div>
              )}

              {detailsError && (
                <div className={styles.dashboard__error}>
                  <b>Error:</b> {detailsError}
                </div>
              )}

              {details && (
                <div className={styles.modal__main}>
                  <section className={styles.modal__sectionCard}>
                    <div className={styles.modal__commentList}>
                      <div className={styles.modal__comment}>
                        <div className={styles.modal__commentMeta}>
                          <b>{details.key}</b> • {formatDate(details.created)}
                        </div>
                        {renderTextWithAttachments(
                          details.descriptionText,
                          details.attachments,
                        )}
                      </div>

                      {timelineComments.length === 0 ? (
                        <div className={styles.dashboard__status}>No comments.</div>
                      ) : (
                        timelineComments.map((c) => (
                          <div key={c.id} className={styles.modal__comment}>
                            <div className={styles.modal__commentMeta}>
                              <b>{c.author}</b> • {formatDate(c.created)}
                            </div>
                            {renderTextWithAttachments(
                              c.bodyText,
                              details.attachments,
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </section>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </>
  );
}
