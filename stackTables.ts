/**
 * @module web/ui/stackTables
 *
 * Tables on phones: styles.css shows each body row as a card and each cell as a line with its column's name in front
 * (the cell's data-label). The names are copied from the header rows (colSpan and rowSpan included, so a two-row
 * header gives "Tone to open · 1"), for each table whose rows or header change, nested ones too.
 */
import { phoneQuery } from './phone.ts';

const SORT_MARK = /\s*(?:[▲▼]\s*[12]?|\([12]\)|sorted\s+(?:ascending|descending))\s*$/i;

/**
 * The name of each column: the header texts above it, top to bottom.
 *
 * @param head - `HTMLTableSectionElement` value.
 * @returns `string[]` result.
 */
function columnNames(head: HTMLTableSectionElement): string[] {
  const grid: string[][] = [];
  [...head.rows].forEach((row, rowIndex) => {
    grid[rowIndex] ??= [];
    let column = 0;
    for (const cell of [...row.cells]) {
      while (grid[rowIndex][column] !== undefined) column++;
      const text = (cell.textContent || '').replace(SORT_MARK, '').trim();
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        grid[rowIndex + dr] ??= [];
        for (let dc = 0; dc < cell.colSpan; dc++) grid[rowIndex + dr][column + dc] = dr ? '' : text;
      }
      column += cell.colSpan;
    }
  });
  const columns = Math.max(0, ...grid.map((row) => row.length));
  return Array.from({ length: columns }, (_, column) => [...new Set(grid.map((row) => row[column]).filter(Boolean))].join(' · '));
}

function labelTable(table: HTMLTableElement): void {
  const names = table.tHead ? columnNames(table.tHead) : [];
  for (const body of [...table.tBodies]) {
    for (const row of [...body.rows]) {
      let column = 0;
      for (const cell of [...row.cells]) {
        const name = cell.colSpan === 1 && cell.tagName === 'TD' ? names[column] : '';
        if (name && cell.dataset.label !== name) cell.dataset.label = name;
        if (!name && cell.dataset.label !== undefined) delete cell.dataset.label;
        column += cell.colSpan;
      }
    }
  }
}

/**
 * Labels the page's tables while the window is phone-sized: all of them when it becomes phone-sized, then only the
 * tables whose elements change (at most once a frame), so typing elsewhere or the progress log costs nothing.
 */
export function stackTablesOnPhones(): void {
  const changed = new Set<HTMLTableElement>();
  let all = true;
  let queued = false;
  const run = () => {
    queued = false;
    if (!phoneQuery.matches) { changed.clear(); return; }
    const tables = all ? [...document.querySelectorAll('table')] : [...changed].filter((table) => table.isConnected);
    all = false;
    changed.clear();
    tables.forEach(labelTable);
  };
  const queue = () => {
    if (queued || !phoneQuery.matches) return;
    queued = true;
    requestAnimationFrame(run);
  };
  new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      const table = target?.closest('table');
      if (table) changed.add(table);
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node instanceof HTMLTableElement) changed.add(node);
        node.querySelectorAll('table').forEach((inner) => changed.add(inner));
      }
    }
    if (changed.size) queue();
  }).observe(document.body, { childList: true, subtree: true });
  phoneQuery.addEventListener('change', () => { all = true; queue(); });
  queue();
}
