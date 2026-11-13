import { useCallback, useRef, useState, type ReactNode } from 'react';
import { AlertDialog, Box, Button, Flex, Text } from '@radix-ui/themes';

interface Ask { title: string; body?: ReactNode; action: string; color?: 'red' | 'blue' }

// A confirmation dialog: `confirm({ title, body, action })` resolves true when the action button is clicked.
// Render `dialog` once in the component.
export function useConfirm(): [ReactNode, (ask: Ask) => Promise<boolean>] {
  const [ask, setAsk] = useState<Ask | null>(null);
  const resolve = useRef<(ok: boolean) => void>(() => {});
  const confirm = useCallback((a: Ask) => new Promise<boolean>((res) => { resolve.current = res; setAsk(a); }), []);
  const close = (ok: boolean) => { setAsk(null); resolve.current(ok); };
  const dialog = (
    <AlertDialog.Root open={ask !== null} onOpenChange={(open) => { if (!open) close(false); }}>
      <AlertDialog.Content maxWidth="520px" aria-describedby={undefined}>
        <AlertDialog.Title>{ask?.title}</AlertDialog.Title>
        {ask?.body && <Box><Text as="div" size="2">{ask.body}</Text></Box>}
        <Flex gap="3" mt="4" justify="end">
          <AlertDialog.Cancel><Button variant="soft" color="gray">Cancel</Button></AlertDialog.Cancel>
          <AlertDialog.Action>
            <Button color={ask?.color || 'blue'} onClick={() => close(true)}>{ask?.action}</Button>
          </AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
  return [dialog, confirm];
}
