/**
 * @module web/ui/account/SingleSignOn
 *
 * Single sign-on: starting a provider sign-in and the account's linked sign-ins.
 */
import { useEffect, useState, type FormEvent } from 'react';
import {
  Alert, Box, Button, Card, CardContent, Paper, Stack, TextField, Typography,
} from '@mui/material';
import type { SsoIdentityInfo } from '../../../src/types.ts';
import { api, errorText } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { fmtTime } from '../format.ts';
import type { SignedIn } from '../App.tsx';
import { Field } from '../panes/fields.tsx';

/**
 * Starts a single sign-on: asks the server for the provider's address (path: /api/sso/start, or /api/me/sso/start to
 * link), then opens it. The provider sends the browser back to the app.
 *
 * @param path - /api/sso/start, or /api/me/sso/start to link.
 * @param body - Parsed JSON request body.
 */
export async function startSso(path: string, body: Record<string, unknown>): Promise<void> {
  const { url } = await api<{ url: string }>('POST', path, body);
  window.location.assign(url);
}

interface SingleSignOnProps {
  session: SignedIn;
}

/**
 * The account's single sign-on: linked provider accounts (unlink) and Link buttons (the current password first, when the
 * account has one; the provider then sends the browser back here).
 *
 * @param props - Component props.
 * @param props.session - Authenticated user or API-key session.
 * @returns Rendered React element.
 */
export function SingleSignOn({ session }: SingleSignOnProps) {
  const [list, setList] = useState<SsoIdentityInfo[]>([]);
  const [password, setPassword] = useState('');
  const [feedback, setFeedback] = useState<{ severity: 'info' | 'success' | 'error'; text: string } | null>(null);
  const [dialog, confirm] = useConfirm();
  useEffect(() => {
    api<{ identities: SsoIdentityInfo[] }>('GET', '/api/me/sso')
      .then((reply) => setList(reply.identities), (err) => setFeedback({ severity: 'error', text: errorText(err) }));
  }, []);
  if (!session.sso.length && !list.length) return null;
  const linkTo = (provider: string) => {
    setFeedback({ severity: 'info', text: 'Opening the sign-in page…' });
    startSso('/api/me/sso/start', { provider, password })
      .catch((err) => setFeedback({ severity: 'error', text: errorText(err) }));
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (session.sso.length === 1) linkTo(session.sso[0].id);
  };
  const unlink = async (identity: SsoIdentityInfo) => {
    if (!await confirm({
      title: `Unlink ${identity.providerName}${identity.email ? ` (${identity.email})` : ''}?`,
      action: 'Unlink',
      color: 'red',
      body: 'It will no longer sign you in to this account.',
    })) return;
    try {
      const reply = await api<{ identities: SsoIdentityInfo[] }>(
        'DELETE',
        `/api/me/sso/${encodeURIComponent(identity.provider)}/${encodeURIComponent(identity.subject)}`,
      );
      setList(reply.identities);
      setFeedback({ severity: 'success', text: `Unlinked ${identity.providerName}.` });
    } catch (err) {
      setFeedback({ severity: 'error', text: errorText(err) });
    }
  };
  return (
    <Card>
      {dialog}
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2">Single sign-on</Typography>
          <Typography variant="body2" color="text.secondary">
            Sign in with your work account instead of a password. Link it here once; then use its button on the sign-in page.
          </Typography>
          {list.length > 0 && (
            <Stack spacing={1.25}>
              {list.map((identity) => (
                <Paper key={`${identity.provider}/${identity.subject}`} elevation={0} sx={{ p: 1.5, borderRadius: 2, bgcolor: 'action.hover' }}>
                  <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }} useFlexGap>
                    <Box sx={{ minWidth: 0, flex: '1 1 12rem' }}>
                      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                        {identity.providerName}{identity.email ? ` · ${identity.email}` : ''}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        Linked {fmtTime(identity.linkedAt)} · Last used {identity.lastUsedAt ? fmtTime(identity.lastUsedAt) : 'never'}
                      </Typography>
                    </Box>
                    <Button size="small" color="error" variant="text" onClick={() => unlink(identity)}>
                      Unlink
                    </Button>
                  </Stack>
                </Paper>
              ))}
            </Stack>
          )}
          {session.sso.length > 0 && (
            <form onSubmit={onSubmit} autoComplete="off">
              <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
                {session.hasPassword && (
                  <Field label="Your current password">
                    <TextField type="password" size="small" value={password} autoComplete="current-password"
                      onChange={(event) => setPassword(event.target.value)} />
                  </Field>
                )}
                {session.sso.map((provider) => (
                  <Button key={provider.id} type="button" variant="outlined" onClick={() => linkTo(provider.id)}>
                    Link {provider.name}
                  </Button>
                ))}
              </Stack>
            </form>
          )}
          {feedback && (
            <Alert severity={feedback.severity} role={feedback.severity === 'error' ? 'alert' : undefined}>
              {feedback.text}
            </Alert>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
