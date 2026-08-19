/**
 * Module: ui/settings (form fields)
 * Purpose: The accessible Material Design 3 form controls the settings catalogue is
 *          edited through (PROJECT_BIBLE.md §11.2, §11.7).
 * Restrictions: UI layer — presentational only; all styling comes from
 *          design-system tokens via class names (§11.17). Every field is a real
 *          labelled control with inline help wired through `aria-describedby`, and
 *          an invalid value is reported next to the field rather than swallowed
 *          (§4.9, §17.5). No string is hard-coded: copy arrives as props (§19.1).
 * Public API: SelectField, NumberField, TextField, ToggleField.
 */
import { useId, type ReactNode } from 'react';

interface FieldBase {
  readonly label: string;
  readonly help?: string;
  /** Validation message shown next to the field when the value was rejected. */
  readonly error?: string;
  readonly disabled?: boolean;
}

function describedBy(helpId: string, errorId: string, props: FieldBase): string | undefined {
  const ids = [props.help !== undefined ? helpId : '', props.error !== undefined ? errorId : '']
    .filter((id) => id !== '')
    .join(' ');
  return ids === '' ? undefined : ids;
}

function FieldShell(props: {
  readonly control: ReactNode;
  readonly label: string;
  readonly controlId: string;
  readonly helpId: string;
  readonly errorId: string;
  readonly field: FieldBase;
}): ReactNode {
  return (
    <div className="adl-field-row">
      <label className="adl-field-row__label" htmlFor={props.controlId}>
        {props.label}
      </label>
      {props.control}
      {props.field.help !== undefined && (
        <p className="adl-field-row__help" id={props.helpId}>
          {props.field.help}
        </p>
      )}
      {props.field.error !== undefined && (
        <p className="adl-field-row__error" id={props.errorId} role="alert">
          {props.field.error}
        </p>
      )}
    </div>
  );
}

export interface SelectFieldProps extends FieldBase {
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
}

export function SelectField(props: SelectFieldProps): ReactNode {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  return (
    <FieldShell
      label={props.label}
      controlId={id}
      helpId={helpId}
      errorId={errorId}
      field={props}
      control={
        <select
          id={id}
          className="adl-select"
          value={props.value}
          disabled={props.disabled ?? false}
          aria-describedby={describedBy(helpId, errorId, props)}
          onChange={(event) => {
            props.onChange(event.target.value);
          }}
        >
          {props.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      }
    />
  );
}

export interface NumberFieldProps extends FieldBase {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (value: number) => void;
}

export function NumberField(props: NumberFieldProps): ReactNode {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  return (
    <FieldShell
      label={props.label}
      controlId={id}
      helpId={helpId}
      errorId={errorId}
      field={props}
      control={
        <input
          id={id}
          className="adl-input"
          type="number"
          inputMode="numeric"
          value={String(props.value)}
          min={props.min}
          max={props.max}
          step={1}
          disabled={props.disabled ?? false}
          aria-describedby={describedBy(helpId, errorId, props)}
          aria-invalid={props.error !== undefined}
          onChange={(event) => {
            props.onChange(Number(event.target.value));
          }}
        />
      }
    />
  );
}

export interface TextFieldProps extends FieldBase {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
}

export function TextField(props: TextFieldProps): ReactNode {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  return (
    <FieldShell
      label={props.label}
      controlId={id}
      helpId={helpId}
      errorId={errorId}
      field={props}
      control={
        <input
          id={id}
          className="adl-input"
          type="text"
          value={props.value}
          disabled={props.disabled ?? false}
          aria-describedby={describedBy(helpId, errorId, props)}
          aria-invalid={props.error !== undefined}
          {...(props.placeholder !== undefined && { placeholder: props.placeholder })}
          onChange={(event) => {
            props.onChange(event.target.value);
          }}
        />
      }
    />
  );
}

export interface ToggleFieldProps extends FieldBase {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}

export function ToggleField(props: ToggleFieldProps): ReactNode {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  return (
    <FieldShell
      label={props.label}
      controlId={id}
      helpId={helpId}
      errorId={errorId}
      field={props}
      control={
        <input
          id={id}
          className="adl-toggle"
          type="checkbox"
          checked={props.checked}
          disabled={props.disabled ?? false}
          aria-describedby={describedBy(helpId, errorId, props)}
          onChange={(event) => {
            props.onChange(event.target.checked);
          }}
        />
      }
    />
  );
}
