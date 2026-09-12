import type { ReactElement, ReactNode } from 'react';
import { useForm } from '../module/inputs.tsx';

/**
 * One decision with three parts, on one row. The three card contents were three 57px field rows
 * carrying a 23px switch each, which reads as three separate settings rather than as one.
 *
 * The checkboxes are children rather than a `toggles` array so that each one still declares its own
 * `path` where the page can see it — the area index is read off this route's source.
 */
export function CardShows({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="field field-bool-group">
      <span className="field-head">
        <span className="field-head-line">
          <span className="field-label">{label}</span>
        </span>
      </span>

      <fieldset className="bool-group">
        {/* The row's label above is the group's name, and a legend is how a checkbox group carries
            one — printing it twice is what the sr-only is for. */}
        <legend className="sr-only">{label}</legend>
        {children}
      </fieldset>
    </div>
  );
}

export function CardShow({ path, label }: { path: string; label: string }): ReactElement {
  const form = useForm();

  return (
    <label className="bool-option" data-path={path}>
      <input
        type="checkbox"
        checked={form.value(path, true) === true}
        onChange={(event) => form.set(path, event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
