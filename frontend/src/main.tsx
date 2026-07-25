import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { createQueryClient } from "./lib/query-client.ts";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

// One client for the app's lifetime, created OUTSIDE render: a client built
// inside a component is a new cache on every render, which silently turns every
// query into a fresh fetch and every dedupe into a duplicate.
const queryClient = createQueryClient();

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
