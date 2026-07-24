/**
 * Harness self-test — proves the panel test infrastructure (MSW server +
 * fixtures + MemoryRouter render + store reset) actually wires the real
 * Dashboard page across the HTTP boundary. If this is red, every panel
 * component-integration test below it is untrustworthy.
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Dashboard } from "../pages/Dashboard.tsx";
import { authedSeed, renderRoute, resetPanelStore } from "./render.tsx";
import { makeRepo } from "./panel-fixtures.ts";
import { setupPanelServer, useHappyPanel } from "./panel-server.ts";

setupPanelServer();

describe("panel harness smoke", () => {
  it("H1: renders the login gate when there is no session", () => {
    resetPanelStore({ userLoaded: true, user: null });
    renderRoute(<Dashboard />);
    expect(screen.getByText(/Connect your GitHub workspace/i)).toBeInTheDocument();
  });

  it("H2: boots an authenticated session and streams repos in over MSW", async () => {
    useHappyPanel({ repos: [makeRepo({ name: "web-app" })] });
    resetPanelStore(authedSeed());
    renderRoute(<Dashboard />);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Repository posture/i })).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Open octo-org/web-app")).toBeInTheDocument(),
    );
  });
});
