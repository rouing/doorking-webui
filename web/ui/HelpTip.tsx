import { Tooltip } from '@radix-ui/themes';
import { QuestionMarkCircledIcon } from '@radix-ui/react-icons';
import { HELP } from './help.ts';

// A small "?" that shows more detail when hovered or focused with the keyboard. of: a key in HELP; text: own text.
// Clicking it does nothing, so it can sit inside a label or a clickable row.
export function HelpTip({ of, text }: { of?: string; text?: string }) {
  const content = text ?? (of ? HELP[of] : undefined);
  if (!content) return null;
  return (
    <Tooltip content={<span style={{ display: 'block', maxWidth: 340, whiteSpace: 'normal' }}>{content}</span>}>
      <span className="help-tip" tabIndex={0} role="img" aria-label={content}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
        <QuestionMarkCircledIcon />
      </span>
    </Tooltip>
  );
}
