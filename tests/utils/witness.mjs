// @ts-check
import { judgeLogEntry, judgeResponse, judgeSettledLoadingFailure } from "./witness-verdict.mjs";

/** @param {{ value?: unknown, description?: string }} arg */
const remoteObjectText = (arg) => String(arg.value ?? arg.description ?? "");

/** @param {import('@playwright/test').Page} page */
export async function attachClientWitness(page) {
  const client = await page.context().newCDPSession(page);
  await client.send("Page.enable");
  const { frameTree } = await client.send("Page.getFrameTree");
  const mainFrameId = frameTree.frame.id;

  /** @type {{ kind: string, page: string, detail: string }[]} */
  const findings = [];
  /** @type {Map<string, (() => void)[]>} */
  const findingWaiters = new Map();
  /** @param {string} kind @param {string} detail */
  const found = (kind, detail) => {
    findings.push({ kind, page: page.url(), detail });
    for (const notify of findingWaiters.get(kind)?.splice(0) ?? []) notify();
  };
  /** @param {{ kind: string, detail: string }[]} judged */
  const collect = (judged) => {
    for (const { kind, detail } of judged) found(kind, detail);
  };

  /** @type {Map<string, { requestUrl: string, documentURL: string, loaderId: string }>} */
  const requests = new Map();
  /** @type {Set<string>} */
  const failedPrefetchRequestIds = new Set();
  /** @type {Set<string>} */
  const failedPrefetchPipelineIds = new Set();

  // The outgoing document remains live until frameNavigated commits its replacement.
  let liveLoaderId = frameTree.frame.loaderId;
  client.on("Page.frameNavigated", ({ frame }) => {
    if (frame.id === mainFrameId) {
      liveLoaderId = frame.loaderId;
      notifyDrained();
    }
  });

  // CDP domains may report one failed prefetch in either order, so judge after correlation.
  /** @type {{ requestId: string, requestUrl: string, loaderId: string, errorText: string, canceled?: boolean, blockedReason?: string, type?: string }[]} */
  const loadingFailures = [];

  /** @type {Set<string>} */
  const open = new Set();
  /** @type {(() => void)[]} */
  const drainWaiters = [];
  const openForLiveDocument = () =>
    [...open].filter((id) => (requests.get(id)?.loaderId ?? liveLoaderId) === liveLoaderId);
  const notifyDrained = () => {
    if (openForLiveDocument().length === 0) for (const notify of drainWaiters.splice(0)) notify();
  };
  /** @param {string} requestId */
  const terminal = (requestId) => {
    open.delete(requestId);
    notifyDrained();
  };

  /** @param {string} requestId @param {string} url @param {number} status */
  const judge = (requestId, url, status) => {
    collect(
      judgeResponse({ url, documentURL: requests.get(requestId)?.documentURL ?? url, status }),
    );
  };

  client.on("Runtime.consoleAPICalled", (params) => {
    const text = params.args.map(remoteObjectText).join(" ");
    found("console", `console.${params.type}: ${text}`);
  });
  client.on("Runtime.exceptionThrown", (params) => {
    const { text, exception, url } = params.exceptionDetails;
    found("exception", `${text} ${remoteObjectText(exception ?? {})} at ${url ?? "?"}`);
  });
  client.on("Log.entryAdded", ({ entry }) => {
    const judged = judgeLogEntry(entry);
    if (judged) found(judged.kind, judged.detail);
  });
  client.on("Audits.issueAdded", ({ issue }) => {
    found("issue", issue.code);
  });
  client.on("Page.javascriptDialogOpening", (params) => {
    found("dialog", `${params.type}: ${params.message}`);
  });
  client.on("Inspector.targetCrashed", () => {
    found("crash", "renderer target crashed");
  });
  client.on("Preload.prefetchStatusUpdated", (params) => {
    if (params.status !== "Failure") return;
    failedPrefetchRequestIds.add(params.requestId);
    if (failedPrefetchPipelineIds.has(params.pipelineId)) return;
    failedPrefetchPipelineIds.add(params.pipelineId);
    found("prefetch", `${params.prefetchUrl}: ${params.prefetchStatus}`);
  });

  client.on("Network.requestWillBeSent", (params) => {
    if (params.redirectResponse) {
      judge(params.requestId, params.redirectResponse.url, params.redirectResponse.status);
    }
    requests.set(params.requestId, {
      requestUrl: params.request.url,
      documentURL: params.documentURL,
      loaderId: params.loaderId,
    });
    open.add(params.requestId);
  });
  client.on("Network.responseReceived", (params) => {
    judge(params.requestId, params.response.url, params.response.status);
  });
  client.on("Network.loadingFinished", (params) => terminal(params.requestId));
  client.on("Network.requestServedFromCache", (params) => terminal(params.requestId));
  client.on("Network.loadingFailed", (params) => {
    const record = requests.get(params.requestId);
    loadingFailures.push({
      requestId: params.requestId,
      canceled: params.canceled,
      blockedReason: params.blockedReason,
      type: params.type,
      requestUrl: record?.requestUrl ?? "?",
      loaderId: record?.loaderId ?? liveLoaderId,
      errorText: params.errorText,
    });
    terminal(params.requestId);
  });

  await client.send("Runtime.enable");
  await client.send("Log.enable");
  await client.send("Network.enable");
  await client.send("Audits.enable");
  await client.send("Inspector.enable");
  await client.send("Preload.enable");

  return {
    findings: () => [...findings],
    /** @param {string} kind */
    awaitFinding: (kind) =>
      findings.some((finding) => finding.kind === kind)
        ? Promise.resolve()
        : new Promise((resolve) => {
            const waiters = findingWaiters.get(kind) ?? [];
            waiters.push(() => resolve(undefined));
            findingWaiters.set(kind, waiters);
          }),
    settle: async () => {
      await /** @type {Promise<void>} */ (
        new Promise((resolve) => {
          const check = () => {
            if (openForLiveDocument().length === 0) resolve();
            else drainWaiters.push(check);
          };
          check();
        })
      );
      await client.send("Runtime.evaluate", { expression: "1" });
      for (const failure of loadingFailures.splice(0)) {
        const judged = judgeSettledLoadingFailure({
          ...failure,
          failedPrefetchRequestIds,
          liveLoaderId,
        });
        if (judged) found(judged.kind, judged.detail);
      }
    },
    detach: () => client.detach(),
  };
}
