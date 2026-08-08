// @ts-check
export const FINDING_KINDS = Object.freeze([
  "console",
  "exception",
  "log-entry",
  "issue",
  "dialog",
  "crash",
  "prefetch",
  "response-status",
  "cross-origin",
  "loading-failed",
]);

// Policy: browser traffic may be fresh, no-content telemetry, or revalidated.
export const ALLOWED_STATUSES = new Set([200, 204, 304]);

// Avoid duplicate findings from dedicated Runtime and Network channels.
export const LOG_SOURCES_JUDGED_ELSEWHERE = new Set(["javascript", "network"]);

/**
 * @param {{ url: string, documentURL: string, status: number }} response
 * @returns {{ kind: string, detail: string }[]}
 */
export function judgeResponse({ url, documentURL, status }) {
  const findings = [];
  if (!ALLOWED_STATUSES.has(status)) {
    findings.push({ kind: "response-status", detail: `${url} → status ${status}` });
  }
  if (new URL(url).origin !== new URL(documentURL).origin) {
    findings.push({ kind: "cross-origin", detail: `${url} requested by ${documentURL}` });
  }
  return findings;
}

/** @param {{ source: string, level: string, text: string }} entry */
export function judgeLogEntry({ source, level, text }) {
  if (LOG_SOURCES_JUDGED_ELSEWHERE.has(source)) return null;
  return { kind: "log-entry", detail: `[${source}/${level}] ${text}` };
}

/**
 * @param {{ canceled?: boolean, blockedReason?: string, type?: string, requestUrl: string, errorText: string }} failure
 * @returns {{ verdict: "finding", detail: string } | { verdict: "excused" } | { verdict: "defer" }}
 */
export function judgeLoadingFailed({ canceled, blockedReason, type, requestUrl, errorText }) {
  const cancellation = canceled === true && !blockedReason;
  if (cancellation && type === "Ping") return { verdict: "excused" };
  if (cancellation && type !== "Document") return { verdict: "defer" };
  const blocked = blockedReason ? ` (blocked: ${blockedReason})` : "";
  return { verdict: "finding", detail: `${requestUrl}: ${errorText}${blocked}` };
}

/** @param {{ loaderId: string, liveLoaderId: string }} deferred */
export function isUnexplainedCancellation({ loaderId, liveLoaderId }) {
  return loaderId === liveLoaderId;
}

/**
 * @param {{
 *   failedPrefetchRequestIds: ReadonlySet<string>,
 *   requestId: string,
 *   loaderId: string,
 *   liveLoaderId: string,
 *   canceled?: boolean,
 *   blockedReason?: string,
 *   type?: string,
 *   requestUrl: string,
 *   errorText: string
 * }} observed
 */
export function judgeSettledLoadingFailure({
  failedPrefetchRequestIds,
  requestId,
  loaderId,
  liveLoaderId,
  canceled,
  blockedReason,
  type,
  requestUrl,
  errorText,
}) {
  if (failedPrefetchRequestIds.has(requestId)) return null;
  const judged = judgeLoadingFailed({ canceled, blockedReason, type, requestUrl, errorText });
  if (judged.verdict === "finding") return { kind: "loading-failed", detail: judged.detail };
  if (judged.verdict === "defer" && isUnexplainedCancellation({ loaderId, liveLoaderId })) {
    return { kind: "loading-failed", detail: `${requestUrl}: ${errorText}` };
  }
  return null;
}
