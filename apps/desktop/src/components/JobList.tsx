import type { JobStatus, JobSummary } from "@cursorremote/protocol";

const LABELS: Record<JobStatus, string> = {
  queued: "Starting",
  running: "Running",
  awaiting_answer: "Needs you",
  finished: "Done",
  error: "Failed",
  cancelled: "Cancelled",
};

function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

interface Props {
  jobs: JobSummary[];
  selectedId?: string;
  onSelect(jobId: string): void;
  onNew(): void;
}

export function JobList({ jobs, selectedId, onSelect, onNew }: Props) {
  return (
    <div className="joblist">
      <button className="new-job" type="button" onClick={onNew}>
        New job
      </button>

      {jobs.length === 0 ? <p className="muted pad">Nothing yet.</p> : null}

      <ul>
        {jobs.map((job) => (
          <li key={job.jobId}>
            <button
              type="button"
              className={job.jobId === selectedId ? "job selected" : "job"}
              onClick={() => onSelect(job.jobId)}
            >
              <span className="job-top">
                <span className={`dot ${job.status}`} />
                <span className="job-project">{job.projectName}</span>
                <span className="muted small">{relativeTime(job.updatedAt)}</span>
              </span>
              <span className="job-prompt">{job.prompt}</span>
              <span className={`job-status ${job.status}`}>{LABELS[job.status]}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export { LABELS as STATUS_LABELS };
