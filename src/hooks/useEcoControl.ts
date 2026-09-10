import { useEffect, useRef, useState } from "react";
import type { EcoSetResponse, EcoStatusResponse } from "../api/client";

export interface EcoChannel<Level extends string> {
  label: string;
  levels: readonly Level[];
  offLabel: string;
  fetchStatus: () => Promise<EcoStatusResponse>;
  setLevel: (node: string, level: Level, key: string) => Promise<EcoSetResponse<Level>>;
  savedLevels: "eco_levels" | "cpu_eco_levels";
  temperature: (line: string) => number;
  formatStatus: (line: string) => string;
  precision: number;
}

export function useEcoControl<Level extends string>(channel: EcoChannel<Level>, node: string, busy: boolean) {
  const [level, setLevel] = useState<Level | "">("");
  const [status, setStatus] = useState<string | null>(null);
  const [writesEnabled, setWritesEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edited = useRef(false);

  useEffect(() => {
    if (busy) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await channel.fetchStatus();
        if (cancelled) return;
        setWritesEnabled(result.writes_enabled);
        setError(null);
        const saved = result[channel.savedLevels] ?? {};
        const ids = node === "fleet" ? Object.keys(result.nodes) : [node];
        const levels = [...new Set(ids.map((id) => saved[id] ?? "off"))];
        // Polling updates telemetry without discarding a user's pending choice.
        if (!edited.current) {
          setLevel(levels.length === 1 && channel.levels.includes(levels[0] as Level)
            ? levels[0] as Level : "");
        }
        const temps = Object.values(result.nodes).map(channel.temperature).filter(Number.isFinite);
        setStatus(node === "fleet"
          ? temps.length ? `fleet · ${Math.max(...temps).toFixed(channel.precision)}°C` : null
          : channel.formatStatus(result.nodes[node] ?? "no reply"));
      } catch (err) {
        if (!cancelled) {
          setWritesEnabled(false);
          setError(err instanceof Error ? err.message : `${channel.label} status unavailable`);
        }
      } finally {
        // Schedule after completion so a slow node cannot create overlapping polls.
        if (!cancelled) timer = setTimeout(poll, 10000);
      }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [channel, node, busy]);

  return { level, status, writesEnabled, error, select(value: Level) {
    edited.current = true;
    setLevel(value);
  } };
}
