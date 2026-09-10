import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupRenders, flush, render } from "../../testing/render";
import { EcoControl } from "./EcoControl";
import { fetchCpuEcoStatus, fetchEcoStatus, setCpuEcoLevel, setEcoLevel } from "../../api/client";

vi.mock("../../api/client", async (original) => ({
  ...await original<typeof import("../../api/client")>(),
  fetchEcoStatus: vi.fn(), fetchCpuEcoStatus: vi.fn(), setEcoLevel: vi.fn(), setCpuEcoLevel: vi.fn(),
}));

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.setItem("sparkdash.eco.key", "fixture-key");
  vi.mocked(fetchEcoStatus).mockResolvedValue({
    writes_enabled: true, nodes: { a: "2184 MHz, 39, 8.07 W" }, eco_levels: { a: "2200" },
  });
  vi.mocked(fetchCpuEcoStatus).mockResolvedValue({
    writes_enabled: true, nodes: { a: "2 GHz · 74.1°C" }, cpu_eco_levels: { a: "2000" },
  });
  vi.mocked(setEcoLevel).mockResolvedValue({ ok: true, applied: "2200", nodes: { a: "ok" } });
  vi.mocked(setCpuEcoLevel).mockResolvedValue({ ok: true, applied: "2000", nodes: { a: "ok" } });
});

afterEach(() => {
  cleanupRenders();
  vi.useRealTimers();
  localStorage.clear();
});

function select(container: HTMLElement, label: string, value: string) {
  const control = container.querySelector<HTMLSelectElement>(`[aria-label="${label} clock cap"]`)!;
  act(() => {
    control.value = value;
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return control;
}

it("loads saved levels and preserves a pending selection across telemetry polls", async () => {
  const { container } = render(<EcoControl sparkId="a" />);
  expect(container.querySelector("button")!.disabled).toBe(true);
  await flush();
  expect(container.querySelector<HTMLSelectElement>("select")!.value).toBe("2200");
  const control = select(container, "GPU", "1800");
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(fetchEcoStatus).toHaveBeenCalledTimes(2);
  expect(control.value).toBe("1800");
  expect(container.textContent).toContain("2184 MHz · 39°C · 8.07 W");
  act(() => container.querySelector("button")!.click());
  await flush();
  expect(setEcoLevel).toHaveBeenCalledWith("a", "1800", "fixture-key");
  expect(setCpuEcoLevel).toHaveBeenCalledWith("a", "2000", "fixture-key");
  expect(fetchEcoStatus).toHaveBeenCalledTimes(3);
  expect(container.textContent).toContain("Applied GPU 1800 · CPU 2000");
});

it("keeps Apply disabled if either status endpoint fails regardless of response order", async () => {
  vi.mocked(fetchEcoStatus).mockRejectedValue(new Error("GPU offline"));
  const { container } = render(<EcoControl sparkId="a" />);
  await flush();
  expect(container.querySelector("button")!.disabled).toBe(true);
  expect(container.textContent).toContain("GPU offline");
  expect(setEcoLevel).not.toHaveBeenCalled();
});

it("waits for both writes when one request fails, reports the failure and refreshes telemetry", async () => {
  let finishCpu!: (value: Awaited<ReturnType<typeof setCpuEcoLevel>>) => void;
  vi.mocked(setEcoLevel).mockRejectedValue(new Error("Invalid or missing ECO key"));
  vi.mocked(setCpuEcoLevel).mockImplementation(() => new Promise((resolve) => { finishCpu = resolve; }));
  const { container } = render(<EcoControl sparkId="a" />);
  await flush();
  act(() => container.querySelector("button")!.click());
  await flush();
  expect(container.querySelector("button")!.disabled).toBe(true);
  expect(container.textContent).toContain("Applying…");
  await act(async () => finishCpu({ ok: true, applied: "2000", nodes: { a: "ok" } }));
  await flush();
  expect(container.textContent).toContain("GPU: Invalid or missing ECO key");
  expect(container.textContent).not.toContain("Applied GPU");
  expect(localStorage.getItem("sparkdash.eco.key")).toBeNull();
  expect(fetchEcoStatus).toHaveBeenCalledTimes(2);
});

it("reports per-node command failures without showing a false success", async () => {
  vi.mocked(setCpuEcoLevel).mockResolvedValue({ ok: true, applied: "2000", nodes: { a: "CPU refused" } });
  const { container } = render(<EcoControl sparkId="a" />);
  await flush();
  act(() => container.querySelector("button")!.click());
  await flush();
  expect(container.textContent).toContain("CPU a: CPU refused");
  expect(container.textContent).toContain("2 GHz · 74.1°C");
  expect(container.textContent).not.toContain("Applied GPU");
});

it("requires an explicit fleet selection when the saved levels differ", async () => {
  vi.mocked(fetchEcoStatus).mockResolvedValue({
    writes_enabled: true, nodes: { a: "2184 MHz, 39, 8 W", b: "1800 MHz, 40, 7 W" },
    eco_levels: { a: "2200", b: "1800" },
  });
  const { container } = render(<EcoControl fleet compact />);
  await flush();
  expect(container.querySelector<HTMLSelectElement>("select")!.value).toBe("");
  expect(container.querySelector("button")!.disabled).toBe(true);
  select(container, "GPU", "2000");
  expect(container.querySelector("button")!.disabled).toBe(false);
});

it("does not overlap slow status polls and stops polling on unmount", async () => {
  vi.mocked(fetchEcoStatus).mockImplementation(() => new Promise(() => {}));
  const { root } = render(<EcoControl sparkId="a" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(fetchEcoStatus).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
  const cpuCalls = vi.mocked(fetchCpuEcoStatus).mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  expect(fetchCpuEcoStatus).toHaveBeenCalledTimes(cpuCalls);
});
