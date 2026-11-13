// Turns the user guide (docs/MANUAL.md) into HTML for the /help page. Handles only what the guide uses: headings (# to ###,
// with GitHub-style ids so its "#section" links work), paragraphs, "-" and "1." lists (continuation lines indented),
// tables, "> " quotes, **bold**, *italic*, `code` and [links](#... or http(s)://...). All text is HTML-escaped.

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// GitHub's heading id: lower case, punctuation other than spaces and hyphens dropped, spaces to hyphens.
export const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-');

const plain = (s: string): string => s.replace(/\*\*|`|\*/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

// Inline markup of one line or paragraph.
export function inline(text: string): string {
  return text.split('`').map((part, i) => {
    if (i % 2) return `<code>${esc(part)}</code>`;
    return esc(part)
      .replace(/\[([^\]]+)\]\((#[\w-]*|https?:\/\/[^\s)]+)\)/g, (_, t: string, href: string) =>
        `<a href="${href}"${href.startsWith('#') ? '' : ' target="_blank" rel="noopener"'}>${t}</a>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  }).join('');
}

const cells = (row: string): string[] => row.trim().replace(/^\||\|$/g, '').replace(/\\\|/g, '\u0000').split('|')
  .map((c) => c.replace(/\u0000/g, '|').trim());

// The guide's HTML body (no <html> wrapper).
export function markdownToHtml(md: string): string {
  const lines = md.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); para = []; };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  const flush = () => { flushPara(); flushList(); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const item = /^(-|\d+\.) (.*)$/.exec(line);
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (!line.trim()) { flush(); continue; }
    if (heading) {
      flush();
      const n = heading[1].length;
      out.push(`<h${n} id="${slug(plain(heading[2]))}">${inline(heading[2])}</h${n}>`);
    } else if (line.startsWith('>')) {
      flush();
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) quote.push(lines[i++].replace(/^> ?/, ''));
      i--;
      out.push(`<blockquote><p>${inline(quote.join(' '))}</p></blockquote>`);
    } else if (line.startsWith('|') && /^\|[\s:|-]+\|$/.test((lines[i + 1] || '').trim())) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].startsWith('|'); i++) rows.push(cells(lines[i]));
      i--;
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    } else if (item) {
      flushPara();
      const tag = item[1] === '-' ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push(item[2]);
    } else if (list && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flush();
  return out.join('\n');
}

// The whole /help page: the guide with its own styles (light and dark).
export function helpPage(md: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>User guide · DoorKing Gate Manager</title><style>
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #60646c; --line: #d9d9e0; --bg: #fff; --soft: #f4f4f6; --accent: #3e63dd; }
@media (prefers-color-scheme: dark) { :root { --fg: #ededef; --muted: #a0a0ab; --line: #3a3a40; --bg: #111113; --soft: #1c1c20; --accent: #8da4ef; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 24px 20px 64px; }
h1 { font-size: 1.9em; margin-top: 0.4em; } h2 { margin-top: 2em; padding-top: 0.6em; border-top: 1px solid var(--line); } h3 { margin-top: 1.6em; }
a { color: var(--accent); } code { background: var(--soft); padding: 0 4px; border-radius: 4px; font-size: 0.92em; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 0.95em; }
th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; } th { background: var(--soft); }
blockquote { margin: 16px 0; padding: 4px 16px; border-left: 4px solid #e5484d; background: var(--soft); border-radius: 0 6px 6px 0; }
li { margin: 4px 0; }
</style></head><body><main>
${markdownToHtml(md)}
</main></body></html>`;
}
