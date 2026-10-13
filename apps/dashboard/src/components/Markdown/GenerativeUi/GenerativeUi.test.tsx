import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GenerativeUi, GenerativeUiHostContext, renderWithGenerativeUi } from './GenerativeUi';
import { UI_ICONS } from './genUiCore';

const lines = (...rows: unknown[]): string => rows.map(row => JSON.stringify(row)).join('\n');

function render(
  source: string,
  {
    open = false,
    streaming = false,
    host = true,
  }: { open?: boolean; streaming?: boolean; host?: boolean } = {},
): string {
  return renderToStaticMarkup(
    createElement(
      GenerativeUiHostContext.Provider,
      { value: host ? { send: () => true } : null },
      createElement(GenerativeUi, { source, open, streaming }),
    ),
  );
}

const sendButton = (html: string): string =>
  /<button[^>]*data-track-name="GEN_UI_SEND"[^>]*>/.exec(html)?.[0] ?? '';

describe('GenerativeUi', () => {
  it('draws every component without falling back', () => {
    const html = render(
      lines(
        { title: 'Everything', state: { seats: 12, price: 20, on: true } },
        { type: 'heading', text: 'Plans', level: 1 },
        { type: 'text', text: 'Pro is **best**.\n- one\n- two' },
        {
          type: 'row',
          children: [
            { type: 'badge', text: 'New', tone: 'accent' },
            { type: 'citation', label: 'Docs', href: 'https://example.com' },
          ],
        },
        {
          type: 'grid',
          cols: 2,
          children: [
            { type: 'card', title: 'A', children: [{ type: 'divider' }] },
            { type: 'card', title: 'B', tone: 'positive', children: [] },
          ],
        },
        {
          type: 'disclosure',
          title: 'More',
          children: [{ type: 'callout', text: 'Note', tone: 'warning' }],
        },
        {
          type: 'list',
          dividers: true,
          items: [
            'plain',
            {
              title: 'Rich',
              sub: 'sub',
              badge: { text: 'Hot' },
              media: { type: 'swatch', color: '#ff0000', label: 'Red' },
            },
          ],
        },
        {
          type: 'table',
          columns: ['Plan', 'Price'],
          rows: [
            ['Free', '$0'],
            ['Pro', 20],
          ],
        },
        {
          type: 'image',
          src: 'https://example.com/a.png',
          alt: 'A chart',
          ratio: '16/9',
          caption: 'Figure',
        },
        { type: 'swatch', color: '#00ff00', label: 'Green', size: 'xl' },
        { type: 'progress', value: 40, label: 'Half way' },
        {
          type: 'choice',
          name: 'plan',
          label: 'Plan',
          options: ['Free', 'Pro'],
          recommended: 'Pro',
        },
        { type: 'segmented', name: 'mode', options: ['Light', 'Dark'] },
        { type: 'slider', name: 'seats', label: 'Seats', min: 1, max: 50, unit: 'seats' },
        { type: 'input', name: 'email', label: 'Email', inputType: 'email', help: 'Work email' },
        { type: 'toggle', name: 'on', label: 'Notify me' },
        { type: 'text', text: 'Total {{ seats * price }}' },
        { type: 'button', text: 'Buy', kind: 'primary' },
      ),
    );
    expect(html).not.toContain('gui-fallback');
    expect(html).not.toContain('could not be displayed');
    for (const text of [
      'Everything',
      'Plans',
      '<strong>best</strong>',
      '<li>one</li>',
      'Docs',
      'Rich',
      'Free',
      'A chart',
      'Green',
      'Half way',
      'Recommended',
      'Light',
      '12 seats',
      'Work email',
      'Notify me',
      'Total 240',
      'Buy',
    ]) {
      expect(html).toContain(text);
    }
    expect(sendButton(html)).not.toContain('disabled');
  });

  it('skips a broken line, keeps the rest and says so', () => {
    const html = render(
      lines(
        { type: 'text', text: 'Kept' },
        { type: 'image', src: 'http://x.test/a.png', alt: 'Insecure' },
      ),
    );
    expect(html).toContain('Kept');
    expect(html).not.toContain('Insecure');
    expect(html).toContain('Part of this answer could not be displayed.');
  });

  it('keeps the rest of a card when one component inside it cannot be drawn', () => {
    const html = render(
      lines({
        type: 'card',
        title: 'Plan',
        children: [
          { type: 'stat', value: `{{ ${'1 + '.repeat(150)}1 }}`, label: 'Too long to compute' },
          { type: 'text', text: 'Still here' },
        ],
      }),
    );
    expect(html).not.toContain('gui-fallback');
    expect(html).toContain('Plan');
    expect(html).toContain('Still here');
    expect(html).not.toContain('Too long to compute');
    expect(html).toContain('Part of this answer could not be displayed.');
  });

  it('draws what an unknown component holds and ignores props it does not know', () => {
    const html = render(
      lines(
        { type: 'panel', children: [{ type: 'text', text: 'Inside a panel' }] },
        { type: 'chart', title: 'Signups by week' },
        { type: 'card', variant: 'outline', tone: 'loud', children: ['A plain string child'] },
      ),
    );
    expect(html).not.toContain('could not be');
    for (const text of ['Inside a panel', 'Signups by week', 'A plain string child']) {
      expect(html).toContain(text);
    }
  });

  it('shows a block that cannot be drawn at all as text, with its source one click away', () => {
    const html = render('{"type":"nonsense"}');
    expect(html).toContain('gui-fallback');
    expect(html).toContain('This part could not be drawn.');
    expect(html).toContain('<details class="gui-raw-details">');
    expect(html).toContain('{&quot;type&quot;:&quot;nonsense&quot;}');
    expect(html).not.toContain('as an interface');
  });

  it('draws the line being written as a draft and waits to send while streaming', () => {
    const source = `${lines({ type: 'button', text: 'Go' })}\n{"type":"callout","text":"Hal`;
    const html = render(source, { open: true, streaming: true });
    expect(html).toContain('gui-draft');
    expect(html).toContain('Hal');
    expect(sendButton(html)).toContain('disabled');
    expect(html).not.toContain('could not be displayed');
  });

  it('cannot send without a host', () => {
    expect(sendButton(render(lines({ type: 'button', text: 'Go' }), { host: false }))).toContain(
      'disabled',
    );
  });

  it('fills live values into table cells, headers and list badges', () => {
    const html = render(
      lines(
        { state: { seats: 3 } },
        { type: 'table', columns: ['Seats: {{ seats }}'], rows: [['{{ seats * 10 }}']] },
        { type: 'list', items: [{ title: 'Plan', badge: { text: '{{ seats }} left' } }] },
      ),
    );
    expect(html).toContain('Seats: 3');
    expect(html).toContain('30');
    expect(html).toContain('3 left');
  });

  it('draws the shorthand, multi-line shape a model writes without the format', () => {
    const html = render(
      [
        '{"state":{},"meta":{"title":"Ultramarine vs Phthalo"}}',
        '{"grid":{"cols":2,"children":[',
        '  {"card":{"title":"Ultramarine blue","children":[',
        '    {"row":{"children":[{"swatch":{"color":"#120a8f","label":"Ultramarine pure"}}]}},',
        '    {"list":[{"text":"Warm, leans red"}]}',
        '  ]}},',
        '  {"card":{"title":"Phthalo blue","children":[{"text":"Cool and strong"}]}}',
        ']}}',
      ].join('\n'),
    );
    expect(html).not.toContain('gui-fallback');
    expect(html).not.toContain('could not be displayed');
    for (const text of [
      'Ultramarine vs Phthalo',
      'Ultramarine pure',
      'Warm, leans red',
      'Phthalo blue',
    ]) {
      expect(html).toContain(text);
    }
  });

  it('draws stat tiles in a 4-column grid and a palette strip as list media', () => {
    const html = render(
      lines(
        { state: { open: 3 } },
        {
          type: 'grid',
          cols: 4,
          children: [
            { type: 'stat', value: 27, label: 'Channels' },
            {
              type: 'stat',
              value: '{{ open }}',
              label: 'Open tickets',
              note: 'All test data',
              tone: 'warning',
            },
          ],
        },
        {
          type: 'list',
          items: [
            {
              title: 'Complementary',
              media: [
                { type: 'swatch', color: '#2563eb', label: 'Blue' },
                { type: 'swatch', color: '#f97316', label: 'Orange' },
              ],
            },
          ],
        },
      ),
    );
    expect(html).not.toContain('could not be displayed');
    expect(html).toContain('data-cols="4"');
    expect(html).toContain('<div class="gui-stat-value">27</div>');
    expect(html).toContain('<div class="gui-stat-value">3</div>');
    expect(html).toContain('All test data');
    expect(html).toContain('gui-palette');
    expect(html).toContain('aria-label="Orange"');
  });

  it('looks a picture up by its query through the host, and leaves it out when it cannot', () => {
    const source = lines({ type: 'image', query: 'Palolem beach Goa', alt: 'Palolem beach' });
    const looking = renderToStaticMarkup(
      createElement(
        GenerativeUiHostContext.Provider,
        { value: { send: () => true, findImage: () => new Promise(() => {}) } },
        createElement(GenerativeUi, { source, open: false, streaming: false }),
      ),
    );
    expect(looking).toContain('data-state="loading"');
    expect(looking).not.toContain('<img');
    const noLookup = render(source);
    expect(noLookup).not.toContain('gui-image');
    expect(noLookup).not.toContain('could not be');
  });

  it('draws every catalog icon', () => {
    const html = render(
      lines({ type: 'row', children: UI_ICONS.map(name => ({ type: 'icon', name })) }),
    );
    expect(html.match(/<svg/g)?.length).toBe(UI_ICONS.length);
    expect(
      render(
        lines({
          type: 'row',
          children: [
            { type: 'icon', name: 'constructor' },
            { type: 'text', text: 'Kept' },
          ],
        }),
      ),
    ).not.toContain('<svg');
  });

  it('draws a card header with an icon, a sub line and a badge or a live aside', () => {
    const html = render(
      lines(
        { state: { done: 2 } },
        {
          type: 'card',
          title: 'Weekly overview',
          sub: 'Oct 19-25',
          icon: 'calendar',
          badge: { text: 'Week 43', tone: 'accent' },
          children: [{ type: 'stat', value: 12, label: 'Meetings', note: '2 fewer' }],
        },
        {
          type: 'card',
          title: 'My tasks',
          aside: '{{ done }} of 6 completed',
          children: [{ type: 'text', text: 'x' }],
        },
      ),
    );
    expect(html).toContain('class="gui-card-head"');
    expect(html).toContain('Oct 19-25');
    expect(html).toMatch(/<span class="gui-badge" data-tone="accent">Week 43<\/span>/);
    expect(html).toContain('2 of 6 completed');
    // A stat reads label first, like a dashboard tile.
    expect(html.indexOf('Meetings')).toBeLessThan(html.indexOf('>12<'));
  });

  it('draws a checklist ticked from its done rows, struck through, with a live count', () => {
    const html = render(
      lines({
        type: 'card',
        title: 'My tasks',
        aside: '{{ len(done) }} of 3 completed',
        children: [
          {
            type: 'list',
            check: 'done',
            items: [
              { id: 't1', title: 'Ship notes', done: true, badge: { text: 'P0', tone: 'danger' } },
              {
                title: 'Review API',
                done: true,
                facts: [{ icon: 'calendar', text: 'Wed, Oct 21' }, '2h'],
              },
              { title: 'Plan sprint' },
            ],
          },
        ],
      }),
    );
    expect(html).toContain('2 of 3 completed');
    expect(html.match(/data-done="true"/g)).toHaveLength(2);
    expect(html.match(/<input type="checkbox"[^>]*checked=""/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Plan sprint"');
    expect(html).toContain('data-track-name="GEN_UI_CHECK"');
    expect(html).toMatch(/<span class="gui-fact"><span class="gui-icon"[^>]*><svg[^]*?Wed, Oct 21/);
    // The badge sits after the row body, on the right.
    expect(html).toMatch(/<\/div><span class="gui-badge" data-tone="danger">P0<\/span><\/li>/);
  });

  it('draws numbered steps with meta lines and tinted icon tiles', () => {
    const html = render(
      lines({
        type: 'list',
        numbered: true,
        items: [
          {
            title: 'Inbox zero',
            meta: '9:00 - 9:30',
            media: { type: 'icon', name: 'inbox', tone: 'accent' },
          },
          {
            title: 'Design review',
            meta: '10:00 - 11:00',
            media: { type: 'icon', name: 'no-such-icon' },
          },
        ],
      }),
    );
    expect(html).toContain('<ol class="gui-list"');
    expect(html).toMatch(
      /<span class="gui-step">1<\/span><span class="gui-icon-tile" data-tone="accent">/,
    );
    expect(html).toMatch(/<span class="gui-step">2<\/span><div class="gui-list-body">/);
    expect(html).toContain('<div class="gui-list-meta">10:00 - 11:00</div>');
  });

  it('draws a timeline one row per day, tinted by tone, and says when a day is free', () => {
    const html = render(
      lines({
        type: 'timeline',
        groups: [
          {
            label: 'Mon',
            value: '19',
            items: [
              { time: '10:00 - 11:00', title: 'Design review', sub: 'Room 4', tone: 'accent' },
            ],
          },
          { label: 'Tue', value: '20', items: [] },
        ],
      }),
    );
    expect(html).toContain(
      '<span class="gui-tl-day-label">Mon</span><span class="gui-tl-day-value">19</span>',
    );
    expect(html).toMatch(
      /<li class="gui-tl-item" data-tone="accent"><span class="gui-tl-time">10:00 - 11:00<\/span>/,
    );
    expect(html).toContain('Nothing scheduled');
  });

  it('draws a select named after its card, a progress note and a full-width button', () => {
    const html = render(
      lines(
        {
          type: 'card',
          title: 'Fix login loop',
          children: [{ type: 'select', name: 's1', options: ['To do', 'Done'], value: 'Done' }],
        },
        { type: 'select', name: 's2', label: 'Owner', options: ['Asha', 'Ravi'] },
        {
          type: 'progress',
          label: 'Focus hours',
          value: 80,
          note: '28 of 35 hours · 80%',
          tone: 'positive',
        },
        { type: 'button', text: 'Send the update', kind: 'primary', full: true },
      ),
    );
    expect(html).toContain('aria-label="Fix login loop"');
    expect(html).toMatch(/<option value="Done" selected="">Done<\/option>/);
    expect(html).toMatch(/<option value="" disabled="" selected="">Choose…<\/option>/);
    expect(html).toContain('28 of 35 hours · 80%');
    expect(html).not.toContain('>80%<');
    expect(html).toContain('<div class="gui-progress" data-tone="positive">');
    expect(sendButton(html)).toContain('data-full="true"');
  });

  it('hides components whose show condition is false', () => {
    const html = render(
      lines(
        { state: { n: 1 } },
        { type: 'text', text: 'Shown', show: 'n > 0' },
        { type: 'text', text: 'Hidden', show: 'n > 5' },
      ),
    );
    expect(html).toContain('Shown');
    expect(html).not.toContain('Hidden');
  });

  it('never draws unsafe links or images and drops chat citation tokens', () => {
    const html = render(
      lines({
        type: 'text',
        text: '[bad](javascript:alert(1)) and [ok](https://example.com) fact [clf-abc#2]',
      }),
    );
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('clf-abc');
  });
});

describe('renderWithGenerativeUi', () => {
  const md = (text: string): ReactNode => createElement('p', { 'data-md': '' }, text);

  it('passes plain replies straight to the markdown renderer', () => {
    expect(
      renderToStaticMarkup(createElement('div', null, renderWithGenerativeUi('Hello', false, md))),
    ).toBe('<div><p data-md="">Hello</p></div>');
  });

  it('renders markdown around a ui block', () => {
    const reply = `Intro\n\n\`\`\`ui\n${lines({ type: 'text', text: 'Inside' })}\n\`\`\`\n\nOutro`;
    const html = renderToStaticMarkup(
      createElement('div', null, renderWithGenerativeUi(reply, false, md)),
    );
    expect(html.indexOf('Intro')).toBeLessThan(html.indexOf('Inside'));
    expect(html.indexOf('Inside')).toBeLessThan(html.indexOf('Outro'));
    expect(html).toContain('class="gui not-prose"');
  });

  it('draws a block title only when no heading right above already titles the block', () => {
    const block = `\`\`\`ui\n${lines({ title: 'Harmonies' }, { type: 'text', text: 'Inside' })}\n\`\`\``;
    const draw = (reply: string): string =>
      renderToStaticMarkup(createElement('div', null, renderWithGenerativeUi(reply, false, md)));
    expect(draw(`Intro\n\n${block}`)).toContain('<div class="gui-title">Harmonies</div>');
    const headed = draw(`## Classic harmonies\n\n${block}`);
    expect(headed).not.toContain('class="gui-title"');
    expect(headed).toContain('aria-label="Harmonies"');
    expect(draw(`**Classic harmonies**\n\n${block}`)).not.toContain('class="gui-title"');
  });
});
