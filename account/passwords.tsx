/**
 * @module web/ui/account/passwords
 *
 * Password rules and the change-password form.
 */
import { useState, type FormEvent } from 'react';
import { Alert, Button, CircularProgress, Stack, TextField } from '@mui/material';
import { api, errorText } from '../api.ts';
import { Field } from '../panes/fields.tsx';
import { PASSWORD_MIN } from '../lib/shared.ts';

export const MIN_PASSWORD_LENGTH = PASSWORD_MIN;

/**
 * New password twice; returns an error message, or '' when they are fine.
 *
 * @param password - Plain-text password.
 * @param again - Repeated password value.
 * @returns Error message, or `''` when valid.
 */
export const passwordProblem = (password: string, again: string) => (password.length < PASSWORD_MIN ? `The password must be at least ${PASSWORD_MIN} characters.`
  : password !== again ? 'The two passwords differ.' : '');

interface PasswordFormProps {
  onChanged: () => void;
  submitLabel: string;
}

/**
 * Current password and a new one twice. onChanged runs after the server accepted it.
 *
 * @param props - Component props.
 * @param props.onChanged - Callback invoked after the password is updated.
 * @param props.submitLabel - Submit button label.
 * @returns Rendered React element.
 */
export function PasswordForm({ onChanged, submitLabel }: PasswordFormProps) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [feedback, setFeedback] = useState<{ severity: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = passwordProblem(password, again);
    if (problem) { setFeedback({ severity: 'error', text: problem }); return; }
    setBusy(true);
    setFeedback(null);
    try {
      await api('PUT', '/api/me/password', { current, password });
      setCurrent(''); setPassword(''); setAgain('');
      setFeedback({ severity: 'success', text: 'Password changed. You were signed out everywhere else.' });
      onChanged();
    } catch (err) { setFeedback({ severity: 'error', text: errorText(err) }); }
    setBusy(false);
  }
  return (
    <form onSubmit={submit} autoComplete="off">
      <Stack spacing={2} sx={{ maxWidth: 360 }}>
        <Field label="Current password">
          <TextField type="password" size="small" fullWidth value={current} onChange={(event) => setCurrent(event.target.value)} required autoComplete="current-password" />
        </Field>
        <Field label={`New password (at least ${PASSWORD_MIN} characters)`}>
          <TextField type="password" size="small" fullWidth value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="new-password" />
        </Field>
        <Field label="New password again">
          <TextField type="password" size="small" fullWidth value={again} onChange={(event) => setAgain(event.target.value)} required autoComplete="new-password" />
        </Field>
        <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Button type="submit" variant="contained" disabled={busy}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}>
            {submitLabel}
          </Button>
        </Stack>
        {feedback && (
          <Alert severity={feedback.severity} role={feedback.severity === 'error' ? 'alert' : undefined}>
            {feedback.text}
          </Alert>
        )}
      </Stack>
    </form>
  );
}
