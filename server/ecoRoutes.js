import { ECO_LEVELS, ecoSet, ecoStatus } from "./eco.js";
import { CPU_ECO_LEVELS, cpuEcoSet, cpuEcoStatus } from "./cpuEco.js";
import { ecoKeyOk, getEcoKey } from "./ecoCommon.js";
import { getSettings, updateSettings } from "./settings.js";

const CONTROLS = [
  { path: "eco", label: "ECO", levels: ECO_LEVELS, read: ecoStatus, apply: ecoSet,
    setting: "ecoLevels", response: "eco_levels" },
  { path: "cpu-eco", label: "CPU ECO", levels: CPU_ECO_LEVELS, read: cpuEcoStatus, apply: cpuEcoSet,
    setting: "cpuEcoLevels", response: "cpu_eco_levels" },
];

export function registerEcoRoutes(app, registry, controls = CONTROLS) {
  for (const control of controls) {
    app.get(`/api/${control.path}/status`, async (_req, res) => {
      try {
        const nodes = await control.read(registry.sparks);
        res.json({
          writes_enabled: Boolean(getEcoKey()),
          nodes,
          [control.response]: getSettings()[control.setting],
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    app.post(`/api/${control.path}/set`, async (req, res) => {
      try {
        const { key, node, level } = req.body || {};
        if (!ecoKeyOk(key)) return res.status(403).json({ error: "Invalid or missing ECO key" });
        if (level !== "off" && !Object.hasOwn(control.levels, level)) {
          return res.status(400).json({ error: `Invalid ${control.label} level` });
        }
        if (typeof node !== "string" || !node) {
          return res.status(400).json({ error: "node must be a Spark id or 'fleet'" });
        }
        const targets = node === "fleet" ? registry.sparks : [registry.getSpark(node)];
        if (!targets[0] && node !== "fleet") return res.status(400).json({ error: "Unknown Spark" });

        const nodes = {};
        for (const spark of targets) {
          nodes[spark.id] = await control.apply(spark, level);
          if (nodes[spark.id] === "ok") {
            // Read after the command: another request may have saved a different node meanwhile.
            updateSettings({ [control.setting]: {
              ...getSettings()[control.setting], [spark.id]: level,
            } });
          }
        }
        res.json({ ok: true, applied: level, nodes });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }
}
