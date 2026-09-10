import { useCallback, useEffect, useState } from "react";
import {
  fetchEcoStatus,
  fetchCpuEcoStatus,
  isEcoLevel,
  isCpuEcoLevel,
  setEcoLevel,
  setCpuEcoLevel,
  type EcoLevel,
  type CpuEcoLevel,
} from "../../api/client";
import { BoltIcon } from "../ui/icons";

/** localStorage key for the ECO key (shared GPU/CPU, asked once). */
const ECO_KEY_STORAGE = "sparkdash.eco.key";

const ECO_OPTIONS: { value: EcoLevel; label: string; labelShort: string }[] = [
  { value: "off", label: "Off (uncap)", labelShort: "Off" },
  { value: "2300", label: "2300 MHz", labelShort: "2300 MHz" },
  { value: "2200", label: "2200 MHz", labelShort: "2200 MHz" },
  { value: "2000", label: "2000 MHz", labelShort: "2000 MHz" },
  { value: "1800", label: "1800 MHz", labelShort: "1800 MHz" },
];

const CPU_ECO_OPTIONS: { value: CpuEcoLevel; label: string; labelShort: string }[] = [
  { value: "off", label: "Off (stock)", labelShort: "Off" },
  { value: "2500", label: "2500 MHz", labelShort: "2500 MHz" },
  { value: "2250", label: "2250 MHz", labelShort: "2250 MHz" },
  { value: "2000", label: "2000 MHz", labelShort: "2000 MHz" },
  { value: "1750", label: "1750 MHz", labelShort: "1750 MHz" },
  { value: "1500", label: "1500 MHz", labelShort: "1500 MHz" },
];

function readStoredKey(): string | null {
  try {
    return localStorage.getItem(ECO_KEY_STORAGE)?.trim() || null;
  } catch {
    return null;
  }
}

function storeKey(key: string) {
  try {
    localStorage.setItem(ECO_KEY_STORAGE, key);
  } catch {
    /* private mode / blocked storage */
  }
}

function clearStoredKey() {
  try {
    localStorage.removeItem(ECO_KEY_STORAGE);
  } catch {
    /* ignore */
  }
}

/** Parse a GPU eco status line ("2184 MHz, 39, 8.07 W"); null when malformed. */
function parseGpuLine(line: string): { clock: string; temp: string; power: string } | null {
  const parts = line.split(",").map((p) => p.trim());
  if (parts.length < 3 || parts.some((p) => !p)) return null;
  return { clock: parts[0], temp: parts[1], power: parts[2] };
}

interface EcoControlProps {
  /** Spark id to apply to and show the status readout for. */
  sparkId?: string;
  /** Fleet-wide control (node "fleet"). */
  fleet?: boolean;
  /** Compact variant for the Overview action cluster. */
  compact?: boolean;
}

/**
 * One unified ECO panel: GPU clock cap on the left, CPU clock cap on the
 * right, separated by a vertical divider, with a single Apply button that
 * pushes both selections.
 */
export function EcoControl({ sparkId, fleet = false, compact = false }: EcoControlProps) {
  const [gpuLevel, setGpuLevel] = useState<EcoLevel>("off");
  const [cpuLevel, setCpuLevel] = useState<CpuEcoLevel>("off");
  const [writesEnabled, setWritesEnabled] = useState<boolean | null>(null);
  const [gpuStatus, setGpuStatus] = useState<string | null>(null);
  const [cpuStatus, setCpuStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);

  // Live readouts — loaded on mount, refreshed after each apply, polled every
  // 10s so reloads and out-of-band changes show up.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchEcoStatus()
        .then((res) => {
          if (cancelled) return;
          setWritesEnabled(res.writes_enabled);
          if (sparkId) {
            const stored = res.eco_levels?.[sparkId];
            if (isEcoLevel(stored)) setGpuLevel(stored);
            setGpuStatus(res.nodes[sparkId] ?? "no reply");
          } else if (fleet) {
            const values = Object.values(res.eco_levels ?? {});
            const distinct = [...new Set(values)];
            if (distinct.length === 1 && isEcoLevel(distinct[0])) {
              setGpuLevel(distinct[0]);
            }
            const temps = Object.values(res.nodes)
              .map((s) => Number(s.split(",")[1]))
              .filter(Number.isFinite);
            setGpuStatus(temps.length ? `fleet · ${Math.max(...temps).toFixed(0)}°C` : null);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setWritesEnabled(false);
          setMsg({
            text: err instanceof Error ? err.message : "ECO status unavailable",
            tone: "err",
          });
        });
      fetchCpuEcoStatus()
        .then((res) => {
          if (cancelled) return;
          setWritesEnabled(res.writes_enabled);
          if (sparkId) {
            const stored = res.cpu_eco_levels?.[sparkId];
            if (isCpuEcoLevel(stored)) setCpuLevel(stored);
            setCpuStatus(res.nodes[sparkId] ?? "no reply");
          } else if (fleet) {
            const values = Object.values(res.cpu_eco_levels ?? {});
            const distinct = [...new Set(values)];
            if (distinct.length === 1 && isCpuEcoLevel(distinct[0])) {
              setCpuLevel(distinct[0]);
            }
            const temps = Object.values(res.nodes)
              .map((s) => Number(s.split(" · ")[1]?.replace("°C", "")))
              .filter(Number.isFinite);
            setCpuStatus(temps.length ? `fleet · ${Math.max(...temps).toFixed(1)}°C` : null);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setWritesEnabled(false);
          setMsg({
            text: err instanceof Error ? err.message : "CPU ECO status unavailable",
            tone: "err",
          });
        });
    };
    load();
    const iv = setInterval(load, 10000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [sparkId, fleet]);

  const node = fleet ? "fleet" : sparkId ?? "fleet";

  const handleApply = useCallback(async () => {
    if (busy || writesEnabled === false) return;
    let key = readStoredKey();
    if (!key) {
      key = window.prompt("ECO key (required to change GPU/CPU clocks):", "")?.trim() ?? null;
      if (!key) return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const [gpuRes, cpuRes] = await Promise.all([
        setEcoLevel(node, gpuLevel, key),
        setCpuEcoLevel(node, cpuLevel, key),
      ]);
      storeKey(key);
      if (sparkId) {
        setGpuStatus(gpuRes.nodes[sparkId] ?? "no reply");
        setCpuStatus(cpuRes.nodes[sparkId] ?? "no reply");
      }
      const gpuFailed = Object.values(gpuRes.nodes).filter((v) => v !== "ok");
      const cpuFailed = Object.values(cpuRes.nodes).filter((v) => v !== "ok");
      const failed = gpuFailed.length + cpuFailed.length;
      setMsg({
        text:
          failed === 0
            ? fleet
              ? `Applied GPU ${gpuLevel} · CPU ${cpuLevel} to fleet`
              : `Applied GPU ${gpuLevel} · CPU ${cpuLevel}`
            : `Failed: ${[...gpuFailed, ...cpuFailed][0]}`,
        tone: failed === 0 ? "ok" : "err",
      });
    } catch (err: unknown) {
      if (err instanceof Error && /key/i.test(err.message)) clearStoredKey();
      setMsg({
        text: err instanceof Error ? err.message : "Failed to apply ECO level",
        tone: "err",
      });
    } finally {
      setBusy(false);
    }
  }, [busy, writesEnabled, node, gpuLevel, cpuLevel, sparkId, fleet]);

  const gpuParsed = gpuStatus ? parseGpuLine(gpuStatus) : null;
  const noKey = writesEnabled === false;

  const selClass = `rounded border border-border bg-surface-elevated text-[11px] text-text outline-none focus:border-accent disabled:opacity-50 ${
    compact ? "px-1 py-1" : "px-2.5 py-1.5"
  }`;
  const applyClass = `flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated text-[11px] text-muted transition-colors hover:bg-accent/15 hover:text-accent disabled:opacity-50 ${
    compact ? "px-1.5 py-1" : "px-3 py-1.5"
  }`;

  return (
    <div
      className={
        compact
          ? "flex items-center gap-1"
          : "panel flex flex-wrap items-center gap-x-3 gap-y-2"
      }
      style={compact ? undefined : { padding: "var(--density-panel-pad)" }}
    >
      {!compact && (
        <span className="flex items-center gap-1.5 text-[11px] text-muted">
          <BoltIcon className="h-3.5 w-3.5 text-accent" />
          ECO
        </span>
      )}
      {/* GPU half */}
      <select
        value={gpuLevel}
        onChange={(e) => setGpuLevel(e.target.value as EcoLevel)}
        disabled={busy}
        title="GPU clock cap; Off uncaps"
        className={selClass}
      >
        {ECO_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {compact ? opt.labelShort : opt.label}
          </option>
        ))}
      </select>
      {!compact && gpuStatus && (
        <span className="font-tabular text-[11px] text-muted" title={gpuStatus ?? undefined}>
          {gpuParsed ? `${gpuParsed.clock} · ${gpuParsed.temp}°C · ${gpuParsed.power}` : gpuStatus}
        </span>
      )}
      {/* Divider */}
      <span
        aria-hidden
        className={
          compact
            ? "mx-0.5 h-4 w-px bg-border"
            : "mx-1 h-5 w-px self-stretch bg-border"
        }
      />
      {/* CPU half */}
      <select
        value={cpuLevel}
        onChange={(e) => setCpuLevel(e.target.value as CpuEcoLevel)}
        disabled={busy}
        title="CPU clock cap (CPPC max_perf); Off restores stock"
        className={selClass}
      >
        {CPU_ECO_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {compact ? opt.labelShort : opt.label}
          </option>
        ))}
      </select>
      {!compact && cpuStatus && (
        <span className="font-tabular text-[11px] text-muted" title={cpuStatus ?? undefined}>
          {cpuStatus}
        </span>
      )}
      <button
        type="button"
        onClick={() => void handleApply()}
        disabled={busy || noKey}
        title={
          noKey
            ? "ECO key not configured on the server (set SPARKDASH_ECO_KEY or config/eco_key.txt)"
            : `Apply GPU ${gpuLevel} · CPU ${cpuLevel} to ${fleet ? "all Sparks" : "this Spark"}`
        }
        className={applyClass}
      >
        {busy ? "Applying…" : "Apply"}
      </button>
      {compact && gpuParsed && (
        // Overview: show the live GPU clock so state survives reloads.
        <span
          className="font-tabular text-[11px] text-muted"
          title={gpuStatus ?? undefined}
        >
          {gpuParsed.clock}
        </span>
      )}
      {msg && (
        <span className={`text-[11px] ${msg.tone === "ok" ? "text-success" : "text-danger"}`}>
          {msg.text}
        </span>
      )}
    </div>
  );
}
