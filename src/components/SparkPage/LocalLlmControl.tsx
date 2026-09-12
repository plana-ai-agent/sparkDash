import { useCallback, useEffect, useRef, useState } from "react";
import { fetchLocalLlmSwitchStatus, switchLocalLlmRuntime, reconcileLocalLlmRuntime } from "../../api/client";
import { requestControlKey, storeControlKey, clearControlKey } from "../../api/controlKey";
import type { LocalLlmMode, LocalLlmSwitchRequest, LocalLlmSwitchStatus } from "../../api/types";
import { Panel } from "../ui/Panel";
import { BotIcon } from "../ui/icons";

const selectClass = "w-full rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs text-text disabled:opacity-50";
const buttonClass = "rounded-md bg-accent px-3 py-2 text-xs font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50";
const modeLabel = (mode: string) => ({ independent: "Independent · 2 heads", linked: "Linked · head + worker", stopped: "Stopped", unknown: "Unknown configuration" })[mode] || mode;

export function LocalLlmControl({ sparkId }: { sparkId?: string }) {
  const [status, setStatus] = useState<LocalLlmSwitchStatus | null>(null);
  const [mode, setMode] = useState<LocalLlmMode>("independent");
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [linkedRuntime, setLinkedRuntime] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const initialized = useRef(false);
  const revision = useRef(0);
  const submitting = useRef(false);

  const applyStatus = useCallback((next: LocalLlmSwitchStatus) => {
    setStatus(next);
    setLoadError(null);
    // Polls must preserve the user's draft selection.
    if (!initialized.current) {
      setMode(next.current.mode === "linked" ? "linked" : "independent");
      setLinkedRuntime(next.current.mode === "linked" ? next.current.runtime
        : next.runtimes.find((runtime) => runtime.mode === "linked" && !runtime.disabledReason)?.id || "");
      setSelections(Object.fromEntries(next.nodes.map((node) => [node.id,
        next.runtimes.find((runtime) => runtime.id === node.runtime && runtime.mode === "independent")?.id
        || next.runtimes.find((runtime) => runtime.mode === "independent" && runtime.apiNode === node.id && !runtime.disabledReason)?.id || ""])));
      initialized.current = true;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const started = revision.current;
      try {
        const next = await fetchLocalLlmSwitchStatus();
        if (!cancelled && !submitting.current && started === revision.current) applyStatus(next);
      } catch (error) {
        if (!cancelled && !submitting.current && started === revision.current)
          setLoadError(error instanceof Error ? error.message : "Runtime status unavailable");
      } finally {
        if (!cancelled) timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [applyStatus]);

  const busy = requesting || status?.state === "switching";
  const disabled = !status || busy || !status.writesEnabled || status.interrupted || Boolean(status.issues.length) || Boolean(loadError);
  const independentCurrent = status?.current.mode === "independent" || status?.current.mode === "stopped";
  const healthy = Boolean(status?.nodes.every((node) => node.health === "healthy"));
  const unchanged = healthy && (mode === "linked"
    ? status?.current.mode === "linked" && status.current.runtime === linkedRuntime
    : independentCurrent && status?.nodes.every((node) => node.runtime === selections[node.id]));
  const selectable = (id: string) => status?.runtimes.some((runtime) => runtime.id === id && !runtime.disabledReason);
  const completeSelection = mode === "linked" ? selectable(linkedRuntime)
    : Boolean(status?.nodes.length && status.nodes.every((node) => selectable(selections[node.id])));

  const submit = async (selection?: LocalLlmSwitchRequest) => {
    if (submitting.current || busy || !status?.writesEnabled || (selection && disabled)) return;
    if (selection) {
      const affected = "node" in selection ? status.nodes.filter((node) => node.id === selection.node) : status.nodes;
      const target = "node" in selection ? status.runtimes.find((runtime) => runtime.id === selection.target)?.label
        : selection.mode === "linked" ? status.runtimes.find((runtime) => runtime.id === selection.runtime)?.label
          : affected.map((node) => `${node.name}: ${status.runtimes.find((runtime) => runtime.id === selection.selections[node.id])?.label}`).join("\n");
      if (!window.confirm(`Apply ${target}?\n\nInference on changed nodes (${affected.map((node) => node.name).join(", ")}) will be interrupted. Failed changes follow the configured recovery policy.`)) return;
    }
    const key = requestControlKey("sparkDash control key (same key used by ECO mode):");
    if (!key) return;
    submitting.current = true;
    revision.current++;
    setRequesting(true);
    setLoadError(null);
    try {
      applyStatus(selection ? await switchLocalLlmRuntime(selection, key) : await reconcileLocalLlmRuntime(key));
      storeControlKey(key);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Runtime operation failed";
      if (/key/i.test(message)) clearControlKey();
      setLoadError(message);
    } finally {
      revision.current++;
      submitting.current = false;
      setRequesting(false);
    }
  };

  if (status && sparkId && !status.nodes.some((node) => node.id === sparkId)) return null;

  return (
    <Panel title="Local LLM Runtime" icon={<BotIcon />} accent={healthy} className="md:col-span-2">
      <div className="space-y-3">
        <div className="flex flex-wrap justify-between gap-2 text-xs" aria-live="polite">
          <strong className="text-text-strong">{status ? modeLabel(status.current.mode) : "Checking runtimes…"}</strong>
          <span className="text-muted">{status?.message}</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {status?.nodes.map((node) => (
            <div key={node.id} className={`rounded-md border p-2 ${node.id === sparkId ? "border-accent" : "border-border"}`}>
              <div className="flex justify-between gap-2 text-xs"><strong>{node.name}</strong>
                <span className={node.health === "healthy" ? "text-success" : "text-muted"}>{node.health}</span></div>
              <div className="break-all text-[11px] text-muted">
                {status.runtimes.find((runtime) => runtime.id === node.runtime)?.label || "No runtime"}
                {status.current.mode === "linked" && status.runtimes.find((runtime) => runtime.id === node.runtime)?.apiNode !== node.id && " · worker"}
              </div>
              {node.modelId && <div className="break-all font-mono text-[10px] text-muted">{node.modelId} · :{node.port}</div>}
              {status.progress[node.id] && <div className="mt-1 text-[11px] text-muted">{status.progress[node.id].message}</div>}
            </div>
          ))}
        </div>
        <label className="block space-y-1 text-[11px] text-muted">
          <span>Configuration</span>
          <select aria-label="Runtime configuration" className={selectClass} value={mode} disabled={busy} onChange={(event) => setMode(event.target.value as LocalLlmMode)}>
            <option value="independent">Independent · 2 heads</option>
            <option value="linked">Linked · head + worker</option>
          </select>
        </label>
        {mode === "independent" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {status?.nodes.map((node) => (
              <div key={node.id} className="space-y-2">
                <label className="block space-y-1 text-[11px] text-muted">
                  <span>{node.name} model</span>
                  <select aria-label={`${node.name} model`} className={selectClass} value={selections[node.id] || ""} disabled={busy}
                    onChange={(event) => setSelections((previous) => ({ ...previous, [node.id]: event.target.value }))}>
                    {!selections[node.id] && <option value="">No independent runtime configured</option>}
                    {status.runtimes.filter((runtime) => runtime.mode === "independent" && runtime.apiNode === node.id).map((runtime) =>
                      <option key={runtime.id} value={runtime.id} disabled={Boolean(runtime.disabledReason)}>{runtime.label}{runtime.disabledReason && ` · ${runtime.disabledReason}`}</option>)}
                  </select>
                </label>
                {independentCurrent && <button type="button" className={buttonClass}
                  aria-label={`Switch ${node.name}`} disabled={disabled || !selectable(selections[node.id]) || (node.runtime === selections[node.id] && node.health === "healthy")}
                  onClick={() => void submit({ node: node.id, target: selections[node.id] })}>Switch this node</button>}
              </div>
            ))}
          </div>
        ) : (
          <label className="block space-y-1 text-[11px] text-muted">
            <span>Model shared by both nodes</span>
            <select aria-label="Linked runtime model" className={selectClass} value={linkedRuntime} disabled={busy} onChange={(event) => setLinkedRuntime(event.target.value)}>
              {!linkedRuntime && <option value="">No linked runtime configured</option>}
              {status?.runtimes.filter((runtime) => runtime.mode === "linked").map((runtime) => <option key={runtime.id} value={runtime.id} disabled={Boolean(runtime.disabledReason)}>{runtime.label}{runtime.disabledReason && ` · ${runtime.disabledReason}`}</option>)}
            </select>
          </label>
        )}
        <button type="button" className={buttonClass} disabled={disabled || !completeSelection || unchanged}
          onClick={() => void submit(mode === "linked" ? { mode, runtime: linkedRuntime } : { mode, selections })}>
          {busy ? "Switching…" : unchanged ? "Currently running" : mode === "linked" ? "Apply linked configuration" : "Apply independent configuration"}
        </button>
        <p className="text-[10px] leading-relaxed text-muted">
          Independent: each node serves its own model; unchanged nodes keep running. Linked: both nodes serve one model through the head.
          Client model selections are not changed automatically.
        </p>
        {status?.interrupted && <div className="space-y-2 text-[11px] text-warning">
          <p>An unfinished operation was found. Recheck both nodes before switching again.</p>
          <button type="button" className={buttonClass} disabled={busy || !status.writesEnabled} onClick={() => void submit()}>Reconcile interrupted operation</button>
        </div>}
        {status?.writesEnabled === false && <p className="text-[11px] text-danger">Runtime switching requires a configured sparkDash control key.</p>}
        {loadError && <p role="alert" className="text-[11px] text-danger">{loadError}</p>}
        {status?.issues.map((issue) => <p key={issue} className="text-[11px] text-danger">{issue}</p>)}
        {status?.error && <p role="alert" className="text-[11px] text-danger">{status.error}</p>}
        {status?.recoveries.map((recovery, index) => <p key={index} className="text-[11px] text-muted">
          {recovery.nodeIds.map((id) => status.nodes.find((node) => node.id === id)?.name || id).join(", ")}: {recovery.succeeded ? "Previous runtime restored" : recovery.error || "Previous runtime was not restored"}
        </p>)}
        {status && [["Failed switch output", status.failureLog], ["Lifecycle log", status.log]].map(([title, lines]) =>
          Array.isArray(lines) && lines.length > 0 && <details key={String(title)} className="rounded-md border border-border px-3 py-2">
            <summary className="cursor-pointer text-[10px] text-muted">{title}</summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-muted">{lines.join("\n")}</pre>
          </details>)}
      </div>
    </Panel>
  );
}
