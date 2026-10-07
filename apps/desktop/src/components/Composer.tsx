import { useState } from "react";

interface Props {
  placeholder: string;
  submitLabel: string;
  disabled?: boolean;
  onSubmit(text: string): void;
}

export function Composer({ placeholder, submitLabel, disabled, onSubmit }: Props) {
  const [draft, setDraft] = useState("");

  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    onSubmit(text);
    setDraft("");
  };

  return (
    <div className="composer">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={placeholder}
        rows={3}
        disabled={disabled}
        onKeyDown={(event) => {
          // Enter sends, Shift+Enter breaks the line.
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <button type="button" onClick={submit} disabled={disabled || !draft.trim()}>
        {submitLabel}
      </button>
    </div>
  );
}
