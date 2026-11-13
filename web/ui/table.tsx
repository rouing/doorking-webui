import { Table } from '@radix-ui/themes';
import { cmpCells } from './format.ts';

export type Column = [label: string, key: string];
export interface Sort { col: string; dir: 1 | -1; then?: { col: string; dir: 1 | -1 } }

// Next sort for a header click. With dateTime (Transactions): Time clicked while sorted by Date sorts the times
// within each date (Date stays first); clicking Date again flips the dates and keeps that.
export function nextSort(cur: Sort | null, key: string, dateTime = false): Sort {
  if (dateTime && cur && cur.col === 'date') {
    if (key === 'time') return { col: 'date', dir: cur.dir, then: { col: 'time', dir: cur.then ? (-cur.then.dir as 1 | -1) : 1 } };
    if (key === 'date' && cur.then) return { ...cur, dir: -cur.dir as 1 | -1 };
  }
  return { col: key, dir: cur && cur.col === key && !cur.then ? (-cur.dir as 1 | -1) : 1 };
}

// Rows sorted by `sort`; value(col) gives the value a column sorts on.
export function sortRows<R>(rows: R[], sort: Sort | null, value: (col: string) => (r: R) => unknown): R[] {
  if (!sort) return rows;
  const v1 = value(sort.col);
  const then = sort.then;
  const v2 = then && value(then.col);
  return [...rows].sort((a, b) => cmpCells(v1(a), v1(b)) * sort.dir || (v2 && then ? cmpCells(v2(a), v2(b)) * then.dir : 0));
}

// Header row whose cells sort the table on click (▲/▼, with 1/2 for a two-level sort).
export function SortHead({ cols, sort, onSort, title }: {
  cols: Column[]; sort: Sort | null; onSort: (key: string) => void; title?: (key: string) => string;
}) {
  const arrow = (dir: number) => (dir > 0 ? ' ▲' : ' ▼');
  return (
    <Table.Header>
      <Table.Row>
        {cols.map(([label, key]) => (
          <Table.ColumnHeaderCell key={key} onClick={() => onSort(key)} style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}
            title={title ? title(key) : 'Click to sort'}>
            {label}
            {!sort ? '' : sort.col === key ? arrow(sort.dir) + (sort.then ? ' 1' : '')
              : sort.then && sort.then.col === key ? `${arrow(sort.then.dir)} 2` : ''}
          </Table.ColumnHeaderCell>
        ))}
      </Table.Row>
    </Table.Header>
  );
}

export const MAX_ROWS = 2000;
