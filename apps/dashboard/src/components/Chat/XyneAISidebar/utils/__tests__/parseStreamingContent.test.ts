import { describe, expect, it } from 'vitest';
import { parseStreamingContent } from '../XyneAIUtils';

const UI_BLOCK = [
  '```ui',
  '{"id":"a","type":"Card","props":{"title":"summary"}}',
  '{"id":"b","type":"Text","props":{"text":"keypoints"}}',
  '```',
].join('\n');

describe('parseStreamingContent with a ui fence', () => {
  it('returns the reply untouched even when the JSON mentions summary/keypoints', () => {
    const reply = `Here you go\n\n${UI_BLOCK}\n\nAnything else?`;
    const parsed = parseStreamingContent(reply);
    expect(parsed.summary).toBe(reply);
    expect(parsed.keypoints).toEqual([]);
    expect(parsed.isComplete).toBe(false);
  });

  it('keeps fences when the reply starts with a brace', () => {
    const reply = `{ note }\n${UI_BLOCK}`;
    expect(parseStreamingContent(reply).summary).toBe(reply);
  });

  it('keeps a still-open fence mid-stream', () => {
    const reply = 'Working on it\n```ui\n{"id":"a","type":"Ca';
    expect(parseStreamingContent(reply).summary).toBe(reply);
  });

  it('still drops think blocks', () => {
    const parsed = parseStreamingContent(`<think>plan</think>${UI_BLOCK}`);
    expect(parsed.summary).toBe(UI_BLOCK);
  });

  it('leaves legacy envelope parsing alone for replies without a ui fence', () => {
    const parsed = parseStreamingContent(
      '```json\n{"summary":"hello","keypoints":"- a\\n- b"}\n```',
    );
    expect(parsed.summary).toBe('hello');
    expect(parsed.keypoints).toEqual(['a', 'b']);
  });

  it('does not treat other languages or inline mentions as a ui fence', () => {
    const parsed = parseStreamingContent('Use the ```ui``` fence\n```json\n{"summary":"x"}\n```');
    expect(parsed.summary).toBe('x');
  });
});
