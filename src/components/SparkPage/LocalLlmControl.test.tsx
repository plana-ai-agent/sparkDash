import { act } from "react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import { LocalLlmControl } from "./LocalLlmControl";
import { fetchLocalLlmSwitchStatus, switchLocalLlmRuntime, reconcileLocalLlmRuntime } from "../../api/client";
import type { LocalLlmRuntimeOption, LocalLlmSwitchStatus } from "../../api/types";

vi.mock("../../api/client", () => ({ fetchLocalLlmSwitchStatus: vi.fn(), switchLocalLlmRuntime: vi.fn(), reconcileLocalLlmRuntime: vi.fn() }));

function initial(): LocalLlmSwitchStatus {
  const profile = (id: string, nodes: string[]): LocalLlmRuntimeOption => ({ id, label: `Custom ${id}`, modelId: id, nodeIds: nodes, apiNode: nodes[0], mode: nodes.length === 1 ? "independent" : "linked" });
  return { state: "idle", phase: "idle", current: { mode: "independent", selections: { a: "a1", b: "b1" } },
    nodes: ["a", "b"].map((id) => ({ id, name: id, port: 8888, runtime: `${id}1`, modelId: `${id}1`, health: "healthy" })),
    runtimes: [profile("a1", ["a"]), profile("a2", ["a"]), profile("b1", ["b"]), profile("b2", ["b"]), profile("joined", ["a", "b"])],
    target: null, startedAt: null, finishedAt: null, message: "Ready", error: null, recoveries: [], progress: {},
    issues: [], interrupted: false, failureLog: [], log: [], writesEnabled: true };
}
const select = (container: HTMLElement, label: string, value: string) => act(() => {
  const element = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  element.value = value; element.dispatchEvent(new Event("change", { bubbles: true }));
});
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll("button")].find((entry) => entry.textContent === text)!;

beforeEach(() => {
  vi.mocked(fetchLocalLlmSwitchStatus).mockResolvedValue(initial());
  vi.mocked(switchLocalLlmRuntime).mockResolvedValue({ ...initial(), state: "switching", started: true, success: true });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  localStorage.setItem("sparkdash.eco.key", "shared-fixture-key");
});
afterEach(() => { localStorage.clear(); vi.useRealTimers(); });

it("switches the whole topology to a deployment-configured linked model using the shared ECO key", async () => {
  const prompt = vi.spyOn(window, "prompt");
  const { container } = render(<LocalLlmControl />); await flush();
  select(container, "Runtime configuration", "linked");
  expect(container.querySelector('select[aria-label="Linked runtime model"]')?.textContent).toContain("Custom joined");
  act(() => button(container, "Apply linked configuration").click()); await flush();
  expect(switchLocalLlmRuntime).toHaveBeenCalledWith({ mode: "linked", runtime: "joined" }, "shared-fixture-key");
  expect(prompt).not.toHaveBeenCalled();
  expect(button(container, "Switching…").disabled).toBe(true);
});

it("supports independent batch choices and excludes models installed only on the other node", async () => {
  const { container } = render(<LocalLlmControl />); await flush();
  expect(container.querySelector('select[aria-label="a model"]')?.textContent).not.toContain("Custom b2");
  select(container, "a model", "a2"); select(container, "b model", "b2");
  act(() => button(container, "Apply independent configuration").click()); await flush();
  expect(switchLocalLlmRuntime).toHaveBeenCalledWith({ mode: "independent", selections: { a: "a2", b: "b2" } }, "shared-fixture-key");
});

it("worker detail pages can switch their own model without requesting a peer restart", async () => {
  const { container } = render(<LocalLlmControl sparkId="b" />); await flush();
  select(container, "b model", "b2");
  act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Switch b"]')!.click()); await flush();
  expect(switchLocalLlmRuntime).toHaveBeenCalledWith({ node: "b", target: "b2" }, "shared-fixture-key");
});

it("leaving linked mode requires applying the full pair instead of a node-only command", async () => {
  const status = initial(); status.current = { mode: "linked", runtime: "joined" };
  status.nodes = status.nodes.map((node) => ({ ...node, runtime: "joined", modelId: node.id === "a" ? "joined" : null }));
  vi.mocked(fetchLocalLlmSwitchStatus).mockResolvedValue(status);
  const { container } = render(<LocalLlmControl />); await flush();
  select(container, "Runtime configuration", "independent");
  expect(container.querySelector('button[aria-label="Switch a"]')).toBeNull();
  act(() => button(container, "Apply independent configuration").click()); await flush();
  expect(switchLocalLlmRuntime).toHaveBeenCalledWith({ mode: "independent", selections: { a: "a1", b: "b1" } }, "shared-fixture-key");
});

it("polling preserves draft choices and does not restore a stale idle response after submitting", async () => {
  vi.useFakeTimers();
  const { container } = render(<LocalLlmControl />); await flush();
  select(container, "b model", "b2");
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(container.querySelector<HTMLSelectElement>('select[aria-label="b model"]')?.value).toBe("b2");
  let resolvePoll!: (status: LocalLlmSwitchStatus) => void;
  vi.mocked(fetchLocalLlmSwitchStatus).mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve; }));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Switch b"]')!.click()); await flush();
  await act(async () => { resolvePoll(initial()); });
  expect(button(container, "Switching…").disabled).toBe(true);
});

it("blocks switching when state is interrupted and provides a read-only reconciliation action", async () => {
  const status = { ...initial(), interrupted: true };
  vi.mocked(fetchLocalLlmSwitchStatus).mockResolvedValue(status);
  vi.mocked(reconcileLocalLlmRuntime).mockResolvedValue(initial());
  const { container } = render(<LocalLlmControl />); await flush();
  select(container, "Runtime configuration", "linked");
  expect(button(container, "Apply linked configuration").disabled).toBe(true);
  act(() => button(container, "Reconcile interrupted operation").click()); await flush();
  expect(reconcileLocalLlmRuntime).toHaveBeenCalledWith("shared-fixture-key");
  expect(switchLocalLlmRuntime).not.toHaveBeenCalled();
});

it("does not submit after cancellation or without write authorization", async () => {
  vi.mocked(window.confirm).mockReturnValue(false);
  const { container } = render(<LocalLlmControl />); await flush();
  select(container, "Runtime configuration", "linked");
  act(() => button(container, "Apply linked configuration").click()); await flush();
  expect(switchLocalLlmRuntime).not.toHaveBeenCalled();
  vi.mocked(fetchLocalLlmSwitchStatus).mockResolvedValue({ ...initial(), writesEnabled: false });
  const other = render(<LocalLlmControl />); await flush();
  select(other.container, "Runtime configuration", "linked");
  expect(button(other.container, "Apply linked configuration").disabled).toBe(true);
});

it("shows unprepared models as disabled options and prevents submitting them", async () => {
  const status = initial(); status.runtimes.at(-1)!.disabledReason = "Image not installed";
  vi.mocked(fetchLocalLlmSwitchStatus).mockResolvedValue(status);
  const { container } = render(<LocalLlmControl />); await flush();
  select(container, "Runtime configuration", "linked");
  expect(container.querySelector<HTMLOptionElement>('option[value="joined"]')?.disabled).toBe(true);
  expect(container.textContent).toContain("Image not installed");
  expect(button(container, "Apply linked configuration").disabled).toBe(true);
});
