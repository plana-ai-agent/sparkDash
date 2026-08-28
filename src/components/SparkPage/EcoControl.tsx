import { useCallback, useEffect, useState } from "react";
import { fetchEcoStatus, isEcoLevel, setEcoLevel, type EcoLevel } from "../../api/client";
import { BoltIcon } from "../ui/icons";

/** localStorage key for the ECO key (asked once, reused on later applies). */
const ECO_KEY_STORAGE = "sparkdash.eco.key";

const ECO_OPTIONS: { value: EcoLevel; label: string }[] = [
  { value: "off", label: "Off (uncap)" },
  { value: "2300", label: "2300 MHz" },
  { value: "2200", label: "2200 MHz" },
  { value: "2000", label: "2000 MHz" },
  { value: "1800", label: "1800 MHz" },
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

/** Parse an eco status line ("2184 MHz, 39, 8.07 W"); null when malformed. */
function parseEcoLine(line: string): { clock: string; temp: string; power: string } | null {
  const parts = line.split(",").map((p) => p.trim());
  if (parts.length < 3 || parts.some((p) => !p)) return null;
  return { clock: parts[0], temp: parts[1], power: parts[2] };
}

interface EcoControlProps {
  /** Spark id to apply to and show the status readout for. */
  sparkId?: string;
  /** Fleet-wide control (node "fleet"); no per-node readout. */
  fleet?: boolean;
  /** Compact variant for the Overview action cluster. */
  compact?: boolean;
}

export function EcoControl({ sparkId, fleet = false, compact = false }: EcoControlProps) {
  const [level, setLevel] = useState<EcoLevel>("off");
  const [writesEnabled, setWritesEnabled] = useState<boolean | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);

  // Live clock/temp/power readout — loaded once, refreshed after each apply.
  useEffect(() => {
    let cancelled = false;
    fetchEcoStatus()
      .then((res) => {
        if (cancelled) return;
        setWritesEnabled(res.writes_enabled);
        if (sparkId) {
          // Restore the last-applied level (persisted server-side) so the
          // selection survives a page reload.
          const stored = res.eco_levels?.[sparkId];
          if (isEcoLevel(stored)) setLevel(stored);
          setStatus(res.nodes[sparkId] ?? "no reply");
        } else if (fleet) {
          // Fleet control: restore only when every node agrees on one level.
          const values = Object.values(res.eco_levels ?? {});
          const distinct = [...new Set(values)];
          if (distinct.length === 1 && isEcoLevel(distinct[0])) {
            setLevel(distinct[0]);
          }
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
    return () => {
      cancelled = true;
    };
  }, [sparkId]);

  const node = fleet ? "fleet" : sparkId ?? "fleet";

  const handleApply = useCallback(async () => {
    if (busy || writesEnabled === false) return;
    let key = readStoredKey();
    if (!key) {
      key = window.prompt("ECO key (required to change GPU clocks):", "")?.trim() ?? null;
      if (!key) return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await setEcoLevel(node, level, key);
      storeKey(key); // asked once, reused on later applies
      if (sparkId) setStatus(res.nodes[sparkId] ?? "no reply");
      const failed = Object.values(res.nodes).filter((v) => v !== "ok");
      setMsg({
        text:
          failed.length === 0
            ? fleet
              ? `Applied ${level} to fleet`
              : `Applied ${level}`
            : fleet
              ? `Applied ${level}: ${failed.length} failed`
              : `Failed: ${failed[0]}`,
        tone: failed.length === 0 ? "ok" : "err",
      });
    } catch (err: unknown) {
      // A rejected key must be re-asked on the next attempt.
      if (err instanceof Error && /key/i.test(err.message)) clearStoredKey();
      setMsg({
        text: err instanceof Error ? err.message : "Failed to apply ECO level",
        tone: "err",
      });
    } finally {
      setBusy(false);
    }
  }, [busy, writesEnabled, node, level, sparkId, fleet]);

  const parsed = status ? parseEcoLine(status) : null;
  const noKey = writesEnabled === false;

  return (
    <div
      className={
        compact
          ? "flex flex-wrap items-center justify-end gap-1.5"
          : "panel flex flex-wrap items-center gap-x-3 gap-y-2"
      }
      style={compact ? undefined : { padding: "var(--density-panel-pad)" }}
    >
      <span className="flex items-center gap-1.5 text-[11px] text-muted">
        <BoltIcon className="h-3.5 w-3.5 text-accent" />
        ECO
      </span>
      <select
        value={level}
        onChange={(e) => setLevel(e.target.value as EcoLevel)}
        disabled={busy}
        title="GPU clock cap (ECO mode); Off removes the cap"
        className="rounded border border-border bg-surface-elevated px-2.5 py-1.5 text-[11px] text-text outline-none focus:border-accent disabled:opacity-50"
      >
        {ECO_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => void handleApply()}
        disabled={busy || noKey}
        title={
          noKey
            ? "ECO key not configured on the server (set SPARKDASH_ECO_KEY or config/eco_key.txt)"
            : `Apply ${level} to ${fleet ? "all Sparks" : "this Spark"}`
        }
        className="flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-[11px] text-muted transition-colors hover:bg-accent/15 hover:text-accent disabled:opacity-50"
      >
        {busy ? "Applying…" : "Apply"}
      </button>
      {!compact && status && (
        <span className="font-tabular text-[11px] text-muted" title={status}>
          {parsed ? `${parsed.clock} · ${parsed.temp}°C · ${parsed.power}` : status}
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
