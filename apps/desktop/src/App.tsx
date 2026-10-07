import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isTerminal } from "@cursorremote/protocol";
import { Composer } from "./components/Composer";
import { ConnectScreen } from "./components/ConnectScreen";
import { JobList, STATUS_LABELS } from "./components/JobList";
import { QuestionBanner } from "./components/QuestionBanner";
import { Transcript } from "./components/Transcript";
import { DaemonConnection } from "./lib/connection";
import { initNotifications, isTauri, notify, notifyQuestion } from "./lib/notify";

const STORAGE_KEY = "cursorremote.credentials";

interface StoredCredentials {
  url: string;
  token: string;
}

function readStored(): StoredCredentials {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
      if (parsed.url && parsed.token) return { url: parsed.url, token: parsed.token };
    }
  } catch {
    // Fall through to the dev fallback, then to the connect screen.
  }

  // Lets `npm run tauri:dev` come up already pointed at a local daemon instead
  // of retyping the token on every reload. Never compiled into a release build.
  if (import.meta.env.DEV) {
    const url = import.meta.env.VITE_DAEMON_URL;
    const token = import.meta.env.VITE_DAEMON_TOKEN;
    if (url && token) return { url, token };
  }

  return { url: "", token: "" };
}

const connection = new DaemonConnection();

export function App() {
  const snapshot = useSyncExternalStore(connection.subscribe, connection.getSnapshot);
  const [stored, setStored] = useState<StoredCredentials>(readStored);
  const [autoConnected, setAutoConnected] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [composingNew, setComposingNew] = useState(false);
  const [newProject, setNewProject] = useState<string>();
  const requestedTranscripts = useRef(new Set<string>());

  useEffect(() => {
    void initNotifications();
  }, []);

  // Reconnect on launch so the app is useful without touching anything.
  useEffect(() => {
    if (autoConnected || !stored.url || !stored.token) return;
    setAutoConnected(true);
    connection.connect(stored);
  }, [autoConnected, stored]);

  useEffect(
    () =>
      connection.onAlert((alert) => {
        if (alert.kind === "question") {
          notifyQuestion(`${alert.projectName} needs you`, alert.question.question);
          setSelectedId(alert.question.jobId);
          setComposingNew(false);
        } else if (alert.kind === "finished") {
          notify(`${alert.job.projectName} finished`, alert.job.result?.slice(0, 180) ?? "Done.");
        } else {
          notify(`${alert.job.projectName} failed`, alert.job.error ?? "The run errored.");
        }
      }),
    [],
  );

  const selectedJob = useMemo(
    () => snapshot.jobs.find((job) => job.jobId === selectedId),
    [snapshot.jobs, selectedId],
  );

  // Pull the backlog once per job, so opening an old job is not an empty pane.
  useEffect(() => {
    if (!selectedId || snapshot.status !== "connected") return;
    if (requestedTranscripts.current.has(selectedId)) return;
    requestedTranscripts.current.add(selectedId);
    connection.loadTranscript(selectedId);
  }, [selectedId, snapshot.status]);

  useEffect(() => {
    if (snapshot.status !== "connected") requestedTranscripts.current.clear();
  }, [snapshot.status]);

  useEffect(() => {
    if (!newProject && snapshot.projects.length > 0) setNewProject(snapshot.projects[0]?.id);
  }, [newProject, snapshot.projects]);

  const handleConnect = useCallback((url: string, token: string) => {
    const credentials = { url, token };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
    setStored(credentials);
    setAutoConnected(true);
    connection.connect(credentials);
  }, []);

  const handleForget = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    connection.disconnect();
    setStored({ url: "", token: "" });
    setAutoConnected(false);
    setSelectedId(undefined);
  }, []);

  if (snapshot.status === "disconnected" && !stored.url) {
    return (
      <ConnectScreen
        status={snapshot.status}
        error={snapshot.error}
        initialUrl={stored.url}
        initialToken={stored.token}
        onConnect={handleConnect}
      />
    );
  }

  if (snapshot.status === "error" && snapshot.error?.includes("token")) {
    return (
      <ConnectScreen
        status={snapshot.status}
        error={snapshot.error}
        initialUrl={stored.url}
        initialToken={stored.token}
        onConnect={handleConnect}
      />
    );
  }

  const pending = selectedJob?.pendingQuestion ?? null;
  const events = selectedId ? (snapshot.transcripts[selectedId] ?? []) : [];
  const jobIsLive = selectedJob ? !isTerminal(selectedJob.status) : false;

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-head">
          <div>
            <div className="host">{snapshot.hostName ?? "Connecting..."}</div>
            <div className={`conn ${snapshot.status}`}>
              {snapshot.status === "connected" ? "connected" : (snapshot.error ?? snapshot.status)}
            </div>
          </div>
          <button type="button" className="link" onClick={handleForget}>
            Switch
          </button>
        </header>

        <JobList
          jobs={snapshot.jobs}
          selectedId={composingNew ? undefined : selectedId}
          onSelect={(jobId) => {
            setSelectedId(jobId);
            setComposingNew(false);
          }}
          onNew={() => {
            setComposingNew(true);
            setSelectedId(undefined);
          }}
        />
      </aside>

      <main className="main">
        {composingNew || (!selectedJob && snapshot.jobs.length === 0) ? (
          <section className="pane">
            <header className="pane-head">
              <h2>New job</h2>
            </header>
            <div className="newjob">
              <label>
                Project
                <select
                  value={newProject ?? ""}
                  onChange={(event) => setNewProject(event.target.value)}
                >
                  {snapshot.projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted small">
                Runs on {snapshot.hostName} in{" "}
                {snapshot.projects.find((project) => project.id === newProject)?.cwd ?? "?"}
              </p>
            </div>
            <Composer
              placeholder="What should the agent do?"
              submitLabel="Start"
              disabled={!newProject || snapshot.status !== "connected"}
              onSubmit={(text) => {
                if (!newProject) return;
                connection.startJob(newProject, text);
                setComposingNew(false);
              }}
            />
          </section>
        ) : selectedJob ? (
          <section className="pane">
            <header className="pane-head">
              <div>
                <h2>{selectedJob.projectName}</h2>
                <span className={`job-status ${selectedJob.status}`}>
                  {STATUS_LABELS[selectedJob.status]}
                </span>
              </div>
              {jobIsLive ? (
                <button
                  type="button"
                  className="danger"
                  onClick={() => connection.cancel(selectedJob.jobId)}
                >
                  Cancel
                </button>
              ) : null}
            </header>

            {selectedJob.error ? <p className="error pad">{selectedJob.error}</p> : null}

            <Transcript events={events} />

            {pending ? (
              <QuestionBanner
                question={pending}
                onAnswer={(answer) => connection.answer(pending.questionId, answer)}
              />
            ) : (
              <Composer
                placeholder={jobIsLive ? "Interrupt with a note" : "Send a follow-up"}
                submitLabel={jobIsLive ? "Steer" : "Send"}
                disabled={snapshot.status !== "connected"}
                onSubmit={(text) => {
                  if (jobIsLive) connection.steer(selectedJob.jobId, text);
                  else connection.followUp(selectedJob.jobId, text);
                }}
              />
            )}
          </section>
        ) : (
          <div className="empty">
            <p className="muted">Pick a job, or start a new one.</p>
          </div>
        )}
      </main>

      {!isTauri ? (
        <div className="browser-note">
          Running in a browser: notifications stop when you close this tab.
        </div>
      ) : null}
    </div>
  );
}
