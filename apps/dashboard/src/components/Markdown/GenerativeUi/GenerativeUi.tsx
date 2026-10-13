/**
 * Live renderer for the ```ui blocks agents write in chat replies. The format,
 * the component catalog and every rule live in genUiCore.ts.
 *
 * Shared verbatim with claw v3
 * (apps/xyne-claw-auth/frontend/src/v3/components/genui/GenerativeUi.tsx),
 * which cannot import from this app. Edit this copy, then run
 * `pnpm --filter xyne-claw-shared sync:gen-ui`.
 *
 * Styling is plain CSS scoped under .gui and driven by --gui-* custom
 * properties that each app maps to its own theme tokens, so a block looks the
 * same under either app's Tailwind and follows dark mode. Icons come from each
 * app's own icon set (the "Icon set" section below).
 */
import {
  Component,
  Fragment,
  createContext,
  memo,
  useContext,
  useEffect,
  useId,
  useInsertionEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  UI_CATALOG,
  buildUiSendMessage,
  declaredNames,
  display,
  drawableUiLine,
  initialUiState,
  interpolate,
  isSafeColor,
  isSafeUrl,
  isShown,
  listItemKey,
  parseUiBlock,
  splitUiFences,
  uiBlockAsText,
  uiSendFields,
  type UiImageHit,
  type UiNode,
} from './genUiCore';

// ── Icon set ────────────────────────────────────────────────────────────────
// Each chat draws the catalog's icon names (UI_ICONS in genUiCore.ts) with its
// own icon set: the dashboard with the Xyne icons (@xyne/icons), claw v3 with
// lucide. sync:gen-ui copies the rest of this file to claw v3 and keeps each
// copy's own version of this section.
import * as XyneIcons from '@xyne/icons';

const ICONS = new Map<string, typeof XyneIcons.CalendarDefault>([
  ['check', XyneIcons.CheckTickSingle],
  ['check-circle', XyneIcons.CheckTickCircle],
  ['x-circle', XyneIcons.MultipleCrossCancelCircle],
  ['alert-triangle', XyneIcons.AlertTriangle],
  ['alert-circle', XyneIcons.AlertCircle],
  ['info', XyneIcons.InformationCircle],
  ['clock', XyneIcons.ClockDefault],
  ['calendar', XyneIcons.CalendarDefault],
  ['timer', XyneIcons.TimerDefault],
  ['hourglass', XyneIcons.Hourglass],
  ['target', XyneIcons.FocusTarget],
  ['flag', XyneIcons.Flag],
  ['lightbulb', XyneIcons.BulbDefault],
  ['sparkles', XyneIcons.SparkleAi01],
  ['shield', XyneIcons.Shield],
  ['lock', XyneIcons.LockClose],
  ['key', XyneIcons.KeySlant],
  ['star', XyneIcons.Star],
  ['heart', XyneIcons.Heart],
  ['thumbs-up', XyneIcons.ThumbReactionLike],
  ['award', XyneIcons.AwardMedal],
  ['trophy', XyneIcons.Trophy],
  ['zap', XyneIcons.LightningThunderElectricOn],
  ['rocket', XyneIcons.RocketShip],
  ['bug', XyneIcons.Bug],
  ['wrench', XyneIcons.Tools],
  ['settings', XyneIcons.Settings01],
  ['code', XyneIcons.Code],
  ['database', XyneIcons.Database],
  ['server', XyneIcons.Server],
  ['layers', XyneIcons.LayerThree],
  ['layout-grid', XyneIcons.GridDashboard01],
  ['kanban', XyneIcons.KanbanBoard],
  ['list-checks', XyneIcons.ListCheck],
  ['chart', XyneIcons.BarchartDefault],
  ['pie-chart', XyneIcons.Piechart01],
  ['trending-up', XyneIcons.GraphTrendLineUpward],
  ['trending-down', XyneIcons.GraphTrendLineDownward],
  ['activity', XyneIcons.Activity],
  ['user', XyneIcons.UserDefault],
  ['users', XyneIcons.UserTwo],
  ['bot', XyneIcons.UserBot],
  ['message', XyneIcons.ChatDefault],
  ['mail', XyneIcons.EnvelopeDefault],
  ['bell', XyneIcons.NotificationBellOn],
  ['megaphone', XyneIcons.MegaphoneAnnouncementShout],
  ['phone', XyneIcons.PhoneDefault],
  ['video', XyneIcons.VideoCallDefault],
  ['hash', XyneIcons.Hashtag],
  ['ticket', XyneIcons.TicketToken],
  ['git-pull-request', XyneIcons.GitPullRequest],
  ['file', XyneIcons.FileDefault],
  ['folder', XyneIcons.FolderDefault],
  ['inbox', XyneIcons.InboxDefault],
  ['tag', XyneIcons.Tag],
  ['link', XyneIcons.LinkHorizontal],
  ['search', XyneIcons.SearchDefault],
  ['globe', XyneIcons.Globe],
  ['map-pin', XyneIcons.MapPin],
  ['home', XyneIcons.HomeDefault],
  ['building', XyneIcons.BuildingApartmentOne],
  ['briefcase', XyneIcons.BriefcaseJob],
  ['dollar', XyneIcons.CurrencySignDollar],
  ['wallet', XyneIcons.WalletDefault],
  ['credit-card', XyneIcons.CreditCard],
  ['shopping-cart', XyneIcons.ShoppingCart],
  ['package', XyneIcons.Package01],
  ['gift', XyneIcons.GiftDefault],
  ['travel', XyneIcons.LuggageTrolley],
  ['car', XyneIcons.CarFrontView],
  ['utensils', XyneIcons.ForkKnife],
  ['coffee', XyneIcons.CoffeeCup01],
  ['sun', XyneIcons.Sun],
  ['moon', XyneIcons.Moon],
  ['camera', XyneIcons.Camera],
  ['palette', XyneIcons.ColorPalette],
  ['book', XyneIcons.Notebook],
  ['graduation-cap', XyneIcons.GraduationHat],
  ['monitor', XyneIcons.Monitor01],
  ['smartphone', XyneIcons.Iphone],
  ['eye', XyneIcons.EyeOn],
  ['pen', XyneIcons.PencilEdit],
  ['refresh', XyneIcons.Refresh],
  ['arrow-right', XyneIcons.ArrowRight],
  ['play', XyneIcons.PlayCircle],
  ['circle-dot', XyneIcons.CircleDot],
  ['chevron-down', XyneIcons.ChevronDown],
]);
// ── End of icon set ─────────────────────────────────────────────────────────

/** What a chat gives its blocks so a button can reply. */
export interface GenerativeUiHost {
  /** Post `text` as a normal, visible user message. False when the chat cannot send right now. */
  send: (text: string) => boolean;
  /** Find a picture for an image written with a `query` (claw-auth GET /genui/image).
   *  Without it, such images are left out. */
  findImage?: (query: string) => Promise<UiImageHit | null>;
}

/** Provided by a chat that renders ```ui blocks. Without it a block still renders but cannot send. */
export const GenerativeUiHostContext = createContext<GenerativeUiHost | null>(null);

export interface GenerativeUiProps {
  /** The text inside the fence. */
  source: string;
  /** The closing fence has not arrived yet. */
  open: boolean;
  /** This text is still streaming: the block's last line may be a draft. */
  streaming: boolean;
  /** The turn is still running, even when this text part is done. Sending waits
   *  until it ends. Defaults to `streaming`. */
  busy?: boolean;
  /** Draw the block's own title. False when the section it sits in already has
   *  a heading; the title then only names the block for screen readers. */
  titled?: boolean;
}

/**
 * The text between the previous block and this one already titles this block:
 * it holds a markdown heading, or ends in a bold line used as one. A second,
 * smaller title right under it would only repeat it.
 */
function titlesNextBlock(markdown: string): boolean {
  const lines = markdown.trimEnd().split('\n');
  const last = lines[lines.length - 1]?.trim() ?? '';
  return lines.some(line => /^#{1,6}\s+\S/.test(line.trim())) || /^\*\*[^*]+\*\*:?$/.test(last);
}

/**
 * Render a reply that may contain ```ui fences: markdown segments go through
 * the host's own renderer, ui segments become live blocks. Always a keyed list,
 * even for plain text, so the first fence arriving mid-stream appends a sibling
 * instead of remounting (and re-animating) the text already on screen.
 * Segments only ever append while a reply streams, so index keys stay stable.
 */
export function renderWithGenerativeUi(
  text: string,
  streaming: boolean,
  renderMarkdown: (markdown: string) => ReactNode,
  { busy = streaming }: { busy?: boolean } = {},
): ReactNode[] {
  const segments = splitUiFences(text, { streaming });
  return segments.map((segment, index) => {
    if (segment.kind === 'markdown') {
      return <Fragment key={index}>{renderMarkdown(segment.text)}</Fragment>;
    }
    const before = segments[index - 1];
    return (
      <GenerativeUi
        key={index}
        source={segment.text}
        open={!segment.closed}
        streaming={streaming}
        busy={busy}
        titled={!(before?.kind === 'markdown' && titlesNextBlock(before.text))}
      />
    );
  });
}

export const GenerativeUi = memo(function GenerativeUi(props: GenerativeUiProps): ReactElement {
  useGenerativeUiStyles();
  return (
    <GenerativeUiBoundary source={props.source}>
      <UiBlock {...props} />
    </GenerativeUiBoundary>
  );
});

// ── Block ───────────────────────────────────────────────────────────────────

type Scope = Record<string, unknown>;

interface RenderContext {
  scope: Scope;
  uid: string;
  /** Inputs are read-only: the block was sent. */
  locked: boolean;
  /** A send button may post now. */
  canSend: boolean;
  setValue: (name: string, value: unknown) => void;
  press: (button: UiNode) => void;
}

function UiBlock({
  source,
  open,
  streaming,
  busy = streaming,
  titled = true,
}: GenerativeUiProps): ReactElement {
  const host = useContext(GenerativeUiHostContext);
  const uid = useId();
  const live = open && streaming;
  const parsed = useMemo(() => parseUiBlock(source, { streaming: live }), [source, live]);
  // Each line keeps whatever of it can be drawn: one bad component no longer
  // takes its whole card with it.
  const { blocks, dropped } = useMemo(() => {
    const declared = declaredNames(parsed);
    const lines = parsed.blocks.map(b => ({
      key: b.key,
      drawable: drawableUiLine(b.node, `line ${b.line}`, declared),
    }));
    return {
      blocks: lines.flatMap(({ key, drawable }) =>
        drawable.node ? [{ key, node: drawable.node }] : [],
      ),
      dropped: lines.reduce(
        (n, { drawable }) => n + (drawable.node ? drawable.dropped : Math.max(1, drawable.dropped)),
        0,
      ),
    };
  }, [parsed]);
  const initial = useMemo(() => initialUiState(parsed), [parsed]);
  const [edits, setEdits] = useState<Scope>({});
  const [sent, setSent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const scope = useMemo(() => ({ ...initial, ...edits }), [initial, edits]);

  const failed = parsed.badLines.length + dropped;
  const ctx: RenderContext = {
    scope,
    uid,
    locked: sent,
    canSend: !!host && !busy && !sent,
    setValue: (name, value) => {
      if (UNSAFE_NAMES.has(name)) return;
      setEdits(prev => ({ ...prev, [name]: value }));
    },
    press: button => {
      const action = button['do'] ?? 'send';
      if (action === 'reset') {
        setEdits({});
        setNotice(null);
        return;
      }
      if (isRecord(action)) {
        const set = action['set'];
        if (!isRecord(set)) return;
        const next: Scope = {};
        // A value may be an expression ("{{ qty + 1 }}"), read against the state
        // at the moment of the click.
        for (const [key, value] of Object.entries(set)) {
          if (!UNSAFE_NAMES.has(key) && (value === null || typeof value !== 'object')) {
            next[key] = interpolate(value, scope);
          }
        }
        setEdits(prev => ({ ...prev, ...next }));
        return;
      }
      if (!host || busy || sent) return;
      const label = display(interpolate(button['text'], scope)) || 'Send';
      const message = buildUiSendMessage(
        label,
        uiSendFields(
          blocks.map(b => b.node),
          scope,
        ),
      );
      if (host.send(message)) {
        setSent(true);
        setNotice(null);
      } else {
        setNotice('The chat is busy. Try again when the current reply has finished.');
      }
    },
  };

  if (!live && blocks.length === 0) {
    return <RawFallback source={source} />;
  }

  return (
    <section
      className='gui not-prose'
      aria-label={parsed.meta.title ?? 'Interactive answer'}
      aria-busy={live || undefined}
    >
      {titled && parsed.meta.title && <div className='gui-title'>{parsed.meta.title}</div>}
      {blocks.map(b => (
        <LineBoundary key={b.key}>
          <UiNodeView node={b.node} ctx={ctx} path={b.key} />
        </LineBoundary>
      ))}
      {live && parsed.draft && (
        <div key={parsed.draftLine} className='gui-draft'>
          <UiNodeView
            node={parsed.draft}
            ctx={{ ...ctx, locked: true, canSend: false }}
            path='draft'
            draft
          />
        </div>
      )}
      {live && !parsed.draft && blocks.length === 0 && <Skeleton lines={2} />}
      {!live && failed > 0 && (
        <p className='gui-note' role='status'>
          Part of this answer could not be displayed.
        </p>
      )}
      {notice && (
        <p className='gui-note' role='status'>
          {notice}
        </p>
      )}
      {sent && (
        <p className='gui-note gui-note-sent' role='status'>
          Sent as your reply.
        </p>
      )}
    </section>
  );
}

// ── Components ──────────────────────────────────────────────────────────────

interface NodeProps {
  node: UiNode;
  ctx: RenderContext;
  path: string;
  draft?: boolean;
  /** Title of the card this component sits in: names an input that has no label of its own. */
  within?: string | undefined;
}

function UiNodeView({ node, ctx, path, draft = false, within }: NodeProps): ReactElement | null {
  if (!isRecord(node) || !isShown(node, ctx.scope)) return null;
  const def = typeof node.type === 'string' ? UI_CATALOG[node.type] : undefined;
  if (!def) return draft ? <Skeleton lines={1} /> : null;
  if (draft && (def.required ?? []).some(prop => node[prop] === undefined)) {
    return <Skeleton lines={node.type === 'table' || node.type === 'image' ? 3 : 1} />;
  }
  const text = (prop: string): string => display(interpolate(node[prop], ctx.scope));
  const tone = (prop = 'tone'): string | undefined => {
    const value = node[prop];
    return typeof value === 'string' ? value : undefined;
  };
  const kids = (inside = within): ReactNode =>
    Array.isArray(node['children'])
      ? (node['children'] as unknown[]).map((child, i) => (
          <UiNodeView
            key={i}
            node={child as UiNode}
            ctx={ctx}
            path={`${path}.${i}`}
            draft={draft}
            within={inside}
          />
        ))
      : null;

  switch (node.type) {
    case 'stack':
      return (
        <div className='gui-stack' data-gap={tone('gap')} data-align={tone('align')}>
          {kids()}
        </div>
      );
    case 'row':
      return (
        <div
          className='gui-row'
          data-gap={tone('gap')}
          data-align={tone('align')}
          data-nowrap={node['wrap'] === false || undefined}
        >
          {kids()}
        </div>
      );
    case 'grid': {
      const cols = node['cols'] === 3 || node['cols'] === 4 ? node['cols'] : 2;
      return (
        <div
          className='gui-grid'
          data-gap={tone('gap')}
          data-cols={cols}
          style={cssVars({ '--gui-cols': cols })}
        >
          {kids()}
        </div>
      );
    }
    case 'card': {
      const titled = node['title'] !== undefined;
      const badge = node['badge'];
      const aside =
        isRecord(badge) && typeof badge['text'] === 'string' ? (
          <ItemBadge badge={badge} ctx={ctx} />
        ) : node['aside'] !== undefined ? (
          <div className='gui-card-aside'>{text('aside')}</div>
        ) : null;
      return (
        <div className='gui-card' data-tone={tone()}>
          {(titled || node['sub'] !== undefined || aside) && (
            <div className='gui-card-head'>
              <div className='gui-card-heading'>
                {titled && (
                  <div className='gui-card-title'>
                    <IconView name={node['icon']} tone={tone()} />
                    <span>{text('title')}</span>
                  </div>
                )}
                {node['sub'] !== undefined && <div className='gui-card-sub'>{text('sub')}</div>}
              </div>
              {aside}
            </div>
          )}
          {kids(titled ? text('title') : within)}
        </div>
      );
    }
    case 'disclosure':
      return (
        <details className='gui-disclosure' open={node['open'] === true || undefined}>
          <summary>{text('title')}</summary>
          <div className='gui-stack'>{kids()}</div>
        </details>
      );
    case 'heading': {
      const level = typeof node['level'] === 'number' ? node['level'] : 2;
      const Tag = (['h3', 'h4', 'h5', 'h6'] as const)[Math.min(4, Math.max(1, level)) - 1] ?? 'h4';
      return (
        <Tag className='gui-heading' data-level={level}>
          {text('text')}
        </Tag>
      );
    }
    case 'text':
      return (
        <div className='gui-text' data-tone={tone()} data-size={tone('size')}>
          <RichText text={text('text')} />
        </div>
      );
    case 'list':
      return <ListView node={node} ctx={ctx} path={path} draft={draft} />;
    case 'badge':
      return (
        <span className='gui-badge' data-tone={tone()}>
          {text('text')}
        </span>
      );
    case 'stat':
      return (
        <div className='gui-stat' data-tone={tone()}>
          <div className='gui-stat-label'>{text('label')}</div>
          <div className='gui-stat-value'>{text('value')}</div>
          {node['note'] !== undefined && <div className='gui-stat-note'>{text('note')}</div>}
        </div>
      );
    case 'image':
      return (
        <ImageView
          src={node['src']}
          query={node['query']}
          alt={text('alt')}
          ratio={tone('ratio')}
          caption={text('caption')}
          draft={draft}
        />
      );
    case 'swatch':
      return <SwatchView node={node} ctx={ctx} labelled />;
    case 'table':
      return <TableView node={node} ctx={ctx} />;
    case 'callout':
      return (
        <div className='gui-callout' data-tone={tone()} role='note'>
          <IconView name={node['icon']} tone={tone()} />
          <div className='gui-callout-body'>
            {node['title'] !== undefined && (
              <div className='gui-callout-title'>{text('title')}</div>
            )}
            <RichText text={text('text')} />
          </div>
        </div>
      );
    case 'progress': {
      const raw = interpolate(node['value'], ctx.scope);
      const value =
        typeof raw === 'number' && Number.isFinite(raw) ? clamp(raw, 0, 100) : undefined;
      const label = text('label');
      const note = node['note'] !== undefined ? text('note') : '';
      return (
        <div className='gui-progress' data-tone={tone()}>
          <div className='gui-progress-head'>
            <span>{label}</span>
            {note ? (
              <span className='gui-muted'>{note}</span>
            ) : (
              value !== undefined && <span className='gui-muted'>{Math.round(value)}%</span>
            )}
          </div>
          <div
            className='gui-progress-bar'
            role='progressbar'
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={value}
            aria-valuetext={note || undefined}
          >
            <div
              className='gui-progress-fill'
              data-indeterminate={value === undefined || undefined}
              style={value === undefined ? undefined : { width: `${value}%` }}
            />
          </div>
        </div>
      );
    }
    case 'icon':
      return (
        <IconView name={node['name']} tone={tone()} size={tone('size')} label={text('label')} />
      );
    case 'timeline':
      return <TimelineView node={node} ctx={ctx} path={path} draft={draft} />;
    case 'divider':
      return <hr className='gui-divider' />;
    case 'citation':
      return <CitationView node={node} ctx={ctx} />;
    case 'choice':
      return <ChoiceView node={node} ctx={ctx} path={path} draft={draft} />;
    case 'segmented':
      return <SegmentedView node={node} ctx={ctx} path={path} draft={draft} />;
    case 'select':
      return <SelectView node={node} ctx={ctx} path={path} draft={draft} within={within} />;
    case 'slider':
      return <SliderView node={node} ctx={ctx} path={path} draft={draft} />;
    case 'input':
      return <InputView node={node} ctx={ctx} path={path} draft={draft} />;
    case 'toggle':
      return <ToggleView node={node} ctx={ctx} path={path} draft={draft} />;
    case 'button':
      return <ButtonView node={node} ctx={ctx} path={path} draft={draft} />;
    default:
      return null;
  }
}

function ListView({ node, ctx, path, draft = false }: NodeProps): ReactElement {
  const items = Array.isArray(node['items']) ? (node['items'] as unknown[]) : [];
  const check =
    typeof node['check'] === 'string' && !UNSAFE_NAMES.has(node['check']) ? node['check'] : null;
  const current = check ? ctx.scope[check] : undefined;
  const ticked = new Set(Array.isArray(current) ? current.map(display) : []);
  const numbered = node['numbered'] === true;
  const label = display(interpolate(node['label'], ctx.scope));
  const labelId = `${ctx.uid}-${path}-label`;
  const tick = (key: string, on: boolean): void => {
    if (!check) return;
    const next = new Set(ticked);
    if (on) next.add(key);
    else next.delete(key);
    // Keep the rows' own order so the state reads the way the list does.
    ctx.setValue(
      check,
      items.map(listItemKey).filter(k => next.has(k)),
    );
  };
  const Tag = numbered ? 'ol' : 'ul';
  const list = (
    <Tag
      className='gui-list'
      data-dividers={node['dividers'] === true || undefined}
      aria-labelledby={label ? labelId : undefined}
    >
      {items.map((raw, i) => {
        const item: Record<string, unknown> =
          typeof raw === 'string' ? { title: raw } : isRecord(raw) ? raw : {};
        const media = item['media'];
        const facts = Array.isArray(item['facts']) ? (item['facts'] as unknown[]).slice(0, 6) : [];
        const read = (key: string): string => display(interpolate(item[key], ctx.scope));
        const key = listItemKey(raw);
        const done = check !== null && ticked.has(key);
        return (
          <li key={i} className='gui-list-item' data-done={done || undefined}>
            {check && (
              <label className='gui-check'>
                <input
                  type='checkbox'
                  checked={done}
                  disabled={draft || ctx.locked}
                  aria-label={read('title')}
                  onChange={event => tick(key, event.target.checked)}
                  data-track-category='GenerativeUi'
                  data-track-name='GEN_UI_CHECK'
                />
                <span className='gui-check-box' aria-hidden>
                  <Glyph name='check' strokeWidth={3} />
                </span>
              </label>
            )}
            {numbered && <span className='gui-step'>{i + 1}</span>}
            {isRecord(media) && media['type'] === 'icon' && ICONS.has(display(media['name'])) && (
              <span
                className='gui-icon-tile'
                data-tone={typeof media['tone'] === 'string' ? media['tone'] : undefined}
              >
                <IconView name={media['name']} />
              </span>
            )}
            {isRecord(media) && media['type'] === 'image' && (
              <div className='gui-list-media'>
                <ImageView
                  src={media['src']}
                  query={media['query']}
                  alt={display(media['alt'])}
                  ratio='1/1'
                  thumb
                  draft={draft}
                />
              </div>
            )}
            {isRecord(media) && media['type'] === 'swatch' && (
              <div className='gui-list-media'>
                <SwatchView node={media as UiNode} ctx={ctx} />
              </div>
            )}
            {Array.isArray(media) && media.length > 0 && (
              <div className='gui-list-media gui-palette'>
                {media
                  .slice(0, 6)
                  .map((m, j) =>
                    isRecord(m) && m['type'] === 'swatch' ? (
                      <SwatchView
                        key={j}
                        node={{ ...m, type: 'swatch', shape: 'square', size: 'lg' }}
                        ctx={ctx}
                      />
                    ) : null,
                  )}
              </div>
            )}
            <div className='gui-list-body'>
              {item['meta'] !== undefined && <div className='gui-list-meta'>{read('meta')}</div>}
              <div className='gui-list-title'>
                <span>{read('title')}</span>
              </div>
              {item['sub'] !== undefined && (
                <div className='gui-list-sub'>
                  <Inline text={read('sub')} />
                </div>
              )}
              {facts.length > 0 && (
                <div className='gui-facts'>
                  {facts.map((f, j) => {
                    const fact = isRecord(f) ? f : { text: f };
                    const value = display(interpolate(fact['text'], ctx.scope));
                    return value ? (
                      <span key={j} className='gui-fact'>
                        <IconView name={fact['icon']} size='sm' />
                        <span>{value}</span>
                      </span>
                    ) : null;
                  })}
                </div>
              )}
              {item['text'] !== undefined && (
                <div className='gui-text'>
                  <RichText text={read('text')} />
                </div>
              )}
            </div>
            <ItemBadge badge={item['badge']} ctx={ctx} />
          </li>
        );
      })}
    </Tag>
  );
  if (!label) return list;
  return (
    <div className='gui-field'>
      <span className='gui-label' id={labelId}>
        {label}
      </span>
      {list}
    </div>
  );
}

/** A {text, tone} pill: list row badges and card header badges. */
function ItemBadge({ badge, ctx }: { badge: unknown; ctx: RenderContext }): ReactElement | null {
  if (!isRecord(badge) || typeof badge['text'] !== 'string') return null;
  return (
    <span
      className='gui-badge'
      data-tone={typeof badge['tone'] === 'string' ? badge['tone'] : undefined}
    >
      {display(interpolate(badge['text'], ctx.scope))}
    </span>
  );
}

/** One of the catalog's icons; nothing for a name the catalog does not have. */
function IconView({
  name,
  tone,
  size,
  label,
}: {
  name: unknown;
  tone?: string | undefined;
  size?: string | undefined;
  label?: string | undefined;
}): ReactElement | null {
  if (typeof name !== 'string' || !ICONS.has(name)) return null;
  return (
    <span
      className='gui-icon'
      data-tone={tone}
      data-size={size}
      role={label ? 'img' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
    >
      <Glyph name={name} />
    </span>
  );
}

/** A schedule: tinted blocks in time order, one row per day when grouped. */
function TimelineView({ node, ctx, draft = false }: NodeProps): ReactElement {
  const read = (v: unknown): string => display(interpolate(v, ctx.scope));
  const grouped = Array.isArray(node['groups']);
  if (draft && !grouped && !Array.isArray(node['items'])) return <Skeleton lines={2} />;
  const groups = grouped
    ? (node['groups'] as unknown[]).filter(isRecord).slice(0, 14)
    : [{ items: node['items'] }];
  return (
    <div className='gui-timeline' data-grouped={grouped || undefined}>
      {groups.map((group, g) => {
        const items = Array.isArray(group['items'])
          ? (group['items'] as unknown[]).filter(isRecord).slice(0, 60)
          : [];
        const day = read(group['label']);
        const date = read(group['value']);
        return (
          <div key={g} className='gui-tl-group'>
            {grouped && (
              <div className='gui-tl-day'>
                {day && <span className='gui-tl-day-label'>{day}</span>}
                {date && <span className='gui-tl-day-value'>{date}</span>}
              </div>
            )}
            <ul
              className='gui-tl-items'
              aria-label={[day, date].filter(Boolean).join(' ') || undefined}
            >
              {items.length === 0 && !draft && <li className='gui-tl-empty'>Nothing scheduled</li>}
              {items.map((item, i) => (
                <li
                  key={i}
                  className='gui-tl-item'
                  data-tone={typeof item['tone'] === 'string' ? item['tone'] : undefined}
                >
                  {item['time'] !== undefined && (
                    <span className='gui-tl-time'>{read(item['time'])}</span>
                  )}
                  <span className='gui-tl-title'>
                    <IconView name={item['icon']} size='sm' />
                    <span>{read(item['title'])}</span>
                  </span>
                  {item['sub'] !== undefined && (
                    <span className='gui-tl-sub'>
                      <Inline text={read(item['sub'])} />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function TableView({ node, ctx }: { node: UiNode; ctx: RenderContext }): ReactElement {
  const read = (cell: unknown): string => display(interpolate(cell, ctx.scope));
  const columns = Array.isArray(node['columns']) ? (node['columns'] as unknown[]).map(read) : [];
  const rows = Array.isArray(node['rows']) ? (node['rows'] as unknown[]) : [];
  return (
    <div className='gui-table-wrap'>
      <table className='gui-table'>
        <thead>
          <tr>
            {columns.map((column, i) => (
              <th key={i} scope='col'>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className='gui-muted' colSpan={Math.max(1, columns.length)}>
                {read(node['empty']) || 'Nothing to show yet.'}
              </td>
            </tr>
          ) : (
            rows.map((row, r) => (
              <tr key={r}>
                {(Array.isArray(row) ? row : [row]).map((cell, c) => (
                  <td key={c}>
                    <Inline text={read(cell)} />
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** One lookup per query for the whole page: a re-render or a second block reuses it. */
const imageLookups = new Map<string, Promise<UiImageHit | null>>();

/**
 * The picture found for `query`: undefined while looking, null when there is
 * none (or no way to look). A failed lookup is forgotten so a later render can
 * try again.
 */
function useImageQuery(
  query: string | null,
  find: GenerativeUiHost['findImage'],
): UiImageHit | null | undefined {
  const [hit, setHit] = useState<UiImageHit | null | undefined>(undefined);
  useEffect(() => {
    if (!query || !find) return;
    let live = true;
    let lookup = imageLookups.get(query);
    if (!lookup) {
      lookup = find(query).catch(() => {
        imageLookups.delete(query);
        return null;
      });
      imageLookups.set(query, lookup);
    }
    void lookup.then(found => {
      if (live) setHit(found);
    });
    return (): void => {
      live = false;
    };
  }, [query, find]);
  if (!query || !find) return null;
  return hit;
}

function ImageView({
  src,
  query,
  alt,
  ratio,
  caption,
  draft = false,
  thumb = false,
}: {
  src: unknown;
  query?: unknown;
  alt: string;
  ratio?: string | undefined;
  caption?: string;
  draft?: boolean;
  thumb?: boolean;
}): ReactElement | null {
  const host = useContext(GenerativeUiHostContext);
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  // A draft's src may be a half-typed URL and its query half a phrase: never fetch either.
  const given = !draft && isSafeUrl(src) ? src : null;
  const wanted =
    !draft && !given && typeof query === 'string' && query.trim().length >= 2
      ? query.trim().toLowerCase()
      : null;
  const found = useImageQuery(wanted, host?.findImage);
  const url = given ?? (found && isSafeUrl(found.src) ? found.src : null);
  // Nothing matched the query: leave the picture out rather than show a wrong one.
  if (wanted && found === null) return null;
  const looking = !!wanted && found === undefined;
  return (
    <figure className='gui-figure' data-thumb={thumb || undefined}>
      <div
        className='gui-image'
        data-ratio={ratio ?? '16/9'}
        data-state={url ? state : looking ? 'loading' : 'failed'}
      >
        {(state !== 'loaded' || !url) && (
          <span className='gui-image-placeholder'>
            {state === 'failed' || (!url && !looking) ? alt : ''}
          </span>
        )}
        {url && (
          <img
            src={url}
            alt={alt}
            loading='lazy'
            decoding='async'
            referrerPolicy='no-referrer'
            onLoad={() => setState('loaded')}
            onError={() => setState('failed')}
          />
        )}
      </div>
      {caption ? <figcaption>{caption}</figcaption> : null}
      {found && !thumb && (found.credit || found.license) ? (
        <figcaption className='gui-credit'>
          {found.sourceUrl ? (
            <a href={found.sourceUrl} target='_blank' rel='noreferrer noopener'>
              Photo: {found.credit ?? 'source'}
            </a>
          ) : (
            <span>Photo: {found.credit ?? 'unknown'}</span>
          )}
          {found.license ? (
            <>
              {' · '}
              {found.licenseUrl ? (
                <a href={found.licenseUrl} target='_blank' rel='noreferrer noopener'>
                  {found.license}
                </a>
              ) : (
                found.license
              )}
            </>
          ) : null}
        </figcaption>
      ) : null}
    </figure>
  );
}

function SwatchView({
  node,
  ctx,
  labelled = false,
}: {
  node: UiNode;
  ctx: RenderContext;
  labelled?: boolean;
}): ReactElement {
  const raw = interpolate(node['color'], ctx.scope);
  const color = isSafeColor(raw) ? raw.trim() : undefined;
  const label = display(interpolate(node['label'], ctx.scope));
  const size = typeof node['size'] === 'string' ? node['size'] : 'md';
  if (size === 'xl') {
    return (
      <div
        className='gui-swatch-tile'
        role='img'
        aria-label={label}
        data-ink={inkFor(color)}
        style={color ? { background: color } : undefined}
      >
        {label}
      </div>
    );
  }
  const mark = (
    <span
      className='gui-swatch'
      role='img'
      aria-label={label}
      data-shape={node['shape'] === 'square' ? 'square' : 'circle'}
      data-size={size}
      data-fill={typeof node['fill'] === 'string' ? node['fill'] : 'full'}
      style={color ? cssVars({ '--gui-swatch': color }) : undefined}
    />
  );
  if (!labelled) return mark;
  return (
    <span className='gui-swatch-labelled'>
      {mark}
      <span aria-hidden>{label}</span>
    </span>
  );
}

function CitationView({ node, ctx }: { node: UiNode; ctx: RenderContext }): ReactElement {
  const label = display(interpolate(node['label'], ctx.scope));
  const count = typeof node['count'] === 'number' && node['count'] > 0 ? node['count'] : 0;
  const body = (
    <>
      <span className='gui-citation-mark' aria-hidden>
        {label.trim().charAt(0).toUpperCase() || '?'}
      </span>
      <span className='gui-citation-label'>{label}</span>
      {count > 0 && <span className='gui-muted'>+{count}</span>}
    </>
  );
  const href = node['href'];
  return isSafeUrl(href) ? (
    <a
      className='gui-citation'
      href={href}
      target='_blank'
      rel='noopener noreferrer nofollow'
      title={`Source: ${label}`}
    >
      {body}
    </a>
  ) : (
    <span className='gui-citation' title={`Source: ${label}`}>
      {body}
    </span>
  );
}

// ── Inputs ──────────────────────────────────────────────────────────────────

const optionList = (node: UiNode): string[] =>
  Array.isArray(node['options']) ? (node['options'] as unknown[]).map(display).filter(Boolean) : [];

function ChoiceView({ node, ctx, path, draft = false }: NodeProps): ReactElement {
  const name = nameOf(node);
  const multiple = node['multiple'] === true;
  const current = ctx.scope[name];
  const picked = new Set(Array.isArray(current) ? current.map(display) : [display(current)]);
  const recommended = typeof node['recommended'] === 'string' ? node['recommended'] : undefined;
  const label = display(interpolate(node['label'], ctx.scope));
  const toggle = (option: string, on: boolean): void => {
    if (!multiple) return ctx.setValue(name, option);
    const next = new Set(Array.isArray(current) ? current.map(display) : []);
    if (on) next.add(option);
    else next.delete(option);
    ctx.setValue(
      name,
      optionList(node).filter(o => next.has(o)),
    );
  };
  return (
    <fieldset className='gui-field' disabled={draft || ctx.locked}>
      {label && <legend className='gui-label'>{label}</legend>}
      <div className='gui-options'>
        {optionList(node).map(option => (
          <label key={option} className='gui-option'>
            <input
              type={multiple ? 'checkbox' : 'radio'}
              name={`${ctx.uid}-${path}-${name}`}
              value={option}
              checked={picked.has(option)}
              onChange={event => toggle(option, event.target.checked)}
              data-track-category='GenerativeUi'
              data-track-name='GEN_UI_CHOICE'
            />
            <span className='gui-option-text'>{option}</span>
            {recommended === option && (
              <span className='gui-badge' data-tone='positive'>
                Recommended
              </span>
            )}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SegmentedView({ node, ctx, path, draft = false }: NodeProps): ReactElement {
  const name = nameOf(node);
  const labelId = `${ctx.uid}-${path}-label`;
  const label = display(interpolate(node['label'], ctx.scope));
  const current = display(ctx.scope[name]);
  return (
    <div className='gui-field'>
      {label && (
        <span className='gui-label' id={labelId}>
          {label}
        </span>
      )}
      <div className='gui-segmented' role='group' aria-labelledby={label ? labelId : undefined}>
        {optionList(node).map(option => (
          <button
            key={option}
            type='button'
            aria-pressed={current === option}
            disabled={draft || ctx.locked}
            onClick={() => ctx.setValue(name, option)}
            data-track-category='GenerativeUi'
            data-track-name='GEN_UI_SEGMENT'
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function SelectView({ node, ctx, path, draft = false, within }: NodeProps): ReactElement {
  const name = nameOf(node);
  const id = `${ctx.uid}-${path}-select`;
  const label = display(interpolate(node['label'], ctx.scope));
  const options = optionList(node);
  const current = display(ctx.scope[name]);
  const chosen = options.includes(current) ? current : '';
  return (
    <div className='gui-field'>
      {label && (
        <label htmlFor={id} className='gui-label'>
          {label}
        </label>
      )}
      <div className='gui-select'>
        <select
          id={id}
          value={chosen}
          disabled={draft || ctx.locked}
          aria-label={label ? undefined : within || name}
          onChange={event => ctx.setValue(name, event.target.value)}
          data-track-category='GenerativeUi'
          data-track-name='GEN_UI_SELECT'
        >
          {chosen === '' && (
            <option value='' disabled>
              Choose…
            </option>
          )}
          {options.map(option => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <Glyph name='chevron-down' className='gui-select-chevron' />
      </div>
    </div>
  );
}

function SliderView({ node, ctx, path, draft = false }: NodeProps): ReactElement {
  const name = nameOf(node);
  const id = `${ctx.uid}-${path}-slider`;
  const read = (prop: string, fallback: number): number => {
    const value = interpolate(node[prop], ctx.scope);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };
  const min = read('min', 0);
  const max = Math.max(min + 1e-9, read('max', 100));
  const step = Math.max(1e-9, read('step', 1));
  const raw = Number(ctx.scope[name]);
  const value = Number.isFinite(raw) ? clamp(raw, min, max) : min;
  const unit = display(interpolate(node['unit'], ctx.scope));
  const withUnit = (n: number): string =>
    `${display(n)}${unit ? (/^[%°]/.test(unit) ? unit : ` ${unit}`) : ''}`;
  return (
    <div className='gui-field'>
      <div className='gui-slider-head'>
        <label htmlFor={id} className='gui-label'>
          {display(interpolate(node['label'], ctx.scope))}
        </label>
        <output htmlFor={id} className='gui-slider-value'>
          {withUnit(value)}
        </output>
      </div>
      <input
        id={id}
        className='gui-slider'
        type='range'
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={draft || ctx.locked}
        aria-valuetext={withUnit(value)}
        onChange={event => ctx.setValue(name, Number(event.target.value))}
        style={cssVars({ '--gui-fill': `${((value - min) / (max - min)) * 100}%` })}
        data-track-category='GenerativeUi'
        data-track-name='GEN_UI_SLIDER'
      />
      <div className='gui-slider-scale' aria-hidden>
        <span>{withUnit(min)}</span>
        <span>{withUnit(max)}</span>
      </div>
    </div>
  );
}

function InputView({ node, ctx, path, draft = false }: NodeProps): ReactElement {
  const name = nameOf(node);
  const id = `${ctx.uid}-${path}-input`;
  const help = display(interpolate(node['help'], ctx.scope));
  const kind =
    node['inputType'] === 'number' || node['inputType'] === 'email' ? node['inputType'] : 'text';
  const value = ctx.scope[name];
  return (
    <div className='gui-field'>
      <label htmlFor={id} className='gui-label'>
        {display(interpolate(node['label'], ctx.scope))}
      </label>
      <input
        id={id}
        className='gui-input'
        type={kind}
        value={value === undefined || value === null ? '' : display(value)}
        placeholder={display(interpolate(node['placeholder'], ctx.scope)) || undefined}
        disabled={draft || ctx.locked}
        aria-describedby={help ? `${id}-help` : undefined}
        onChange={event => {
          const next = event.target.value;
          ctx.setValue(
            name,
            kind === 'number' && next.trim() !== '' && Number.isFinite(Number(next))
              ? Number(next)
              : next,
          );
        }}
        data-track-category='GenerativeUi'
        data-track-name='GEN_UI_INPUT'
      />
      {help && (
        <p id={`${id}-help`} className='gui-help'>
          {help}
        </p>
      )}
    </div>
  );
}

function ToggleView({ node, ctx, draft = false }: NodeProps): ReactElement {
  const name = nameOf(node);
  return (
    <label className='gui-toggle'>
      <input
        type='checkbox'
        role='switch'
        checked={ctx.scope[name] === true}
        disabled={draft || ctx.locked}
        onChange={event => ctx.setValue(name, event.target.checked)}
        data-track-category='GenerativeUi'
        data-track-name='GEN_UI_TOGGLE'
      />
      <span className='gui-toggle-track' aria-hidden>
        <span className='gui-toggle-thumb' />
      </span>
      <span>{display(interpolate(node['label'], ctx.scope))}</span>
    </label>
  );
}

function ButtonView({ node, ctx, draft = false }: NodeProps): ReactElement {
  const action = node['do'] ?? 'send';
  const sends = action === 'send';
  const kind = typeof node['kind'] === 'string' ? node['kind'] : 'secondary';
  const disabled = draft || ctx.locked || (sends && !ctx.canSend);
  return (
    <button
      type='button'
      className='gui-button'
      data-kind={kind}
      data-full={node['full'] === true || undefined}
      disabled={disabled}
      onClick={() => ctx.press(node)}
      data-track-category='GenerativeUi'
      data-track-name={sends ? 'GEN_UI_SEND' : 'GEN_UI_ACTION'}
    >
      {display(interpolate(node['text'], ctx.scope))}
    </button>
  );
}

// ── Text ────────────────────────────────────────────────────────────────────

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|\[([^\]\n]{1,200})\]\(([^)\s]{1,2000})\)/g;
const BULLET = /^\s*[-*•]\s+/;

/** **bold**, *italic*, `code` and [label](https-url). Never HTML. */
/** Chat citation tokens ([clf-…#n], [#n]) only resolve in prose; inside a block they would show as raw ids. */
const CITATION_TOKEN = /\s?\[(?:clf-[^\]\s]+|#\d+)\]/g;

function Inline({ text: raw }: { text: string }): ReactElement {
  const text = raw.replace(CITATION_TOKEN, '');
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (m[1]) out.push(<code key={at}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={at}>{m[2].slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={at}>{m[3].slice(1, -1)}</em>);
    else if (m[4] !== undefined) {
      out.push(
        isSafeUrl(m[5]) ? (
          <a key={at} href={m[5]} target='_blank' rel='noopener noreferrer nofollow'>
            {m[4]}
          </a>
        ) : (
          m[4]
        ),
      );
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/** Paragraphs split on blank lines; runs of "- " lines become a bulleted list. */
function RichText({ text }: { text: string }): ReactElement {
  const blocks: ReactNode[] = [];
  text.split(/\n{2,}/).forEach((paragraph, p) => {
    let lines: string[] = [];
    let bullets: string[] = [];
    const flushLines = (): void => {
      if (lines.length === 0) return;
      const body = lines;
      blocks.push(
        <p key={`${p}-${blocks.length}`}>
          {body.map((line, i) => (
            <span key={i}>
              {i > 0 && <br />}
              <Inline text={line} />
            </span>
          ))}
        </p>,
      );
      lines = [];
    };
    const flushBullets = (): void => {
      if (bullets.length === 0) return;
      const body = bullets;
      blocks.push(
        <ul key={`${p}-${blocks.length}`}>
          {body.map((line, i) => (
            <li key={i}>
              <Inline text={line} />
            </li>
          ))}
        </ul>,
      );
      bullets = [];
    };
    for (const line of paragraph.split('\n')) {
      if (BULLET.test(line)) {
        flushLines();
        bullets.push(line.replace(BULLET, ''));
      } else if (line.trim()) {
        flushBullets();
        lines.push(line.trim());
      }
    }
    flushLines();
    flushBullets();
  });
  return <>{blocks}</>;
}

// ── Fallbacks ───────────────────────────────────────────────────────────────

function Skeleton({ lines }: { lines: number }): ReactElement {
  return (
    <div className='gui-skeleton' aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}

/**
 * Nothing in the block could be drawn: show its content as readable text, with
 * what the agent wrote one click away, rather than nothing (never fail silently).
 */
function RawFallback({ source }: { source: string }): ReactElement {
  const text = useMemo(() => {
    try {
      return uiBlockAsText(source);
    } catch {
      return '';
    }
  }, [source]);
  return (
    <div className='gui gui-fallback not-prose'>
      {text && (
        <div className='gui-text'>
          <RichText text={text} />
        </div>
      )}
      <details className='gui-raw-details'>
        <summary className='gui-note'>
          <span role='status'>
            {text
              ? 'Shown as text: this part could not be drawn.'
              : 'This part could not be drawn.'}
          </span>
        </summary>
        <pre className='gui-raw'>
          <code>{source}</code>
        </pre>
      </details>
    </div>
  );
}

/** One top-level line that throws while drawing is left out; the rest of the block stays. */
class LineBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? (
      <p className='gui-note' role='status'>
        Part of this answer could not be displayed.
      </p>
    ) : (
      this.props.children
    );
  }
}

class GenerativeUiBoundary extends Component<
  { source: string; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidUpdate(previous: { source: string }): void {
    // A later delta can complete what made the last render throw.
    if (this.state.failed && previous.source !== this.props.source)
      this.setState({ failed: false });
  }

  override render(): ReactNode {
    return this.state.failed ? <RawFallback source={this.props.source} /> : this.props.children;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const UNSAFE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

const nameOf = (node: UiNode): string => (typeof node['name'] === 'string' ? node['name'] : '');

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

const cssVars = (vars: Record<string, string | number>): CSSProperties => vars as CSSProperties;

/** The chat's own drawing of an icon name, or nothing for a name its icon set does not have. */
function Glyph({
  name,
  className,
  strokeWidth,
}: {
  name: string;
  className?: string;
  strokeWidth?: number;
}): ReactElement | null {
  const Drawn = ICONS.get(name);
  if (!Drawn) return null;
  return (
    <Drawn
      aria-hidden
      {...(className ? { className } : {})}
      {...(strokeWidth ? { strokeWidth } : {})}
    />
  );
}

/** Light or dark text for a label drawn on `color`. */
function inkFor(color: string | undefined): 'light' | 'dark' {
  const m = color ? /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color) : null;
  if (!m?.[1]) return 'light';
  const hex = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
  const channel = (i: number): number => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.45 ? 'dark' : 'light';
}

// ── Styles ──────────────────────────────────────────────────────────────────

const STYLE_ID = 'gui-styles-v3';

function useGenerativeUiStyles(): void {
  useInsertionEffect(() => {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = GENERATIVE_UI_CSS;
    document.head.appendChild(style);
  }, []);
}

/*
 * One spacing scale (4 / 8 / 12 / 16 / 20 px), one radius scale (6 / 8 / 12 /
 * pill), one type scale (12.5 / 13 / 14 / 15 / 16 / 18 px). Colours come only
 * from --gui-* variables, set by each app from its theme; the fallbacks are a
 * neutral light theme. Tints are mixed from the tone colour, so dark mode needs
 * no second palette.
 */
const GENERATIVE_UI_CSS = `
.gui{--g-fg:var(--gui-fg,#18181b);--g-muted:var(--gui-fg-muted,#71717a);--g-surface:var(--gui-surface,#fff);--g-subtle:var(--gui-surface-muted,#f4f4f5);--g-border:var(--gui-border,#e4e4e7);--g-accent:var(--gui-accent,#2563eb);--g-accent-fg:var(--gui-accent-fg,#fff);--g-positive:var(--gui-positive,#16a34a);--g-warning:var(--gui-warning,#d97706);--g-danger:var(--gui-danger,#dc2626);--g-link:var(--gui-link,var(--g-accent));--g-focus:var(--gui-focus,var(--g-accent));
  display:flex;flex-direction:column;gap:12px;width:100%;min-width:0;margin:8px 0;color:var(--g-fg);font-size:14px;line-height:1.55;text-align:left;overflow-wrap:anywhere}
.gui *,.gui *::before,.gui *::after{box-sizing:border-box}
.gui p,.gui ul,.gui ol,.gui figure,.gui fieldset,.gui h3,.gui h4,.gui h5,.gui h6{margin:0}
.gui ul{padding-left:1.25em;list-style:disc}
.gui li{margin:2px 0}
.gui a{color:var(--g-link);text-decoration:underline;text-underline-offset:2px}
.gui code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;background:var(--g-subtle);padding:1px 5px;border-radius:6px}
.gui :focus-visible{outline:2px solid var(--g-focus);outline-offset:2px}
.gui-title{font-size:15px;font-weight:600;line-height:1.35}
.gui-muted{color:var(--g-muted)}
.gui-stack{display:flex;flex-direction:column;gap:12px;min-width:0}
.gui-row{display:flex;flex-wrap:wrap;align-items:center;gap:12px;min-width:0}
.gui-row[data-nowrap]{flex-wrap:nowrap}
.gui-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,max(var(--gui-min,180px),calc((100% - (var(--gui-cols,2) - 1) * 12px) / var(--gui-cols,2)))),1fr))}
.gui-grid[data-cols="4"]{--gui-min:130px}
.gui [data-gap=xs]{gap:4px}.gui [data-gap=sm]{gap:8px}.gui [data-gap=md]{gap:12px}.gui [data-gap=lg]{gap:20px}
.gui-stack[data-align=center]{align-items:center}.gui-stack[data-align=end]{align-items:flex-end}
.gui-row[data-align=start]{align-items:flex-start}.gui-row[data-align=end]{align-items:flex-end}
.gui-card{display:flex;flex-direction:column;gap:12px;min-width:0;padding:16px;border:1px solid var(--g-border);border-radius:12px;background:var(--g-surface)}
.gui-card[data-tone=accent]{border-color:color-mix(in srgb,var(--g-accent) 45%,var(--g-border))}
.gui-card[data-tone=positive]{border-color:color-mix(in srgb,var(--g-positive) 45%,var(--g-border))}
.gui-card[data-tone=warning]{border-color:color-mix(in srgb,var(--g-warning) 50%,var(--g-border))}
.gui-card[data-tone=danger]{border-color:color-mix(in srgb,var(--g-danger) 50%,var(--g-border))}
.gui-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;min-width:0}
.gui-card-heading{display:flex;flex-direction:column;gap:2px;min-width:0}
.gui-card-title{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;line-height:1.35}
.gui-card-title .gui-icon:not([data-tone]){color:var(--g-muted)}
.gui-card-sub{font-size:13px;line-height:1.4;color:var(--g-muted)}
.gui-card-aside{flex:none;padding-top:1px;font-size:13px;color:var(--g-muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.gui-card-head>.gui-badge{flex:none}
.gui-disclosure{border:1px solid var(--g-border);border-radius:12px;padding:0 16px}
.gui-disclosure>summary{cursor:pointer;font-weight:600;min-height:44px;display:flex;align-items:center}
.gui-disclosure[open]>summary{border-bottom:1px solid var(--g-border);margin-bottom:12px}
.gui-disclosure>.gui-stack{padding-bottom:16px}
.gui-heading{font-weight:600;line-height:1.3;color:var(--g-fg)}
.gui-heading[data-level="1"]{font-size:18px}.gui-heading[data-level="2"]{font-size:16px}.gui-heading[data-level="3"]{font-size:15px}.gui-heading[data-level="4"]{font-size:14px}
.gui-text{display:flex;flex-direction:column;gap:8px;min-width:0}
.gui-text[data-size=sm]{font-size:12.5px}.gui-text[data-size=lg]{font-size:16px}
.gui-text[data-tone=muted]{color:var(--g-muted)}
.gui-text[data-tone=accent]{color:color-mix(in srgb,var(--g-accent) 65%,var(--g-fg))}
.gui-text[data-tone=positive]{color:color-mix(in srgb,var(--g-positive) 65%,var(--g-fg))}
.gui-text[data-tone=warning]{color:color-mix(in srgb,var(--g-warning) 65%,var(--g-fg))}
.gui-text[data-tone=danger]{color:color-mix(in srgb,var(--g-danger) 65%,var(--g-fg))}
.gui-badge{display:inline-flex;align-items:center;width:fit-content;height:22px;padding:0 10px;border-radius:999px;font-size:12.5px;font-weight:500;line-height:1;white-space:nowrap;background:var(--g-subtle);color:var(--g-muted)}
.gui-badge[data-tone=accent]{background:color-mix(in srgb,var(--g-accent) 14%,var(--g-surface));color:color-mix(in srgb,var(--g-accent) 65%,var(--g-fg))}
.gui-badge[data-tone=positive]{background:color-mix(in srgb,var(--g-positive) 14%,var(--g-surface));color:color-mix(in srgb,var(--g-positive) 65%,var(--g-fg))}
.gui-badge[data-tone=warning]{background:color-mix(in srgb,var(--g-warning) 16%,var(--g-surface));color:color-mix(in srgb,var(--g-warning) 65%,var(--g-fg))}
.gui-badge[data-tone=danger]{background:color-mix(in srgb,var(--g-danger) 14%,var(--g-surface));color:color-mix(in srgb,var(--g-danger) 65%,var(--g-fg))}
.gui-stat{display:flex;flex-direction:column;gap:2px;min-width:0;padding:12px 14px;border:1px solid var(--g-border);border-radius:12px;background:var(--g-surface)}
.gui-stat-value{font-size:22px;font-weight:600;line-height:1.25;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.gui-stat-label{font-size:13px;line-height:1.35;color:var(--g-muted)}
.gui-stat-note{font-size:12.5px;line-height:1.35;color:var(--g-muted)}
.gui-stat[data-tone=accent] .gui-stat-note{color:color-mix(in srgb,var(--g-accent) 65%,var(--g-fg))}
.gui-stat[data-tone=positive] .gui-stat-note{color:color-mix(in srgb,var(--g-positive) 65%,var(--g-fg))}
.gui-stat[data-tone=warning] .gui-stat-note{color:color-mix(in srgb,var(--g-warning) 65%,var(--g-fg))}
.gui-stat[data-tone=danger] .gui-stat-note{color:color-mix(in srgb,var(--g-danger) 65%,var(--g-fg))}
.gui-card .gui-stat{border-color:transparent;background:var(--g-subtle)}
.gui-icon{display:inline-flex;flex:none;width:16px;height:16px}
.gui-icon svg{width:100%;height:100%}
.gui-icon[data-size=sm]{width:14px;height:14px}.gui-icon[data-size=lg]{width:20px;height:20px}
.gui-icon[data-tone=neutral]{color:var(--g-muted)}
.gui-icon[data-tone=accent]{color:color-mix(in srgb,var(--g-accent) 75%,var(--g-fg))}
.gui-icon[data-tone=positive]{color:color-mix(in srgb,var(--g-positive) 75%,var(--g-fg))}
.gui-icon[data-tone=warning]{color:color-mix(in srgb,var(--g-warning) 75%,var(--g-fg))}
.gui-icon[data-tone=danger]{color:color-mix(in srgb,var(--g-danger) 75%,var(--g-fg))}
.gui-icon-tile{display:grid;place-items:center;flex:none;width:36px;height:36px;border-radius:10px;background:var(--g-subtle);color:var(--g-muted)}
.gui-icon-tile .gui-icon{width:18px;height:18px}
.gui-icon-tile[data-tone=accent]{background:color-mix(in srgb,var(--g-accent) 12%,var(--g-surface));color:color-mix(in srgb,var(--g-accent) 75%,var(--g-fg))}
.gui-icon-tile[data-tone=positive]{background:color-mix(in srgb,var(--g-positive) 12%,var(--g-surface));color:color-mix(in srgb,var(--g-positive) 75%,var(--g-fg))}
.gui-icon-tile[data-tone=warning]{background:color-mix(in srgb,var(--g-warning) 14%,var(--g-surface));color:color-mix(in srgb,var(--g-warning) 75%,var(--g-fg))}
.gui-icon-tile[data-tone=danger]{background:color-mix(in srgb,var(--g-danger) 12%,var(--g-surface));color:color-mix(in srgb,var(--g-danger) 75%,var(--g-fg))}
.gui-list{list-style:none!important;padding:0!important;display:flex;flex-direction:column}
.gui-list-item{display:flex;gap:12px;align-items:flex-start;padding:10px 0;margin:0!important}
.gui-list[data-dividers] .gui-list-item+.gui-list-item{border-top:1px solid var(--g-border)}
.gui-list-media{flex:none}
.gui-palette{display:flex;gap:4px}
.gui-list-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.gui-list-title{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-weight:600}
.gui-list-sub{font-size:13px;color:var(--g-muted)}
.gui-list-meta{font-size:12.5px;line-height:1.4;color:var(--g-muted);font-variant-numeric:tabular-nums}
.gui-list-item>.gui-badge{flex:none;margin-top:1px}
.gui-list-item[data-done] .gui-list-title{color:var(--g-muted);font-weight:500;text-decoration:line-through}
.gui-facts{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:2px;font-size:12.5px;color:var(--g-muted)}
.gui-fact{display:inline-flex;align-items:center;gap:5px}
.gui-step{display:grid;place-items:center;flex:none;width:24px;height:24px;border-radius:50%;background:var(--g-subtle);font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums}
.gui-check{position:relative;display:grid;place-items:center;flex:none;width:28px;height:28px;margin:-3px -4px;cursor:pointer}
.gui-check input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
.gui-check-box{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;border:1.5px solid color-mix(in srgb,var(--g-muted) 70%,transparent);color:transparent;transition:background-color .15s,border-color .15s}
.gui-check-box svg{width:12px;height:12px}
.gui-check input:checked+.gui-check-box{background:var(--g-accent);border-color:var(--g-accent);color:var(--g-accent-fg)}
.gui-check input:focus-visible+.gui-check-box{outline:2px solid var(--g-focus);outline-offset:2px}
.gui-check:has(input:disabled){opacity:.55;cursor:not-allowed}
.gui-timeline{display:flex;flex-direction:column}
.gui-tl-group{display:flex;gap:14px;min-width:0}
.gui-timeline[data-grouped] .gui-tl-group{padding:10px 0}
.gui-timeline[data-grouped] .gui-tl-group+.gui-tl-group{border-top:1px solid var(--g-border)}
.gui-tl-day{display:flex;flex-direction:column;align-items:center;gap:2px;flex:none;width:40px;padding-top:4px}
.gui-tl-day-label{font-size:11.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--g-muted)}
.gui-tl-day-value{font-size:18px;font-weight:600;line-height:1.15;font-variant-numeric:tabular-nums}
.gui-tl-items{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;list-style:none!important;padding:0!important}
.gui-tl-item{display:flex;flex-direction:column;gap:1px;margin:0!important;padding:8px 12px;border-radius:8px;border-left:3px solid var(--g-border);background:var(--g-subtle)}
.gui-tl-item[data-tone=accent]{background:color-mix(in srgb,var(--g-accent) 9%,var(--g-surface));border-left-color:color-mix(in srgb,var(--g-accent) 70%,var(--g-surface))}
.gui-tl-item[data-tone=positive]{background:color-mix(in srgb,var(--g-positive) 9%,var(--g-surface));border-left-color:color-mix(in srgb,var(--g-positive) 70%,var(--g-surface))}
.gui-tl-item[data-tone=warning]{background:color-mix(in srgb,var(--g-warning) 11%,var(--g-surface));border-left-color:color-mix(in srgb,var(--g-warning) 75%,var(--g-surface))}
.gui-tl-item[data-tone=danger]{background:color-mix(in srgb,var(--g-danger) 9%,var(--g-surface));border-left-color:color-mix(in srgb,var(--g-danger) 70%,var(--g-surface))}
.gui-tl-time{font-size:12px;color:var(--g-muted);font-variant-numeric:tabular-nums}
.gui-tl-title{display:flex;align-items:center;gap:6px;font-weight:600;line-height:1.35}
.gui-tl-sub{font-size:12.5px;color:var(--g-muted)}
.gui-tl-empty{margin:0!important;padding:6px 0;font-size:13px;color:var(--g-muted)}
.gui-figure{display:flex;flex-direction:column;gap:4px;max-width:100%}
.gui-figure figcaption{font-size:12.5px;color:var(--g-muted)}
.gui-image{position:relative;overflow:hidden;width:min(100%,480px);border-radius:12px;border:1px solid var(--g-border);background:var(--g-subtle);aspect-ratio:16/9}
.gui-card .gui-image,.gui-grid .gui-image{width:100%}
.gui-image[data-state=loading]{animation:gui-pulse 1.4s ease-in-out infinite}
.gui-credit{font-size:11.5px;color:var(--g-muted)}.gui-credit a{color:inherit}
.gui-image[data-ratio="1/1"]{aspect-ratio:1/1;width:min(100%,200px)}.gui-image[data-ratio="4/5"]{aspect-ratio:4/5;width:min(100%,200px)}.gui-image[data-ratio="3/2"]{aspect-ratio:3/2}
.gui-figure[data-thumb] .gui-image{width:56px;border-radius:8px}
.gui-image img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .2s}
.gui-image[data-state=loaded] img{opacity:1}
.gui-image-placeholder{position:absolute;inset:0;display:grid;place-items:center;padding:8px;font-size:12px;text-align:center;color:var(--g-muted)}
.gui-swatch{display:inline-block;flex:none;width:28px;height:28px;border-radius:50%;border:2px solid var(--gui-swatch,var(--g-fg));background:var(--gui-swatch,var(--g-fg))}
.gui-swatch[data-shape=square]{border-radius:6px}
.gui-swatch[data-size=sm]{width:16px;height:16px}.gui-swatch[data-size=lg]{width:44px;height:44px}
.gui-swatch[data-fill=half]{background:linear-gradient(90deg,var(--gui-swatch,var(--g-fg)) 50%,transparent 50%)}
.gui-swatch[data-fill=empty]{background:transparent}
.gui-swatch-labelled{display:inline-flex;align-items:center;gap:8px}
.gui-swatch-tile{display:grid;place-items:center;width:100%;min-height:140px;padding:16px;border-radius:12px;border:1px solid var(--g-border);background:var(--g-subtle);font-size:15px;font-weight:600;text-align:center;transition:background-color .12s}
.gui-swatch-tile[data-ink=light]{color:#fff;text-shadow:0 1px 2px rgb(0 0 0 / .3)}.gui-swatch-tile[data-ink=dark]{color:#18181b}
.gui-table-wrap{overflow-x:auto;max-width:100%;border:1px solid var(--g-border);border-radius:12px}
.gui-table{width:100%;border-collapse:collapse;font-size:13.5px;margin:0!important}
.gui-table th,.gui-table td{padding:8px 12px;text-align:left;vertical-align:top;border:0;border-top:1px solid var(--g-border)}
.gui-table thead th{border-top:0;background:var(--g-subtle);font-weight:600;white-space:nowrap}
.gui-callout{display:flex;align-items:flex-start;gap:10px;padding:12px 16px;border-radius:12px;background:var(--g-subtle);border:1px solid transparent}
.gui-callout-body{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}
.gui-callout>.gui-icon{margin-top:3px}
.gui-callout-title{font-weight:600}
.gui-callout[data-tone=accent]{background:color-mix(in srgb,var(--g-accent) 10%,var(--g-surface));border-color:color-mix(in srgb,var(--g-accent) 25%,transparent)}
.gui-callout[data-tone=positive]{background:color-mix(in srgb,var(--g-positive) 10%,var(--g-surface));border-color:color-mix(in srgb,var(--g-positive) 25%,transparent)}
.gui-callout[data-tone=warning]{background:color-mix(in srgb,var(--g-warning) 12%,var(--g-surface));border-color:color-mix(in srgb,var(--g-warning) 30%,transparent)}
.gui-callout[data-tone=danger]{background:color-mix(in srgb,var(--g-danger) 10%,var(--g-surface));border-color:color-mix(in srgb,var(--g-danger) 25%,transparent)}
.gui-progress{display:flex;flex-direction:column;gap:6px}
.gui-progress-head{display:flex;justify-content:space-between;gap:12px;font-size:13px}
.gui-progress-bar{height:8px;border-radius:999px;background:var(--g-subtle);overflow:hidden}
.gui-progress-fill{height:100%;border-radius:999px;background:var(--g-accent);transition:width .2s}
.gui-progress-fill[data-indeterminate]{width:35%;animation:gui-slide 1.2s ease-in-out infinite}
.gui-progress[data-tone=neutral] .gui-progress-fill{background:var(--g-muted)}
.gui-progress[data-tone=positive] .gui-progress-fill{background:var(--g-positive)}
.gui-progress[data-tone=warning] .gui-progress-fill{background:var(--g-warning)}
.gui-progress[data-tone=danger] .gui-progress-fill{background:var(--g-danger)}
@keyframes gui-slide{0%{margin-left:-35%}100%{margin-left:100%}}
.gui-divider{border:0;border-top:1px solid var(--g-border);margin:4px 0;width:100%}
.gui-citation{display:inline-flex;align-items:center;gap:6px;width:fit-content;max-width:100%;height:24px;padding:0 10px 0 3px;border-radius:999px;background:var(--g-subtle);color:var(--g-muted);font-size:12px;text-decoration:none!important;white-space:nowrap}
.gui-citation-label{overflow:hidden;text-overflow:ellipsis}
.gui-citation-mark{display:grid;place-items:center;flex:none;width:18px;height:18px;border-radius:50%;background:var(--g-border);color:var(--g-fg);font-size:10px;font-weight:600}
a.gui-citation:hover{color:var(--g-fg)}
.gui-field{display:flex;flex-direction:column;gap:6px;min-width:0;border:0;padding:0}
.gui-label{font-size:13px;font-weight:500;color:var(--g-fg);padding:0}
.gui-help{font-size:12.5px;color:var(--g-muted)}
.gui-options{display:flex;flex-direction:column;gap:4px}
.gui-option{display:flex;align-items:center;gap:10px;min-height:40px;padding:6px 10px;border:1px solid var(--g-border);border-radius:8px;cursor:pointer;background:var(--g-surface)}
.gui-option:has(input:checked){border-color:var(--g-accent);background:color-mix(in srgb,var(--g-accent) 6%,var(--g-surface))}
.gui-option input{flex:none;width:16px;height:16px;margin:0;accent-color:var(--g-accent);cursor:pointer}
.gui-option-text{flex:1;min-width:0}
.gui-segmented{display:inline-flex;flex-wrap:wrap;gap:4px;width:fit-content;max-width:100%;padding:4px;border-radius:10px;background:var(--g-subtle)}
.gui-segmented button{min-height:32px;padding:0 12px;border:0;border-radius:8px;background:transparent;color:var(--g-muted);font:inherit;font-size:13px;font-weight:500;cursor:pointer}
.gui-segmented button[aria-pressed=true]{background:var(--g-surface);color:var(--g-fg);box-shadow:0 1px 2px rgb(0 0 0 / .08)}
.gui-slider-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.gui-slider-value{font-variant-numeric:tabular-nums;font-weight:600}
.gui-slider{width:100%;height:20px;margin:0;accent-color:var(--g-accent);cursor:pointer}
.gui-slider-scale{display:flex;justify-content:space-between;font-size:12px;color:var(--g-muted);font-variant-numeric:tabular-nums}
.gui-input{width:100%;min-height:40px;padding:8px 12px;border:1px solid var(--g-border);border-radius:8px;background:var(--g-surface);color:var(--g-fg);font:inherit}
.gui-input::placeholder{color:var(--g-muted)}
.gui-select{position:relative;width:fit-content;min-width:140px;max-width:100%}
.gui-select select{width:100%;min-height:36px;padding:0 32px 0 12px;border:1px solid var(--g-border);border-radius:8px;background:var(--g-surface);color:var(--g-fg);font:inherit;font-size:13.5px;cursor:pointer;appearance:none;-webkit-appearance:none}
.gui-select-chevron{position:absolute;top:50%;right:10px;width:16px;height:16px;transform:translateY(-50%);color:var(--g-muted);pointer-events:none}
.gui-toggle{display:inline-flex;align-items:center;gap:10px;min-height:40px;cursor:pointer;width:fit-content}
.gui-toggle input{position:absolute;opacity:0;width:1px;height:1px;margin:0}
.gui-toggle-track{position:relative;flex:none;width:36px;height:20px;border-radius:999px;background:var(--g-border);transition:background-color .15s}
.gui-toggle-thumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgb(0 0 0 / .25);transition:transform .15s}
.gui-toggle input:checked+.gui-toggle-track{background:var(--g-accent)}
.gui-toggle input:checked+.gui-toggle-track .gui-toggle-thumb{transform:translateX(16px)}
.gui-toggle input:focus-visible+.gui-toggle-track{outline:2px solid var(--g-focus);outline-offset:2px}
.gui-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:0 14px;border-radius:8px;border:1px solid var(--g-border);background:var(--g-surface);color:var(--g-fg);font:inherit;font-size:13.5px;font-weight:500;cursor:pointer;transition:background-color .15s,border-color .15s}
.gui-button:hover:not(:disabled){background:var(--g-subtle)}
.gui-button[data-kind=primary]{background:var(--g-accent);border-color:var(--g-accent);color:var(--g-accent-fg)}
.gui-button[data-kind=primary]:hover:not(:disabled){background:color-mix(in srgb,var(--g-accent) 88%,#000)}
.gui-button[data-kind=danger]{background:var(--g-danger);border-color:var(--g-danger);color:#fff}
.gui-button[data-kind=danger]:hover:not(:disabled){background:color-mix(in srgb,var(--g-danger) 88%,#000)}
.gui-button[data-kind=link]{border-color:transparent;background:transparent;color:var(--g-link);padding:0 4px}
.gui-button[data-full]{width:100%;min-height:40px}
.gui-button:disabled,.gui fieldset:disabled .gui-option,.gui-input:disabled,.gui-slider:disabled,.gui-toggle:has(input:disabled),.gui-segmented button:disabled,.gui-select select:disabled{opacity:.55;cursor:not-allowed}
.gui-note{font-size:12.5px;color:var(--g-muted)}
.gui-note-sent{color:color-mix(in srgb,var(--g-positive) 65%,var(--g-fg))}
.gui-draft{opacity:.7}
.gui-skeleton{display:flex;flex-direction:column;gap:8px}
.gui-skeleton span{display:block;height:14px;border-radius:6px;background:var(--g-subtle);animation:gui-pulse 1.4s ease-in-out infinite}
.gui-skeleton span:last-child:not(:first-child){width:60%}
@keyframes gui-pulse{50%{opacity:.5}}
.gui-raw{margin:0;padding:12px;border-radius:8px;background:var(--g-subtle);overflow:auto;max-height:240px;font-size:12px;line-height:1.5;white-space:pre}
.gui-raw-details>summary{cursor:pointer;width:fit-content;list-style:none}.gui-raw-details>summary::-webkit-details-marker{display:none}
.gui-raw-details[open]>summary{margin-bottom:8px}
.gui-raw code{background:none;padding:0}
@media (prefers-reduced-motion:reduce){.gui *{animation:none!important;transition:none!important}}
`;
