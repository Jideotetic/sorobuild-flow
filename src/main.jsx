import React from "react";
import { createRoot } from "react-dom/client";
import SorobuildFlowMVP from "../frontend/SorobuildFlowMVP.jsx";
import "./styles.css";
import { BrowserRouter } from "react-router-dom";

function App() {
  const apiUrl = "http://localhost:4307";
  return (
    <div className="min-h-screen bg-slate-100 px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1600px]">
        <div className="mb-6 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="relative px-5 py-6 sm:px-6">
            <div className="absolute inset-y-0 right-0 hidden w-1/2 bg-gradient-to-l from-slate-100 to-transparent lg:block" />

            <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="max-w-4xl">
                <div className="inline-flex  px-3 py-1 text-sm font-bold uppercase tracking-[0.22em] text-slate-700">
                  Sorobuild Flow
                </div>

                <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
                  Automate Soroban smart contract workflows
                </h1>

                <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                  Generate deployment, initialization, invocation, and testing
                  workflows directly from compiled WASM contracts. Compose
                  execution pipelines, customize generated scripts, and export
                  production-ready CLI workflows in minutes.
                </p>

                <div className="mt-4 flex flex-wrap gap-2">
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600">
                    WASM upload
                  </span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600">
                    Auto-generated scripts
                  </span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600">
                    Editable env + files
                  </span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600">
                    CLI export
                  </span>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 lg:min-w-[300px]">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  API endpoint
                </div>
                <div className="mt-1 break-all font-semibold text-slate-900">
                  {apiUrl}
                </div>
              </div>
            </div>
          </div>
        </div>

        <SorobuildFlowMVP />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
