import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchLocalLlmSwitchStatus,
  switchLocalLlmRuntime,
} from "../../api/client";
import type { LocalLlmLabels, LocalLlmSwitchStatus } from "../../api/types";
import { Panel } from "../ui/Panel";
import { BotIcon } from "../ui/icons";

const CONTROL_KEY_STORAGE = "sparkdash.eco.key";
const STATUS_POLL_MS = 2000;

type Target = "deepseek" | "qwen" | "glm";

// Fallbacks for before the first status poll resolves; the status endpoint
// serves the deployment-configured labels (LOCAL_LLM_LABEL_* in .env).
const FALLBACK_LABELS: LocalLlmLabels = {
  deepseek: "DeepSeek",
  qwen: "Qwen",
  glm: "GLM",
};

const TARGET_KEYS: Target[] = ["deepseek", "qwen", "glm"];

function readStoredKey() {
  try {
    return localStorage.getItem(CONTROL_KEY_STORAGE)?.trim() || null;
  } catch {
    return null;
  }
}

function storeKey(key: string) {
  try {
    localStorage.setItem(CONTROL_KEY_STORAGE, key);
  } catch {
    /* private mode / blocked storage */
  }
}

function clearStoredKey() {
  try {
    localStorage.removeItem(CONTROL_KEY_STORAGE);
  } catch {
    /* ignore */
  }
}

function runtimeLabel(runtime: LocalLlmSwitchStatus["current"], labels: LocalLlmLabels) {
  if (runtime === "stopped") return "Stopped";
  if (runtime === "unknown") return "Unknown";
  return labels[runtime as Target] ?? FALLBACK_LABELS[runtime as Target];
}

function phaseLabel(phase: LocalLlmSwitchStatus["phase"]) {
  const labels: Record<LocalLlmSwitchStatus["phase"], string> = {
    idle: "Idle",
    stopping: "Stopping current runtime",
    starting: "Starting selected runtime",
    verifying: "Verifying API model ID",
    "rolling-back": "Restoring previous runtime",
    "cleaning-up": "Cleaning up failed runtime",
    complete: "Complete",
    error: "Failed",
  };
  return labels[phase];
}

export function LocalLlmControl() {
  const [status, setStatus] = useState<LocalLlmSwitchStatus | null>(null);
  const [target, setTarget] = useState<Target>("deepseek");
  const [requesting, setRequesting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const targetInitialized = useRef(false);

  const applyStatus = useCallback((next: LocalLlmSwitchStatus) => {
    setStatus(next);
    setLoadError(null);
    if (!targetInitialized.current) {
      if (next.current === "deepseek" || next.current === "qwen" || next.current === "glm")
        setTarget(next.current);
      targetInitialized.current = true;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const next = await fetchLocalLlmSwitchStatus();
        if (!cancelled) applyStatus(next);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Runtime status unavailable");
        }
      } finally {
        if (!cancelled) timer = setTimeout(poll, STATUS_POLL_MS);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [applyStatus]);

  const switching = requesting || status?.state === "switching";
  const labels = status?.labels ?? FALLBACK_LABELS;
  const isCurrentTarget =
    status?.state === "idle" && status.health === "healthy" && status.current === target;
  const writesDisabled = status?.writesEnabled === false;

  const handleSwitch = useCallback(async () => {
    if (switching || writesDisabled || isCurrentTarget) return;
    const current = status ? runtimeLabel(status.current, labels) : "current runtime";
    if (
      !window.confirm(
        `Switch Local LLM from ${current} to ${labels[target]}?\n\nActive inference will be interrupted. If startup fails, sparkDash runs its configured cleanup and recovery policy, which may leave port 8888 stopped without restoring the previous runtime.`
      )
    ) {
      return;
    }

    let key = readStoredKey();
    if (!key) {
      key = window.prompt("sparkDash control key (same key used by ECO mode):", "")?.trim() || null;
      if (!key) return;
    }

    setRequesting(true);
    setLoadError(null);
    try {
      const result = await switchLocalLlmRuntime(target, key);
      storeKey(key);
      setStatus((previous) => ({
        ...result,
        writesEnabled: previous?.writesEnabled ?? true,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start runtime switch";
      if (/key/i.test(message)) clearStoredKey();
      setLoadError(message);
    } finally {
      setRequesting(false);
    }
  }, [isCurrentTarget, labels, status, switching, target, writesDisabled]);

  const statusTone =
    status?.state === "error"
      ? "bg-danger"
      : status?.state === "switching"
        ? "bg-warning"
        : status?.health === "healthy"
          ? "bg-success"
          : "bg-muted";

  return (
    <Panel
      title="Local LLM Runtime"
      icon={<BotIcon />}
      accent={status?.health === "healthy"}
      className="md:col-span-2"
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${statusTone}`} />
              <span className="text-sm font-semibold text-text-strong">
                {status ? runtimeLabel(status.current, labels) : "Checking runtime…"}
              </span>
              {status?.health === "healthy" && (
                <span className="rounded bg-success/10 px-1.5 py-0.5 text-[10px] text-success">
                  Healthy
                </span>
              )}
            </div>
            <p className="break-all font-mono text-[10px] text-muted">
              {status?.currentModelId || "No verified model ID"}
            </p>
          </div>
          {status && (
            <div className="text-right text-[10px] text-muted" aria-live="polite">
              <div>{phaseLabel(status.phase)}</div>
              <div>{status.message}</div>
            </div>
          )}
        </div>

        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-wide text-muted">Switch to</span>
            <select
              value={target}
              onChange={(event) => setTarget(event.target.value as Target)}
              disabled={switching}
              className="w-full rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs text-text outline-none focus:border-accent disabled:opacity-50"
              aria-label="Local LLM runtime target"
            >
              {TARGET_KEYS.map((key) => (
                <option key={key} value={key}>
                  {labels[key]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void handleSwitch()}
            disabled={switching || writesDisabled || isCurrentTarget || !status}
            className="rounded-md bg-accent px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {switching ? "Switching…" : isCurrentTarget ? "Currently running" : "Switch runtime"}
          </button>
        </div>

        <p className="text-[10px] leading-relaxed text-muted">
          This controls the two-node inference runtime on port 8888. After it completes, select the same model in Hermes; existing Hermes sessions are not changed automatically.
        </p>

        {writesDisabled && (
          <p className="text-[11px] text-danger">
            Runtime switching is disabled because the sparkDash control key is not configured.
          </p>
        )}
        {loadError && <p className="text-[11px] text-danger">{loadError}</p>}
        {status?.error && (
          <div className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-[11px] text-danger">
            <div>{status.error}</div>
            {status.rollback?.attempted && (
              <div className="mt-1">
                Rollback: {status.rollback.succeeded ? "previous runtime restored" : status.rollback.error || "failed"}
              </div>
            )}
          </div>
        )}

        {status?.failureLog && status.failureLog.length > 0 && (
          <details className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2">
            <summary className="cursor-pointer text-[10px] text-danger">Failed switch output</summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-danger">
              {status.failureLog.join("\n")}
            </pre>
          </details>
        )}

        {status?.log && status.log.length > 0 && (
          <details className="rounded-md border border-border bg-surface-elevated px-3 py-2">
            <summary className="cursor-pointer text-[10px] text-muted">Lifecycle log</summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-muted">
              {status.log.join("\n")}
            </pre>
          </details>
        )}
      </div>
    </Panel>
  );
}
