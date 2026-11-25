import { useEffect, useState, type ReactNode } from 'react';
import { Button, Stack, TableCell, TableHead, TableRow, TableSortLabel, Typography } from '@mui/material';
import { usePhone } from './phone.ts';
import { cmpCells } from './format.ts';

export type Column = [label: string, key: string];
export interface Sort { col: string; dir: 1 | -1; then?: { col: string; dir: 1 | -1 } }

/**
 * Next sort for a header click. With dateTime (Transactions): Time clicked while sorted by Date sorts the times
 * within each date (Date stays first); clicking Date again flips the dates and keeps that.
 *
 * @param cur - Current sort state.
 * @param key - Column key.
 * @param [dateTime] - Enable secondary time-within-date sorting.
 * @returns Next `Sort` state.
 */
export function nextSort(cur: Sort | null, key: string, dateTime = false): Sort {
  if (dateTime && cur && cur.col === 'date') {
    if (key === 'time') return { col: 'date', dir: cur.dir, then: { col: 'time', dir: cur.then ? (-cur.then.dir as 1 | -1) : 1 } };
    if (key === 'date' && cur.then) return { ...cur, dir: -cur.dir as 1 | -1 };
  }
  return { col: key, dir: cur && cur.col === key && !cur.then ? (-cur.dir as 1 | -1) : 1 };
}

/**
 * Rows sorted by `sort`; value(col) gives the value a column sorts on.
 *
 * @param rows - Input rows.
 * @param sort - Active sort specification.
 * @param value - Value extractor by column key.
 * @returns Sorted copy of rows.
 */
export function sortRows<R>(rows: R[], sort: Sort | null, value: (col: string) => (row: R) => unknown): R[] {
  if (!sort) return rows;
  const first = value(sort.col);
  const then = sort.then;
  const second = then && value(then.col);
  return [...rows].sort((a, b) => cmpCells(first(a), first(b)) * sort.dir || (second && then ? cmpCells(second(a), second(b)) * then.dir : 0));
}

interface SortHeadProps {
  cols: Column[];
  sort: Sort | null;
  onSort: (key: string) => void;
  title?: (key: string) => string;
  leading?: ReactNode;
}

/**
 * Header row whose cells sort the table via keyboard-accessible MUI `TableSortLabel`.
 *
 * @param props - Component props.
 * @returns Rendered table head.
 */
export function SortHead({ cols, sort, onSort, title, leading }: SortHeadProps) {
  return (
    <TableHead className="sort-head">
      <TableRow>
        {leading}
        {cols.map(([label, key]) => {
          const isPrimary = Boolean(sort && sort.col === key);
          const isSecondary = Boolean(sort?.then && sort.then.col === key);
          const active = isPrimary || isSecondary;
          const dir = isPrimary ? (sort!.dir > 0 ? 'asc' : 'desc') : isSecondary ? (sort!.then!.dir > 0 ? 'asc' : 'desc') : 'asc';
          return (
            <TableCell key={key} sortDirection={active ? dir : false} sx={{ whiteSpace: 'nowrap' }} title={title ? title(key) : 'Click to sort'}>
              <TableSortLabel active={active} direction={dir} onClick={() => onSort(key)}>
                {label}
                {isPrimary && sort?.then ? ' (1)' : isSecondary ? ' (2)' : ''}
              </TableSortLabel>
            </TableCell>
          );
        })}
      </TableRow>
    </TableHead>
  );
}

const PAGE_ROWS = 2000;
const PHONE_ROWS = 100;

interface ShownRows {
  limit: number;
  more: ReactNode;
  showMore: () => void;
}

/**
 * Progressive paging helper for long tables.
 *
 * @param total - Total row count.
 * @param reset - Reset key.
 * @returns Paging state and Show More controls.
 */
export function useShownRows(total: number, reset: unknown, stepOverride?: number): ShownRows {
  const isPhone = usePhone();
  const step = stepOverride ?? (isPhone ? PHONE_ROWS : PAGE_ROWS);
  const [pages, setPages] = useState(1);
  useEffect(() => { setPages(1); }, [reset]);
  const limit = step * pages;
  const more = total > limit ? (
    <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <Typography variant="body2" color="text.secondary">Showing {limit} of {total}</Typography>
      <Button variant="outlined" size="small" onClick={() => setPages(pages + 1)}>
        Load more ({Math.min(step, total - limit)})
      </Button>
    </Stack>
  ) : null;
  return { limit, more, showMore: () => setPages((shown) => shown + 1) };
}
