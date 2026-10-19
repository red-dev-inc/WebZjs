import React from 'react';
import ErrorMessage from '../ErrorMessage/ErrorMessage';

export type InputTone = 'default' | 'success' | 'warning';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  /** Colors the field border: green for a confirmed value, amber for one to double-check */
  tone?: InputTone;
  /** A short note under the field, shown in the tone's color (an error replaces it) */
  hint?: string;
  containerClassName?: string;
  labelClassName?: string;
  inputClassName?: string;
  suffix?: string;
  id: string;
}

const toneBorder: Record<InputTone, string> = {
  default: 'border-[#afafaf]',
  success: 'border-green-600',
  warning: 'border-amber-500',
};

const toneText: Record<InputTone, string> = {
  default: 'text-[#595959]',
  success: 'text-green-700',
  warning: 'text-amber-700',
};

const Input: React.FC<InputProps> = ({
  label,
  error,
  tone = 'default',
  hint,
  containerClassName = '',
  labelClassName = '',
  inputClassName = '',
  suffix = '',
  id,
  ...props
}) => {
  return (
    <div className={`flex flex-col gap-1 w-full ${containerClassName}`}>
      {label && (
        <label
          htmlFor={id}
          className={`text-black text-base font-normal leading-normal ${labelClassName}`}
        >
          {label}
        </label>
      )}
      <div
        className={`h-full flex items-center bg-neutral-50 rounded-xl border p-3 ${toneBorder[tone]}`}
      >
        <input
          {...props}
          id={id}
          className={`grow bg-transparent focus:outline-hidden text-[#0e0e0e] text-base font-semibold font-inter ${inputClassName}`}
          aria-describedby={!error && hint ? `${id}-suffix ${id}-hint` : `${id}-suffix`}
        />
        <span
          id={`${id}-suffix`}
          className="ml-2 text-[#a9aaab] text-base font-medium leading-normal"
        >
          {suffix}
        </span>
      </div>
      <ErrorMessage text={error} />
      {!error && hint && (
        <span id={`${id}-hint`} className={`text-sm ${toneText[tone]}`}>
          {hint}
        </span>
      )}
    </div>
  );
};

export default Input;
