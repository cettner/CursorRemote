import { useEffect, useState } from "react";
import type { Question } from "@cursorremote/protocol";

interface Props {
  question: Question;
  onAnswer(answer: string): void;
}

function remaining(expiresAt: number): string {
  const minutes = Math.max(0, Math.round((expiresAt - Date.now()) / 60000));
  if (minutes <= 0) return "about to time out";
  if (minutes === 1) return "1 minute left";
  return `${minutes} minutes left`;
}

export function QuestionBanner({ question, onAnswer }: Props) {
  const [draft, setDraft] = useState("");
  const [countdown, setCountdown] = useState(() => remaining(question.expiresAt));

  // The agent is blocked while this is up, so the deadline is worth showing.
  useEffect(() => {
    setDraft("");
    const timer = setInterval(() => setCountdown(remaining(question.expiresAt)), 15000);
    setCountdown(remaining(question.expiresAt));
    return () => clearInterval(timer);
  }, [question.questionId, question.expiresAt]);

  return (
    <div className="question">
      <div className="question-head">
        <strong>The agent is waiting on you</strong>
        <span className="muted small">{countdown}</span>
      </div>

      <p className="question-text">{question.question}</p>
      {question.context ? <p className="muted question-context">{question.context}</p> : null}

      {question.options && question.options.length > 0 ? (
        <div className="question-options">
          {question.options.map((option) => (
            <button key={option} type="button" onClick={() => onAnswer(option)}>
              {option}
            </button>
          ))}
        </div>
      ) : null}

      <form
        className="question-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim()) onAnswer(draft.trim());
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Type your answer"
          autoFocus
        />
        <button type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
