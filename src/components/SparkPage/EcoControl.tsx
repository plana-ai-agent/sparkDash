import { useState } from "react";
import {
  CPU_ECO_LEVELS, ECO_LEVELS, fetchCpuEcoStatus, fetchEcoStatus, setCpuEcoLevel, setEcoLevel,
  type CpuEcoLevel, type EcoLevel,
} from "../../api/client";
import { clearControlKey, requestControlKey, storeControlKey } from "../../api/controlKey";
import { useEcoControl, type EcoChannel } from "../../hooks/useEcoControl";
import { BoltIcon } from "../ui/icons";

const GPU: EcoChannel<EcoLevel> = {
  label: "GPU", levels: ECO_LEVELS, offLabel: "Off (uncap)",
  fetchStatus: fetchEcoStatus, setLevel: setEcoLevel, savedLevels: "eco_levels", precision: 0,
  temperature: (line) => Number(line.split(",")[1]),
  formatStatus: (line) => {
    const parts = line.split(",").map((part) => part.trim());
    return parts.length === 3 && parts.every(Boolean)
      ? `${parts[0]} · ${parts[1]}°C · ${parts[2]}` : line;
  },
};
const CPU: EcoChannel<CpuEcoLevel> = {
  label: "CPU", levels: CPU_ECO_LEVELS, offLabel: "Off (stock)",
  fetchStatus: fetchCpuEcoStatus, setLevel: setCpuEcoLevel, savedLevels: "cpu_eco_levels", precision: 1,
  temperature: (line) => Number(line.split(" · ")[1]?.replace("°C", "")),
  formatStatus: (line) => line,
};

function ClockSelector<Level extends string>({ channel, control, busy, compact }: {
  channel: EcoChannel<Level>;
  control: ReturnType<typeof useEcoControl<Level>>;
  busy: boolean;
  compact: boolean;
}) {
  return <>
    <select
      value={control.level}
      onChange={(event) => control.select(event.target.value as Level)}
      disabled={busy}
      aria-label={`${channel.label} clock cap`}
      title={`${channel.label} clock cap; ${channel.offLabel}`}
      className={`rounded border border-border bg-surface-elevated text-[11px] text-text outline-none focus:border-accent disabled:opacity-50 ${compact ? "px-1 py-1" : "px-2.5 py-1.5"}`}
    >
      <option value="" disabled>Select level</option>
      {channel.levels.map((level) => <option key={level} value={level}>
        {level === "off" ? compact ? "Off" : channel.offLabel : `${level} MHz`}
      </option>)}
    </select>
    {!compact && control.status && <span className="font-tabular text-[11px] text-muted" title={control.status}>
      {control.status}
    </span>}
  </>;
}

interface EcoControlProps {
  sparkId?: string;
  fleet?: boolean;
  compact?: boolean;
}

/** Key by destination so pending requests cannot update a different Spark's controls. */
export function EcoControl({ sparkId, fleet = false, compact = false }: EcoControlProps) {
  const node = fleet ? "fleet" : sparkId ?? "fleet";
  return <ClockControls key={node} node={node} compact={compact} />;
}

function ClockControls({ node, compact }: { node: string; compact: boolean }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const gpu = useEcoControl(GPU, node, busy);
  const cpu = useEcoControl(CPU, node, busy);
  const disabled = busy || !gpu.writesEnabled || !cpu.writesEnabled || !gpu.level || !cpu.level;

  async function handleApply() {
    if (disabled || !gpu.level || !cpu.level) return;
    const key = requestControlKey("ECO key (required to change GPU/CPU clocks):");
    if (!key) return;
    setBusy(true);
    setMsg(null);
    try {
      const results = await Promise.allSettled([
        GPU.setLevel(node, gpu.level, key), CPU.setLevel(node, cpu.level, key),
      ]);
      const errors = results.flatMap((result, index) => {
        const label = index === 0 ? "GPU" : "CPU";
        if (result.status === "rejected") {
          const error = result.reason instanceof Error ? result.reason.message : "Failed to apply ECO level";
          return [`${label}: ${error}`];
        }
        return Object.entries(result.value.nodes)
          .filter(([, result]) => result !== "ok")
          .map(([id, error]) => `${label} ${id}: ${error}`);
      });
      if (errors.some((error) => /key/i.test(error))) clearControlKey();
      else if (results.some((result) => result.status === "fulfilled")) storeControlKey(key);
      setMsg(errors.length
        ? { text: errors.join("; "), tone: "err" }
        : { text: `Applied GPU ${gpu.level} · CPU ${cpu.level}${node === "fleet" ? " to fleet" : ""}`, tone: "ok" });
    } finally {
      // Resuming polling immediately refreshes telemetry after both commands finish.
      setBusy(false);
    }
  }

  const statusError = gpu.error || cpu.error;
  return (
    <div
      className={compact ? "flex items-center gap-1" : "panel flex flex-wrap items-center gap-x-3 gap-y-2"}
      style={compact ? undefined : { padding: "var(--density-panel-pad)" }}
    >
      {!compact && <span className="flex items-center gap-1.5 text-[11px] text-muted">
        <BoltIcon className="h-3.5 w-3.5 text-accent" /> ECO
      </span>}
      <ClockSelector channel={GPU} control={gpu} busy={busy} compact={compact} />
      <span aria-hidden className={compact ? "mx-0.5 h-4 w-px bg-border" : "mx-1 h-5 w-px self-stretch bg-border"} />
      <ClockSelector channel={CPU} control={cpu} busy={busy} compact={compact} />
      <button
        type="button"
        onClick={() => void handleApply()}
        disabled={Boolean(disabled)}
        title={gpu.writesEnabled && cpu.writesEnabled
          ? `Apply GPU ${gpu.level} · CPU ${cpu.level} to ${node === "fleet" ? "all Sparks" : "this Spark"}`
          : "ECO controls unavailable; check status and the server control key"}
        className={`flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated text-[11px] text-muted transition-colors hover:bg-accent/15 hover:text-accent disabled:opacity-50 ${compact ? "px-1.5 py-1" : "px-3 py-1.5"}`}
      >
        {busy ? "Applying…" : "Apply"}
      </button>
      {compact && node !== "fleet" && gpu.status?.includes(" · ") && <span
        className="font-tabular text-[11px] text-muted" title={gpu.status}
      >{gpu.status.split(" · ")[0]}</span>}
      {statusError && <span className="text-[11px] text-danger">{statusError}</span>}
      {msg && <span role="status" className={`text-[11px] ${msg.tone === "ok" ? "text-success" : "text-danger"}`}>
        {msg.text}
      </span>}
    </div>
  );
}
