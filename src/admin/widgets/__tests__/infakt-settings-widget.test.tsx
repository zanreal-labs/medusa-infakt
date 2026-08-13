// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InfaktSettings, OverviewResponse } from "../../lib/types";

/**
 * The store-settings invoicing widget is the config home now that the top-level
 * route is gone. It must render cleanly in the production state that used to be
 * reported as broken: apiKey set, invoicing paused, no data.
 */

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../lib/sdk", () => ({ sdk: { client: { fetch: fetchMock } } }));

const InfaktSettingsWidget = (await import("../infakt-settings-widget")).default;

const overview: OverviewResponse = {
  config: {
    currency: "PLN",
    disabled: false,
    emitIssuedEvent: true,
    environment: "production",
    ksefCustomPredicate: false,
    ksefMode: "nip-only",
    ksefRequireActive: true,
    startDate: null,
    taxSymbol: "23",
    triggerEvent: "payment.captured",
  },
  counts: { done: 0, needs_review: 0, pending: 0, processing: 0, skipped: 0 },
  crash_window_count: 0,
  run_state: {
    id: "singleton",
    ksef_active: null,
    ksef_checked_at: null,
    ksef_error: null,
    last_error: null,
    last_run_at: null,
    processed: 0,
    status: "idle",
  },
};

const pausedSettings: InfaktSettings = {
  api_key_configured: true,
  effective_enabled: false,
  env_force_disabled: false,
  invoicing_paused: true,
  reason: "paused",
};

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

describe("settings invoicing widget", () => {
  it("renders the paused config surface without throwing", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url) === "/admin/infakt") {
        return Promise.resolve(overview);
      }
      return Promise.resolve(pausedSettings);
    });
    render(<InfaktSettingsWidget />);
    expect(await screen.findByText("Invoicing (inFakt / KSeF)")).toBeTruthy();
    expect(await screen.findByText(/Invoicing is paused/)).toBeTruthy();
    // The pause switch is reachable here - this is the config home. It appears
    // both in the paused banner and as the standing switch, so there is at least
    // one Resume control on the surface.
    expect(
      (await screen.findAllByRole("button", { name: /Resume invoicing/ })).length,
    ).toBeGreaterThan(0);
  });
});
