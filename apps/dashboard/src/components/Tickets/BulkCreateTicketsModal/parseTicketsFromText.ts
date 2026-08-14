/**
 * Parse a composer draft into tickets, one per list item, nested items
 * becoming sub-tickets of the item they sit under.
 *
 * Only a numbered list makes a draft several tickets: the list starts at a
 * numbered item ("1. …" or "1) …"), and its top-level items are numbered
 * consecutively. Multi-line or multi-paragraph prose is one ticket, so this
 * returns [] for it, as it does for a list of fewer than two items.
 *
 * Under a top-level item, any common marker starts an item: "a.", "a1.",
 * "i.", "-", "*", or a number. How deep an item sits comes from its
 * indentation; where lines are not indented, from its marker — a marker style
 * not seen yet steps one level in, and one used by an outer level steps back
 * out to it:
 *
 *   1. Parent            1. Parent
 *     a. Child           a. Child
 *       a1. Grandchild   a1. Grandchild
 *   2. Parent            2. Parent
 *
 * Lines that are not items belong to the item above them as its description.
 * Text before the list is not a ticket and is left out.
 */
export interface ParsedTicketDraft {
  title: string;
  description: string;
  /** Index of the draft this one is a sub-ticket of, or null at the top level. */
  parentIndex: number | null;
  /** 0 at the top level, 1 for its sub-tickets, and so on. */
  depth: number;
}

type MarkerStyle = 'number' | 'letter' | 'alnum' | 'roman' | 'bullet';

// A number may run straight into its text ("1.Title"); other markers need a space,
// so prose like "e.g. this" is not read as an item.
const ITEM =
  /^(\s*)(?:(\d+)[.)](?!\d)\s*|([a-z])[.)]\s+|([a-z]\d+)[.)]\s+|([ivxlc]{2,})[.)]\s+|([-*•])\s+)(\S.*)$/i;

interface Level {
  indent: number;
  style: MarkerStyle;
  /** The item open at this level, and the marker it was written with. */
  index: number;
  marker: string;
}

export function parseTicketsFromText(text: string): ParsedTicketDraft[] {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n');

  const items: Array<{ title: string; body: string[]; parentIndex: number | null; depth: number }> =
    [];
  const levels: Level[] = [];
  let nextTopNumber = 0;

  for (const line of lines) {
    const match = ITEM.exec(line);
    if (!match) {
      items[items.length - 1]?.body.push(line);
      continue;
    }
    const indent = match[1]!.length;
    const title = match[7]!.trim();
    const top = levels[levels.length - 1];
    let style: MarkerStyle = match[2]
      ? 'number'
      : match[3]
        ? 'letter'
        : match[4]
          ? 'alnum'
          : match[5]
            ? 'roman'
            : 'bullet';
    // A lone i/v/x/… continues a roman list rather than starting a letter one.
    if (style === 'letter' && /^[ivxlc]$/i.test(match[3]!) && top?.style === 'roman')
      style = 'roman';
    const marker = (match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? '').toLowerCase();

    // Nothing open yet: only a numbered item starts the list.
    if (!top) {
      if (style !== 'number') continue;
      items.push({ title, body: [], parentIndex: null, depth: 0 });
      levels.push({ indent, style, index: items.length - 1, marker });
      nextTopNumber = Number(match[2]) + 1;
      continue;
    }

    // Close levels indented deeper than this item.
    while (levels.length > 1 && indent < levels[levels.length - 1]!.indent) levels.pop();
    let open = levels[levels.length - 1]!;
    // "i." alone looks like a letter; an "ii." after it shows the level was roman.
    if (
      style === 'roman' &&
      open.style === 'letter' &&
      open.marker === 'i' &&
      indent === open.indent
    ) {
      open.style = 'roman';
    }

    let asChild: boolean;
    if (indent > open.indent) {
      asChild = true;
    } else if (style === open.style) {
      asChild = false;
    } else {
      // Same indentation, another marker: back out to the level that uses it, else step in.
      let outer = -1;
      for (let i = levels.length - 2; i >= 0; i--) {
        if (levels[i]!.style === style && levels[i]!.indent === indent) {
          outer = i;
          break;
        }
      }
      if (outer >= 0) {
        levels.length = outer + 1;
        open = levels[outer]!;
        asChild = false;
      } else {
        asChild = true;
      }
    }

    // Top-level items stay consecutively numbered; anything else at that level is
    // ordinary text, as a stray "3." inside a description would be.
    if (!asChild && levels.length === 1) {
      if (style !== 'number' || Number(match[2]) !== nextTopNumber) {
        items[items.length - 1]!.body.push(line);
        continue;
      }
      nextTopNumber += 1;
    }

    if (asChild) {
      items.push({ title, body: [], parentIndex: open.index, depth: levels.length });
      levels.push({ indent, style, index: items.length - 1, marker });
    } else {
      const parent = levels[levels.length - 2];
      items.push({ title, body: [], parentIndex: parent?.index ?? null, depth: levels.length - 1 });
      levels[levels.length - 1] = { indent, style, index: items.length - 1, marker };
    }
  }

  if (items.length < 2) return [];

  return items.map(item => ({
    title: item.title,
    description: item.body
      .map(line => line.trim())
      .filter(Boolean)
      .join('\n'),
    parentIndex: item.parentIndex,
    depth: item.depth,
  }));
}
