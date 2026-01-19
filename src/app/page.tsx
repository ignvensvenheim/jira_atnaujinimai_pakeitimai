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
  attachments: Array<{
    id: string;
    filename: string;
    mimeType: string | null;
    size: number | null;
    contentUrl: string;
  }>;
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

  // Initial load: groups
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

      // Open all months by default
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

  // ESC closes modal
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
            {/* If you want meta under logo later, you already have header__meta in CSS */}
          </div>

          <div className={styles.header__right}>
            {/* This is a title; keep it as a heading for semantics */}
            <h1 className={styles.header__title}>
              IMOS mėnesiniai atnaujinimai
            </h1>
            {/* Optional meta line */}
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
              <input
                className={styles.dashboard__search}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search (key, summary, month…)"
              />

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

          {loading && <div className={styles.dashboard__status}>Loading…</div>}

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
                        {/* Colgroup makes column widths consistent across every month */}
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

        {/* Modal */}
        {selectedKey && (
          <div className={styles.modal} onClick={closeModal}>
            <div
              className={styles.modal__panel}
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
            >
              <div className={styles.modal__top}>
                <div>
                  <div className={styles.modal__heading}>
                    {details?.key ?? selectedKey} — {details?.summary ?? ""}
                  </div>
                  <div className={styles.modal__sub}>
                    Status: <b>{details?.status ?? "—"}</b> • Assignee:{" "}
                    <b>{details?.assignee ?? "—"}</b> • Priority:{" "}
                    <b>{details?.priority ?? "—"}</b>
                    <div>
                      Created: <b>{formatDate(details?.created ?? null)}</b>
                    </div>
                  </div>
                </div>

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

              {detailsLoading && (
                <div className={styles.dashboard__status}>Loading details…</div>
              )}

              {detailsError && (
                <div className={styles.dashboard__error}>
                  <b>Error:</b> {detailsError}
                </div>
              )}

              {details && (
                <div className={styles.modal__grid}>
                  {/* Left */}
                  <div>
                    <h3 className={styles.modal__sectionTitle}>Description</h3>
                    <pre className={styles.modal__pre}>
                      {details.descriptionText || "—"}
                    </pre>

                    <h3 className={styles.modal__sectionTitle}>
                      Comments ({details.comments.length})
                    </h3>

                    {details.comments.length === 0 ? (
                      <div className={styles.dashboard__status}>
                        No comments.
                      </div>
                    ) : (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 10,
                        }}
                      >
                        {details.comments.map((c) => (
                          <div key={c.id} className={styles.modal__comment}>
                            <div className={styles.modal__commentMeta}>
                              <b>{c.author}</b> • {formatDate(c.created)}
                            </div>
                            <pre className={styles.modal__pre}>
                              {c.bodyText || "—"}
                            </pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Right */}
                  <div>
                    <h3 className={styles.modal__sectionTitle}>
                      Attachments ({details.attachments.length})
                    </h3>

                    {details.attachments.length === 0 ? (
                      <div className={styles.dashboard__status}>
                        No attachments.
                      </div>
                    ) : (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 8,
                        }}
                      >
                        {details.attachments.map((a) => {
                          const proxyUrl = `/api/attachment?contentUrl=${encodeURIComponent(a.contentUrl)}&filename=${encodeURIComponent(a.filename)}`;
                          const isImage = (a.mimeType ?? "")
                            .toLowerCase()
                            .startsWith("image/");

                          return (
                            <div
                              key={a.id}
                              className={styles.modal__attachment}
                            >
                              <div className={styles.modal__attachmentName}>
                                {a.filename}
                              </div>
                              <div className={styles.modal__attachmentMeta}>
                                {a.mimeType ?? "file"}
                                {typeof a.size === "number"
                                  ? ` • ${Math.round(a.size / 1024)} KB`
                                  : ""}
                              </div>

                              {isImage && (
                                <img
                                  className={styles.modal__img}
                                  src={proxyUrl}
                                  alt={a.filename}
                                  loading="lazy"
                                />
                              )}

                              <a
                                className={styles.modal__link}
                                href={proxyUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open / download ↗
                              </a>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <a
                      className={styles.modal__link}
                      href={details.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open in Jira ↗
                    </a>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </>
  );
}
