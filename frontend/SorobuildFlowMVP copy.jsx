import React, { useEffect, useMemo, useState } from "react";
import {
  DocumentUpload,
  Trash,
  SearchNormal1,
  Edit2,
  DocumentDownload,
  Save2,
  CloseCircle,
  CloudAdd,
  TickCircle,
} from "iconsax-react";

const DEFAULT_API_URL =
  import.meta?.env?.VITE_SOROBUILD_FLOW_API || "http://localhost:4307";

const GENERATION_STEPS = [
  "Uploading contract",
  "Inspecting WASM",
  "Generating scripts",
  "Saving workflow",
  "Preparing cloud export",
];

export default function SorobuildFlowMVP({ apiUrl = DEFAULT_API_URL }) {
  const [file, setFile] = useState(null);
  const [mode, setMode] = useState("wasm");
  const [network, setNetwork] = useState("testnet");
  const [source, setSource] = useState("alice");
  const [name, setName] = useState("");
  const [openId, setOpenId] = useState("");
  const [loadingWorkflowId, setLoadingWorkflowId] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStep, setGenerationStep] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [workflows, setWorkflows] = useState([]);
  const [selectedScripts, setSelectedScripts] = useState([]);
  const [draggingPath, setDraggingPath] = useState(null);
  const [showInvokeModal, setShowInvokeModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editableFiles, setEditableFiles] = useState({});
  const [activeEditFile, setActiveEditFile] = useState("");
  const [saveStatus, setSaveStatus] = useState("");

  const scripts = result?.scripts || {};
  const workflow = result?.workflow;
  const stats = result?.stats;

  const envFiles = useMemo(
    () => Object.keys(scripts).filter((path) => path.endsWith("env.sh")),
    [scripts]
  );

  const generatedScriptPaths = useMemo(() => {
    return Object.keys(scripts).filter(
      (path) => path.endsWith(".sh") && !path.endsWith("env.sh")
    );
  }, [scripts]);

  const scriptGroups = useMemo(() => {
    return {
      Build: generatedScriptPaths.filter((path) =>
        path.endsWith("scripts/build/build.sh")
      ),
      Deploy: generatedScriptPaths.filter((path) =>
        path.endsWith("scripts/deploy.sh")
      ),
      Init: generatedScriptPaths.filter((path) =>
        /(^|\/)scripts\/invoke\/(init|initialize)\.sh$/.test(path)
      ),
      Invoke: generatedScriptPaths.filter(
        (path) =>
          /(^|\/)scripts\/invoke\/[^/]+\.sh$/.test(path) &&
          !/(^|\/)scripts\/invoke\/(init|initialize)\.sh$/.test(path)
      ),
      Other: generatedScriptPaths.filter(
        (path) =>
          !path.endsWith("scripts/build/build.sh") &&
          !path.endsWith("scripts/deploy.sh") &&
          !/(^|\/)scripts\/invoke\/[^/]+\.sh$/.test(path) &&
          !/(^|\/)scripts\/flows\/[^/]+\.sh$/.test(path)
      ),
    };
  }, [generatedScriptPaths]);

  const generatedFlowScript = useMemo(
    () => renderSelectedFlow(selectedScripts),
    [selectedScripts]
  );

  const selectedInvokeCount = scriptGroups.Invoke.filter((path) =>
    selectedScripts.includes(path)
  ).length;

  useEffect(() => {
    refreshWorkflows();

    const idFromUrl = getWorkflowIdFromUrl();
    const lastId = localStorage.getItem("sorobuild:lastWorkflowId");

    if (idFromUrl) {
      setOpenId(idFromUrl);
      loadWorkflow(idFromUrl);
    } else if (lastId) {
      setOpenId(lastId);
    }
  }, []);

  useEffect(() => {
    if (!generatedScriptPaths.length) return;

    const savedSteps = workflow?.selectedSteps;
    if (Array.isArray(savedSteps) && savedSteps.length) {
      setSelectedScripts(savedSteps);
      return;
    }

    const build = scriptGroups.Build[0];
    const deploy = scriptGroups.Deploy[0];
    const init = scriptGroups.Init[0];

    const initial = [build, deploy, init].filter(Boolean);
    setSelectedScripts(
      initial.length ? initial : generatedScriptPaths.slice(0, 1)
    );
  }, [generatedScriptPaths.join("|"), workflow?.workflowId]);

  useEffect(() => {
    const next = {};

    for (const path of Object.keys(scripts)) {
      if (path.endsWith(".sh")) next[path] = scripts[path];
    }

    next["flow.selected.sh"] =
      workflow?.customFlowScript || generatedFlowScript;

    if (workflow?.editedFiles && typeof workflow.editedFiles === "object") {
      Object.assign(next, workflow.editedFiles);
    }

    setEditableFiles(next);
  }, [scripts, generatedFlowScript, workflow?.workflowId]);

  function rememberWorkflow(nextWorkflow) {
    if (!nextWorkflow?.workflowId) return;

    localStorage.setItem("sorobuild:lastWorkflowId", nextWorkflow.workflowId);

    const saved = JSON.parse(
      localStorage.getItem("sorobuild:workflowIds") || "[]"
    );

    const next = [
      nextWorkflow.workflowId,
      ...saved.filter((id) => id !== nextWorkflow.workflowId),
    ].slice(0, 20);

    localStorage.setItem("sorobuild:workflowIds", JSON.stringify(next));

    const nextPath = `/${nextWorkflow.workflowId}`;
    window.history.replaceState({}, "", nextPath);
  }

  async function refreshWorkflows() {
    try {
      const res = await fetch(`${apiUrl}/api/workflows`);
      const data = await res.json();
      setWorkflows(data.workflows || []);
    } catch {}
  }

  async function generateWorkflow(event) {
    event.preventDefault();

    if (!file) {
      setError(
        mode === "wasm"
          ? "Upload a .wasm file first."
          : "Upload a project .zip file first."
      );
      return;
    }

    setIsGenerating(true);
    setGenerationStep(GENERATION_STEPS[0]);
    setError("");
    setResult(null);

    try {
      const form = new FormData();
      form.append("file", file);
      form.append("mode", mode);
      form.append("network", network);
      form.append("source", source);
      form.append("name", name || file.name.replace(/\.(wasm|zip)$/i, ""));

      const stepTimer = startStepTicker(setGenerationStep);

      const res = await fetch(`${apiUrl}/api/workflows/generate`, {
        method: "POST",
        body: form,
      });

      clearInterval(stepTimer);

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to generate workflow");
      }

      setGenerationStep("Workflow generated");
      setResult(data);
      setOpenId(data.workflow?.workflowId || "");
      rememberWorkflow(data.workflow);
      await refreshWorkflows();
    } catch (e) {
      setError(e?.message || "Failed to generate workflow");
    } finally {
      setIsGenerating(false);
      setTimeout(() => setGenerationStep(""), 1200);
    }
  }

  async function loadWorkflow(workflowId) {
    if (!workflowId) return;

    try {
      setError("");
      setLoadingWorkflowId(workflowId);

      const res = await fetch(`${apiUrl}/api/workflows/${workflowId}`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to load workflow");
      }

      setResult(data);
      setOpenId(workflowId);
      rememberWorkflow(data.workflow);
    } catch (e) {
      setError(e?.message || "Failed to load workflow");
    } finally {
      setLoadingWorkflowId("");
    }
  }

  async function saveSelection() {
    if (!workflow?.workflowId) return;

    setSaveStatus("Saving...");

    const res = await fetch(`${apiUrl}/api/workflows/${workflow.workflowId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: workflow.name,
        selectedSteps: selectedScripts,
        customFlowScript:
          editableFiles["flow.selected.sh"] || generatedFlowScript,
        editedFiles: editableFiles,
      }),
    });

    if (res.ok) {
      const data = await res.json();

      setResult((current) =>
        current
          ? {
              ...current,
              workflow: data.workflow,
            }
          : current
      );

      rememberWorkflow(data.workflow);
      setSaveStatus("Saved");
      await refreshWorkflows();
      setTimeout(() => setSaveStatus(""), 1500);
    } else {
      setSaveStatus("");
      setError("Failed to save workflow");
    }
  }

  function toggleScript(path) {
    setSelectedScripts((current) =>
      current.includes(path)
        ? current.filter((item) => item !== path)
        : [...current, path]
    );
  }

  function addScripts(paths) {
    setSelectedScripts((current) => [...new Set([...current, ...paths])]);
  }

  function clearSelection() {
    setSelectedScripts([]);
  }

  function moveScript(fromPath, toPath) {
    if (!fromPath || fromPath === toPath) return;

    setSelectedScripts((current) => {
      const fromIndex = current.indexOf(fromPath);
      const toIndex = current.indexOf(toPath);

      if (fromIndex < 0 || toIndex < 0) return current;

      const next = [...current];
      const [item] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, item);
      return next;
    });
  }

  function openEditor(path = "") {
    const firstFile =
      path ||
      envFiles[0] ||
      "flow.selected.sh" ||
      scriptGroups.Build[0] ||
      scriptGroups.Deploy[0] ||
      scriptGroups.Invoke[0];

    setActiveEditFile(firstFile);
    setShowEditModal(true);
  }

  async function downloadSelectedFlow() {
    if (!workflow?.workflowId) return;

    const res = await fetch(
      `${apiUrl}/api/workflows/${workflow.workflowId}/download`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedSteps: selectedScripts,
          customFlowScript:
            editableFiles["flow.selected.sh"] || generatedFlowScript,
          editedFiles: editableFiles,
        }),
      }
    );

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Failed to download workflow ZIP");
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");

    a.href = url;
    a.download = `${
      workflow.name || workflow.contractName || "sorobuild-flow"
    }.zip`;
    a.click();

    URL.revokeObjectURL(url);
  }

  function MainLoadingState({ workflowId }) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6">
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <div className="mb-4 h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-slate-950" />

          <h3 className="text-base font-bold text-slate-900">
            Loading workflow
          </h3>

          <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">
            Fetching generated scripts, env files, saved selections, and
            workflow metadata for{" "}
            <span className="font-semibold text-slate-900">{workflowId}</span>.
          </p>

          <div className="mt-6 w-full max-w-xl space-y-3">
            <div className="h-12 animate-pulse rounded-2xl bg-white" />
            <div className="h-12 animate-pulse rounded-2xl bg-white" />
            <div className="h-12 animate-pulse rounded-2xl bg-white" />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto space-y-6">
        <section className="overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-sm">
          <div className="grid gap-6 p-5 sm:p-6 xl:grid-cols-[360px_minmax(0,1fr)]">
            <aside className="space-y-5">
              <Panel
                title="Generate workflow"
                description="Upload a WASM or project ZIP and generate reusable Sorobuild Flow scripts."
              >
                <form onSubmit={generateWorkflow} className="space-y-4">
                  <Segmented
                    value={mode}
                    onChange={setMode}
                    options={[
                      { value: "wasm", label: "WASM" },
                      { value: "project", label: "Project ZIP" },
                    ]}
                  />

                  <Field
                    label="Workflow name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Factory smoke test"
                  />
                  {/* 
                  <div className="grid grid-cols-2 gap-3">
                    <Field
                      label="Network"
                      value={network}
                      onChange={(e) => setNetwork(e.target.value)}
                      placeholder="testnet"
                    />

                    <Field
                      label="Source"
                      value={source}
                      onChange={(e) => setSource(e.target.value)}
                      placeholder="alice"
                    />
                  </div> */}

                  <UploadBox mode={mode} file={file} onFileChange={setFile} />

                  {isGenerating ? (
                    <GenerationStatus activeStep={generationStep} />
                  ) : null}

                  {error ? (
                    <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
                      {error}
                    </div>
                  ) : null}

                  <button
                    type="submit"
                    disabled={isGenerating || !file}
                    className="inline-flex w-full items-center justify-center rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isGenerating
                      ? "Generating workflow..."
                      : "Generate workflow"}
                  </button>
                </form>
              </Panel>

              <Panel
                title="Saved workflows"
                description={`${workflows.length} workflow${
                  workflows.length === 1 ? "" : "s"
                } available`}
              >
                <div className="space-y-2">
                  {workflows.length === 0 ? (
                    <EmptyState text="No saved workflows yet." />
                  ) : (
                    workflows.slice(0, 10).map((item) => (
                      <button
                        key={item.workflowId}
                        type="button"
                        onClick={() => loadWorkflow(item.workflowId)}
                        disabled={Boolean(loadingWorkflowId)}
                        className={`w-full rounded-2xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-70 ${
                          item.workflowId === workflow?.workflowId
                            ? "border-slate-950 bg-slate-950 text-white"
                            : "border-slate-200 bg-slate-50 text-slate-900 hover:border-slate-300 hover:bg-white"
                        }`}
                      >
                        <div className="truncate text-sm font-semibold">
                          {loadingWorkflowId === item.workflowId
                            ? "Loading..."
                            : item.name || item.contractName || item.workflowId}
                        </div>

                        <div
                          className={`mt-1 flex flex-wrap gap-2 text-xs ${
                            item.workflowId === workflow?.workflowId
                              ? "text-slate-300"
                              : "text-slate-500"
                          }`}
                        >
                          <span>{item.status}</span>
                          <span>•</span>
                          <span>{item.functionCount || 0} functions</span>
                          <span>•</span>
                          <span>
                            {item.storage?.provider ||
                              item.storageProvider ||
                              "cloud-ready"}
                          </span>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </Panel>
            </aside>
            <main className="space-y-5">
              {loadingWorkflowId ? (
                <Panel
                  title="Loading workflow"
                  description={`Fetching ${loadingWorkflowId} from storage...`}
                >
                  <MainLoadingState workflowId={loadingWorkflowId} />
                </Panel>
              ) : (
                <>
                  <Panel
                    title="Generated scripts"
                    description={
                      result
                        ? `${workflow?.contractName || "Workspace"} · ${
                            stats?.functionCount || 0
                          } functions detected`
                        : "Upload a WASM to generate scripts from its contract spec."
                    }
                    action={
                      result ? (
                        <div className="flex flex-wrap items-center gap-2">
                          {saveStatus ? (
                            <span className="rounded-full bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-600">
                              {saveStatus}
                            </span>
                          ) : null}

                          <button
                            type="button"
                            onClick={downloadSelectedFlow}
                            className="inline-flex items-center gap-2 rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                          >
                            <DocumentDownload size="16" color="currentColor" />
                            Download ZIP
                          </button>

                          <button
                            type="button"
                            onClick={() => openEditor()}
                            className="inline-flex items-center gap-2 rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                          >
                            <Edit2 size="16" color="currentColor" />
                            Edit
                          </button>

                          <button
                            type="button"
                            onClick={saveSelection}
                            disabled={!workflow?.workflowId}
                            className="inline-flex items-center gap-2 rounded-2xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
                          >
                            <Save2 size="16" color="currentColor" />
                            Save
                          </button>
                        </div>
                      ) : null
                    }
                  >
                    {!result ? (
                      <EmptyState text="Generated deploy, invoke, env, and workflow files will appear here." />
                    ) : (
                      <>
                        <CloudStorageNotice workflow={workflow} />

                        <div className="mb-5 grid gap-3 sm:grid-cols-4">
                          <Stat
                            label="Scripts"
                            value={
                              stats?.generatedWorkflows ||
                              generatedScriptPaths.length
                            }
                          />
                          <Stat
                            label="Deploy"
                            value={stats?.deployScripts || 0}
                          />
                          <Stat
                            label="Invoke"
                            value={stats?.invokeScripts || 0}
                          />
                          <Stat
                            label="Functions"
                            value={stats?.functionCount || 0}
                          />
                        </div>

                        <div className="mb-4 flex flex-col gap-2 sm:flex-row">
                          <button
                            type="button"
                            onClick={() =>
                              addScripts([
                                ...scriptGroups.Build,
                                ...scriptGroups.Deploy,
                                ...scriptGroups.Init,
                                ...scriptGroups.Invoke,
                              ])
                            }
                            disabled={!generatedScriptPaths.length}
                            className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                          >
                            Select all runnable
                          </button>

                          <button
                            type="button"
                            onClick={clearSelection}
                            disabled={!selectedScripts.length}
                            className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                          >
                            Clear selection
                          </button>
                        </div>

                        <div className="space-y-2">
                          {envFiles.length > 0 ? (
                            <button
                              type="button"
                              onClick={() => openEditor(envFiles[0])}
                              className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-left text-sm text-slate-600 transition hover:border-slate-300 hover:bg-white"
                            >
                              <span className="font-semibold text-slate-900">
                                env.sh included automatically.
                              </span>{" "}
                              Edit it from here or from the Edit button.
                            </button>
                          ) : null}

                          {scriptGroups.Build.map((path) => (
                            <ScriptCheckCard
                              key={path}
                              path={path}
                              label="Build"
                              checked={selectedScripts.includes(path)}
                              onToggle={() => toggleScript(path)}
                            />
                          ))}

                          {scriptGroups.Deploy.map((path) => (
                            <ScriptCheckCard
                              key={path}
                              path={path}
                              label="Deploy"
                              checked={selectedScripts.includes(path)}
                              onToggle={() => toggleScript(path)}
                            />
                          ))}

                          {scriptGroups.Init.map((path) => (
                            <ScriptCheckCard
                              key={path}
                              path={path}
                              label="Initialize"
                              checked={selectedScripts.includes(path)}
                              onToggle={() => toggleScript(path)}
                            />
                          ))}

                          {scriptGroups.Invoke.length > 0 ? (
                            <InvokeBar
                              count={scriptGroups.Invoke.length}
                              selectedCount={selectedInvokeCount}
                              onClick={() => setShowInvokeModal(true)}
                            />
                          ) : null}

                          {scriptGroups.Other.map((path) => (
                            <ScriptCheckCard
                              key={path}
                              path={path}
                              label="Script"
                              checked={selectedScripts.includes(path)}
                              onToggle={() => toggleScript(path)}
                            />
                          ))}
                        </div>
                      </>
                    )}
                  </Panel>

                  <Panel
                    title="Selected run order"
                    description="Drag selected scripts to reorder the generated CLI flow."
                  >
                    {selectedScripts.length === 0 ? (
                      <EmptyState text="Select generated scripts to build a runnable flow." />
                    ) : (
                      <div className="space-y-3">
                        {selectedScripts.map((path, index) => (
                          <div
                            key={path}
                            draggable
                            onDragStart={() => setDraggingPath(path)}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={() => moveScript(draggingPath, path)}
                            className="group flex cursor-grab items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm transition hover:border-slate-300 active:cursor-grabbing"
                          >
                            <div className="flex min-w-0 items-center gap-3">
                              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-slate-950 text-sm font-bold text-white">
                                {index + 1}
                              </div>

                              <div className="min-w-0">
                                <div className="truncate text-sm font-semibold text-slate-900">
                                  {methodNameFromPath(path)}
                                </div>
                                <div className="mt-0.5 truncate text-xs text-slate-500">
                                  {path}
                                </div>
                              </div>
                            </div>

                            <button
                              type="button"
                              onClick={() => toggleScript(path)}
                              className="rounded-xl border border-rose-200 bg-white px-3 py-2 text-sm font-semibold text-rose-600 transition hover:bg-rose-50"
                            >
                              <Trash size="16" color="currentColor" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </Panel>
                </>
              )}
            </main>
          </div>
        </section>
      </div>

      {showInvokeModal ? (
        <InvokeMethodModal
          scripts={scriptGroups.Invoke}
          selectedScripts={selectedScripts}
          onToggle={toggleScript}
          onAddAll={() => addScripts(scriptGroups.Invoke)}
          onClose={() => setShowInvokeModal(false)}
        />
      ) : null}

      {showEditModal ? (
        <EditFilesModal
          files={editableFiles}
          activeFile={activeEditFile}
          setActiveFile={setActiveEditFile}
          onChangeFile={(path, content) =>
            setEditableFiles((current) => ({
              ...current,
              [path]: content,
            }))
          }
          onClose={() => setShowEditModal(false)}
          onSave={saveSelection}
        />
      ) : null}
    </div>
  );
}

function getWorkflowIdFromUrl() {
  const pathId = window.location.pathname
    .split("/")
    .filter(Boolean)
    .find((part) => part.startsWith("wf_"));

  if (pathId) return pathId;

  const url = new URL(window.location.href);
  return url.searchParams.get("workflowId") || "";
}

function startStepTicker(setGenerationStep) {
  let index = 0;

  return setInterval(() => {
    index = Math.min(index + 1, GENERATION_STEPS.length - 1);
    setGenerationStep(GENERATION_STEPS[index]);
  }, 900);
}

function GenerationStatus({ activeStep }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
        <CloudAdd size="18" color="currentColor" />
        {activeStep || "Preparing workflow"}
      </div>

      <div className="space-y-2">
        {GENERATION_STEPS.map((step) => {
          const activeIndex = GENERATION_STEPS.indexOf(activeStep);
          const stepIndex = GENERATION_STEPS.indexOf(step);
          const completed = stepIndex < activeIndex;
          const active = step === activeStep;

          return (
            <div
              key={step}
              className={`flex items-center gap-2 text-xs ${
                completed || active ? "text-slate-900" : "text-slate-400"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  completed
                    ? "bg-emerald-500"
                    : active
                    ? "bg-slate-950"
                    : "bg-slate-300"
                }`}
              />
              {step}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CloudStorageNotice({ workflow }) {
  const hasCloud =
    workflow?.storageProvider === "r2" ||
    workflow?.r2Prefix ||
    workflow?.cloudStored;

  return (
    <div className="mb-5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl bg-white text-slate-700 ring-1 ring-slate-200">
          {hasCloud ? (
            <TickCircle size="18" color="currentColor" />
          ) : (
            <CloudAdd size="18" color="currentColor" />
          )}
        </div>

        <div>
          <div className="font-semibold text-slate-900">
            {hasCloud
              ? "Workflow stored in cloud storage."
              : "Workflow ready for cloud-backed storage."}
          </div>
          <div className="mt-1 text-xs leading-5 text-slate-500">
            Generated files, env configuration, and ZIP exports are served
            through the Sorobuild Flow API.
          </div>
        </div>
      </div>
    </div>
  );
}

function InvokeBar({ count, selectedCount, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-white p-3 text-left transition hover:border-slate-300 hover:bg-slate-50"
    >
      <div className="min-w-0">
        <div className="text-sm font-semibold text-slate-900">
          Invoke methods
        </div>
        <div className="mt-1 text-xs text-slate-500">
          {count} invokable functions · {selectedCount} selected
        </div>
      </div>

      <span className="rounded-full bg-slate-950 px-3 py-1 text-xs font-semibold text-white">
        Open
      </span>
    </button>
  );
}

function InvokeMethodModal({
  scripts,
  selectedScripts,
  onToggle,
  onAddAll,
  onClose,
}) {
  const [query, setQuery] = useState("");

  const filtered = scripts.filter((path) =>
    methodNameFromPath(path).toLowerCase().includes(query.toLowerCase())
  );

  const selectedCount = scripts.filter((path) =>
    selectedScripts.includes(path)
  ).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm">
      <div className="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
        <div className="border-b border-slate-200 px-5 py-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-base font-bold text-slate-900">
                Select invoke methods
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                {scripts.length} invokable functions · {selectedCount} selected
              </p>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
            >
              Close
            </button>
          </div>

          <div className="mt-4 flex gap-2">
            <div className="relative flex-1">
              <SearchNormal1
                size="17"
                color="currentColor"
                className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
              />

              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search method..."
                className="w-full rounded-2xl border border-slate-300 py-3 pl-10 pr-4 text-sm outline-none transition focus:border-slate-950"
              />
            </div>

            <button
              type="button"
              onClick={onAddAll}
              className="rounded-2xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Add all
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-2 overflow-auto p-5">
          {filtered.length === 0 ? (
            <EmptyState text="No methods match your search." />
          ) : (
            filtered.map((path) => (
              <ScriptCheckCard
                key={path}
                path={path}
                label="Invoke"
                checked={selectedScripts.includes(path)}
                onToggle={() => onToggle(path)}
              />
            ))
          )}
        </div>

        <div className="border-t border-slate-200 bg-slate-50 px-5 py-4 text-right">
          <button
            type="button"
            onClick={onClose}
            className="rounded-2xl bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function EditFilesModal({
  files,
  activeFile,
  setActiveFile,
  onChangeFile,
  onClose,
  onSave,
}) {
  const [query, setQuery] = useState("");

  const filePaths = Object.keys(files);
  const filteredFiles = filePaths.filter((path) =>
    path.toLowerCase().includes(query.toLowerCase())
  );

  const active =
    activeFile && files[activeFile] !== undefined ? activeFile : filePaths[0];

  const activeContent = files[active] || "";
  const lineCount = activeContent ? activeContent.split("\n").length : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="grid max-h-[86vh] w-full max-w-7xl overflow-hidden rounded-3xl border border-slate-800/10 bg-white shadow-2xl lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="flex min-h-[520px] flex-col border-r border-slate-200 bg-slate-50">
          <div className="border-b border-slate-200 p-4">
            <h3 className="text-base font-bold text-slate-900">Edit files</h3>
            <p className="mt-1 text-sm text-slate-500">
              Update generated scripts before export. env.sh is always included.
            </p>

            <div className="relative mt-4">
              <SearchNormal1
                size="16"
                color="currentColor"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search files..."
                className="w-full rounded-2xl border border-slate-300 bg-white py-2.5 pl-9 pr-3 text-sm outline-none transition focus:border-slate-950"
              />
            </div>
          </div>

          <div className="flex-1 space-y-2 overflow-auto p-3">
            {filteredFiles.length === 0 ? (
              <EmptyState text="No files match your search." />
            ) : (
              filteredFiles.map((path) => {
                const isActive = active === path;
                return (
                  <button
                    key={path}
                    type="button"
                    onClick={() => setActiveFile(path)}
                    className={`w-full rounded-2xl border p-3 text-left transition ${
                      isActive
                        ? "border-slate-950 bg-slate-950 text-white"
                        : "border-slate-200 bg-white text-slate-900 hover:border-slate-300 hover:bg-white"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                          isActive
                            ? "bg-white/10 text-slate-200"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {fileKind(path)}
                      </span>
                      <span className="truncate text-sm font-semibold">
                        {methodNameFromPath(path)}
                      </span>
                    </div>

                    <div
                      className={`mt-1 truncate text-xs ${
                        isActive ? "text-slate-300" : "text-slate-500"
                      }`}
                    >
                      {path}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <main className="flex min-h-[680px] flex-col">
          <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                  {fileKind(active)}
                </span>
                <div className="truncate text-sm font-bold text-slate-900">
                  {active}
                </div>
              </div>

              <div className="mt-1 text-xs text-slate-500">
                {lineCount} lines · Changes are saved into this workflow export.
              </div>
            </div>

            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center gap-2 rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                <CloseCircle size="16" color="currentColor" />
                Close
              </button>

              <button
                type="button"
                onClick={onSave}
                className="inline-flex items-center gap-2 rounded-2xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
              >
                <Save2 size="16" color="currentColor" />
                Save
              </button>
            </div>
          </div>

          <div className="flex flex-1 overflow-hidden bg-slate-950">
            <div className="hidden select-none border-r border-white/10 bg-slate-900 px-3 py-5 text-right font-mono text-xs leading-6 text-slate-500 md:block">
              {Array.from({ length: Math.max(lineCount, 1) }).map((_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>

            <textarea
              value={activeContent}
              onChange={(e) => onChangeFile(active, e.target.value)}
              spellCheck={false}
              className="min-h-0 flex-1 resize-none border-0 bg-slate-950 p-5 font-mono text-xs leading-6 text-slate-100 outline-none"
            />
          </div>
        </main>
      </div>
    </div>
  );
}

function fileKind(path) {
  if (path === "flow.selected.sh") return "flow";
  if (path.endsWith("env.sh")) return "env";
  if (path.endsWith("deploy.sh")) return "deploy";
  if (path.includes("/invoke/")) return "invoke";
  if (path.includes("/build/")) return "build";
  return "script";
}

function renderSelectedFlow(paths) {
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "# Generated by Sorobuild Flow UI",
    "# Run this from the generated workflow folder.",
    'ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    "",
    "run_step() {",
    '  local script_path="$1"',
    "  local script_dir",
    '  script_dir="$(dirname "$script_path")"',
    "",
    '  if [[ "$script_dir" == */scripts/* || "$script_dir" == scripts/* ]]; then',
    '    local contract_root="${script_dir%%/scripts/*}"',
    '    if [[ "$contract_root" == "$script_dir" ]]; then contract_root="."; fi',
    '    local relative_script="${script_path#${contract_root}/}"',
    '    (cd "$ROOT_DIR/$contract_root" && ./"$relative_script")',
    "  else",
    '    (cd "$ROOT_DIR" && ./"$script_path")',
    "  fi",
    "}",
    "",
  ];

  paths.forEach((path, index) => {
    lines.push(`echo "\\n▶ Step ${index + 1}: ${path}"`);
    lines.push(`run_step ${JSON.stringify(path)}`);
    lines.push("");
  });

  return lines.join("\n");
}

function UploadBox({ mode, file, onFileChange }) {
  return (
    <label className="group flex cursor-pointer flex-col items-center justify-center rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-4 py-4 text-center transition hover:border-slate-400 hover:bg-white">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-slate-700 shadow-sm ring-1 ring-slate-200 transition group-hover:scale-105">
        <DocumentUpload size="26" color="currentColor" />
      </div>

      <span className="mt-4 max-w-full truncate text-sm font-semibold text-slate-900">
        {file
          ? file.name
          : mode === "wasm"
          ? "Upload contract.wasm"
          : "Upload project.zip"}
      </span>

      <span className="mt-1 text-xs text-slate-500">
        {mode === "wasm" ? "Soroban WASM file" : "Cargo project ZIP"}
      </span>

      <input
        type="file"
        accept={mode === "wasm" ? ".wasm" : ".zip"}
        className="hidden"
        onChange={(e) => onFileChange(e.target.files?.[0] || null)}
      />
    </label>
  );
}

function Panel({ title, description, action, children }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h4 className="text-sm font-semibold text-slate-900">{title}</h4>
          {description ? (
            <p className="mt-1 text-sm leading-5 text-slate-500">
              {description}
            </p>
          ) : null}
        </div>

        {action ? <div className="shrink-0">{action}</div> : null}
      </div>

      <div className="p-4">{children}</div>
    </div>
  );
}

function Field({ label, className = "", ...props }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-2 block text-sm font-semibold text-slate-900">
        {label}
      </span>

      <input
        {...props}
        className="block w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 placeholder-slate-400 outline-none transition focus:border-slate-900"
      />
    </label>
  );
}

function EmptyState({ text }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-center text-sm text-slate-500">
      {text}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <div className="text-2xl font-bold text-slate-900">{value}</div>
      <div className="mt-1 text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
    </div>
  );
}

function Segmented({ value, onChange, options }) {
  return (
    <div className="grid grid-cols-2 rounded-2xl border border-slate-300 bg-white p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
            value === option.value
              ? "bg-slate-950 text-white"
              : "text-slate-700 hover:bg-slate-50"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ScriptCheckCard({ path, label = "Script", checked, onToggle }) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-3 rounded-2xl border p-3 transition ${
        checked
          ? "border-slate-950 bg-slate-50"
          : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="h-4 w-4 rounded border-slate-300"
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
            {label}
          </span>
          <span className="truncate text-sm font-semibold text-slate-900">
            {methodNameFromPath(path)}
          </span>
        </div>

        <div className="mt-1 truncate text-xs text-slate-500">{path}</div>
      </div>
    </label>
  );
}

function methodNameFromPath(path) {
  return path.split("/").pop()?.replace(/\.sh$/i, "") || path;
}
