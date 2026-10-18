import { useRef } from 'react';

/** An inline name field: Enter or leaving it saves, Escape cancels; `onEnd` runs once. */
export function RenameField({
  initial,
  label,
  placeholder,
  testId,
  onCommit,
  onEnd,
  maxLength = 80,
}: {
  initial: string;
  label: string;
  placeholder: string;
  testId: string;
  onCommit: (name: string) => void;
  /** `how` is blur when focus left the field, so the caller keeps focus where the person put it. */
  onEnd: (how: 'enter' | 'escape' | 'blur') => void;
  /** The longest name the field takes (measurement labels take more than a dataset name). */
  maxLength?: number;
}) {
  const done = useRef(false);
  const finish = (value: string | null, how: 'enter' | 'escape' | 'blur') => {
    if (done.current) return;
    done.current = true;
    if (value !== null && value.trim() !== initial) onCommit(value.trim());
    onEnd(how);
  };
  return (
    <input
      className="input drename"
      type="text"
      defaultValue={initial}
      maxLength={maxLength}
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
          finish(e.currentTarget.value, 'enter');
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(null, 'escape');
        }
      }}
      onBlur={(e) => {
        finish(e.currentTarget.value, 'blur');
      }}
      // clicks and presses in the field are the field's, not the row's (select, mark, drag)
      onClick={(e) => {
        e.stopPropagation();
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
      }}
    />
  );
}
