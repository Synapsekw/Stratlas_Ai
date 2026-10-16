import { useRef } from 'react';

/** An inline name field: Enter or leaving it saves, Escape cancels; `onEnd` runs once. */
export function RenameField({
  initial,
  label,
  placeholder,
  testId,
  onCommit,
  onEnd,
}: {
  initial: string;
  label: string;
  placeholder: string;
  testId: string;
  onCommit: (name: string) => void;
  onEnd: () => void;
}) {
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    if (value !== null && value.trim() !== initial) onCommit(value.trim());
    onEnd();
  };
  return (
    <input
      className="input drename"
      type="text"
      defaultValue={initial}
      maxLength={80}
      aria-label={label}
      placeholder={placeholder}
      data-testid={testId}
      // the field stands where the name was: the person who asked to rename types right away
      autoFocus
      onFocus={(e) => {
        e.currentTarget.select();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(e.currentTarget.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={(e) => {
        finish(e.currentTarget.value);
      }}
    />
  );
}
