import { act } from "react";
import { expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import { LocalLlmControl } from "./LocalLlmControl";
import { fetchLocalLlmSwitchStatus, switchLocalLlmRuntime } from "../../api/client";
import type { LocalLlmSwitchStatus } from "../../api/types";

vi.mock("../../api/client", () => ({ fetchLocalLlmSwitchStatus: vi.fn(), switchLocalLlmRuntime: vi.fn() }));

it("reuses the ECO key and keeps deployment labels after an accepted switch response", async () => {
  const initial: LocalLlmSwitchStatus = {
    state: "idle", phase: "idle", current: "qwen", currentModelId: "fixture-qwen",
    health: "healthy", source: null, target: null, startedAt: null, finishedAt: null,
    message: "Healthy", error: null, rollback: null, failureLog: [], log: [], writesEnabled: true,
    labels: { deepseek: "Custom DeepSeek", qwen: "Custom Qwen", glm: "Custom GLM" },
  };
  vi.mocked(fetchLocalLlmSwitchStatus).mockResolvedValue(initial);
  vi.mocked(switchLocalLlmRuntime).mockResolvedValue({
    ...initial, labels: undefined, state: "switching", target: "glm", started: true, success: true,
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const prompt = vi.spyOn(window, "prompt");
  localStorage.setItem("sparkdash.eco.key", "shared-fixture-key");
  try {
    const { container } = render(<LocalLlmControl />);
    await flush();
    const select = container.querySelector("select")!;
    act(() => {
      select.value = "glm";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => container.querySelector("button")!.click());
    await flush();
    expect(switchLocalLlmRuntime).toHaveBeenCalledWith("glm", "shared-fixture-key");
    expect(prompt).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Custom GLM");
    expect(container.textContent).toContain("Custom Qwen");
    expect(container.querySelector("button")!.disabled).toBe(true);
  } finally {
    localStorage.clear();
  }
});
