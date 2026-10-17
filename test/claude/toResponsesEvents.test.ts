// Claude Messages SSE -> OpenAI Responses events. Fixtures mirror the streaming event flow
// documented for api.anthropic.com/v1/messages and the block/delta names found in the pinned
// official release 2.1.299 (thinking_delta, signature_delta, input_json_delta, redacted_thinking).
import { describe, expect, it, vi } from 'vitest';
import { translateClaudeStream, toResponsesUsage } from '../../src/claude/toResponsesEvents.js';
import type { Json, ResponsesEvent } from '../../src/types.js';
import { parseSseStream } from '../../src/utils/sse.js';
import { readFixture, toByteChunks } from '../helpers.js';

const META = { id: 'resp_test', model: 'claude-sonnet-5', created: 1700000000 };

type SaveState = (nativeContent: Json[], callIds: string[]) => Promise<void>;

const collectEvents = async (events: AsyncIterable<ResponsesEvent>, saveState?: SaveState): Promise<ResponsesEvent[]> => {
  const collected: ResponsesEvent[] = [];
  for await (const event of translateClaudeStream({ events, meta: META, saveState })) {
    collected.push(event);
  }
  return collected;
};

const collect = (text: string, saveState?: SaveState): Promise<ResponsesEvent[]> => collectEvents(parseSseStream(toByteChunks(text)), saveState);

const fromEvents = (events: ResponsesEvent[], saveState?: SaveState): Promise<ResponsesEvent[]> => collectEvents(
  (async function* toStream() {
    yield* events;
  })(),
  saveState,
);

describe('toResponsesUsage', () => {
  it('folds the Claude cache counters into input_tokens', () => {
    expect(
      toResponsesUsage({ input_tokens: 12, cache_creation_input_tokens: 300, cache_read_input_tokens: 1200, output_tokens: 17 }),
    ).toEqual({
      input_tokens: 1512,
      input_tokens_details: { cached_tokens: 1200 },
      output_tokens: 17,
      total_tokens: 1529,
    });
  });

  it('reports thinking tokens as reasoning tokens when upstream sends them', () => {
    expect(toResponsesUsage({ input_tokens: 1, output_tokens: 5, thinking_tokens: 3 })?.output_tokens_details).toEqual({
      reasoning_tokens: 3,
    });
  });
});

describe('translateClaudeStream', () => {
  it('maps a text message into the OpenAI Responses event sequence', async () => {
    const events = await collect(readFixture('claude-text.sse'));
    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events.map((event) => event.sequence_number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const created = events[0]?.response as Json;
    expect(created.id).toBe('resp_test');
    expect(created.status).toBe('in_progress');
    const completed = events.at(-1)?.response as Json;
    expect(completed.status).toBe('completed');
    expect(completed.usage).toEqual({
      input_tokens: 1512,
      input_tokens_details: { cached_tokens: 1200 },
      output_tokens: 17,
      total_tokens: 1529,
    });
    expect((completed.output as Json[])[0]?.content).toEqual([
      { type: 'output_text', text: 'Hello there.', annotations: [], logprobs: [] },
    ]);
    // Delta values are the actual strings the client appends, not the native delta objects.
    const textDeltas = events.filter((event) => event.type === 'response.output_text.delta');
    expect(textDeltas.map((event) => event.delta)).toEqual(['Hello', ' there.']);
    expect(textDeltas.every((event) => typeof event.delta === 'string')).toBe(true);
  });

  it('emits a start-carried text block exactly once: empty part added, then one delta', async () => {
    const events = await collect(readFixture('claude-text-tool.sse'));
    const addedParts = events.filter((event) => event.type === 'response.content_part.added');
    expect(addedParts.every((event) => ((event.part as Json).text as string) === '')).toBe(true);
    const textDeltas = events.filter((event) => event.type === 'response.output_text.delta');
    expect(textDeltas.map((event) => event.delta)).toEqual(['Before tool.', 'After tool.']);
    const doneParts = events.filter((event) => event.type === 'response.content_part.done');
    expect(doneParts.map((event) => ((event.part as Json).text as string))).toEqual(['Before tool.', 'After tool.']);
  });

  it('exposes tool calls with the Claude tool_use id as call_id', async () => {
    const events = await collect(readFixture('claude-tool-call.sse'));
    const added = events.filter((event) => event.type === 'response.output_item.added');
    expect(added.map((event) => (event.item as Json).type)).toEqual(['reasoning', 'function_call']);
    const toolItem = added[1]?.item as Json;
    expect(toolItem.call_id).toBe('toolu_01XYZ7Qm');
    expect(toolItem.name).toBe('get_weather');
    const argumentDeltas = events.filter((event) => event.type === 'response.function_call_arguments.delta');
    expect(argumentDeltas.map((event) => event.delta).join('')).toBe('{"city":"Paris"}');
    const done = events.find((event) => event.type === 'response.output_item.done' && (event.item as Json).type === 'function_call')?.item as Json;
    expect(done.arguments).toBe('{"city":"Paris"}');
    expect(done.status).toBe('completed');
  });

  it('keeps thinking out of the client stream but persists it for replay', async () => {
    const saved: Array<{ nativeContent: Json[]; callIds: string[] }> = [];
    const events = await collect(readFixture('claude-tool-call.sse'), async (nativeContent, callIds) => {
      saved.push({ nativeContent, callIds });
    });
    expect(events.some((event) => JSON.stringify(event).includes('I should call the weather tool.'))).toBe(false);
    expect(saved[0]?.callIds).toEqual(['toolu_01XYZ7Qm']);
    expect(saved[0]?.nativeContent[0]).toEqual({
      type: 'thinking',
      thinking: 'I should call the weather tool.',
      signature: 'Eq4KCmUIhAIKEGN2eA5xkQ2SgBACQo1K7',
    });
    expect(saved[0]?.nativeContent[1]).toEqual({
      type: 'tool_use',
      id: 'toolu_01XYZ7Qm',
      name: 'get_weather',
      input: { city: 'Paris' },
    });
  });

  it('does not persist state for a turn without tool calls', async () => {
    const saveState = vi.fn();
    await collect(readFixture('claude-text.sse'), saveState);
    expect(saveState).not.toHaveBeenCalled();
  });

  it('maps max_tokens to an incomplete response', async () => {
    const events = await collect(readFixture('claude-max-tokens.sse'));
    const completed = events.at(-1);
    expect(completed?.type).toBe('response.incomplete');
    expect((completed?.response as Json).status).toBe('incomplete');
    expect((completed?.response as Json).incomplete_details).toEqual({ reason: 'max_output_tokens' });
  });

  it('maps a refusal to a content_filter incomplete response', async () => {
    const events = await collect(readFixture('claude-refusal.sse'));
    const terminal = events.at(-1);
    expect(terminal?.type).toBe('response.incomplete');
    expect((terminal?.response as Json).incomplete_details).toEqual({ reason: 'content_filter' });
  });

  it('keeps parallel tool calls separate and rejoins split argument chunks', async () => {
    const saved: Json[][] = [];
    const events = await collect(readFixture('claude-parallel-tools.sse'), async (nativeContent) => {
      saved.push(nativeContent);
    });
    const added = events.filter((event) => event.type === 'response.output_item.added');
    expect(added.map((event) => (event.item as Json).call_id)).toEqual(['toolu_01FIRST', 'toolu_01SECOND']);
    const done = events.filter((event) => event.type === 'response.function_call_arguments.done');
    expect(done.map((event) => event.arguments)).toEqual(['{"city":"Osaka"}', '{"zone":"Japan"}']);
    // One atomic save of the COMPLETE turn at message_stop: no partial record is ever written,
    // and both tool completions are deferred until that save succeeded.
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual([
      { type: 'tool_use', id: 'toolu_01FIRST', name: 'get_weather', input: { city: 'Osaka' } },
      { type: 'tool_use', id: 'toolu_01SECOND', name: 'get_time', input: { zone: 'Japan' } },
    ]);
  });

  it('keeps redacted_thinking data out of the client stream but stores it whole', async () => {
    const saved: Json[][] = [];
    const events = await collect(readFixture('claude-redacted-thinking.sse'), async (nativeContent) => {
      saved.push(nativeContent);
    });
    const raw = JSON.stringify(events);
    expect(raw).not.toContain('EpQCCnEIhAIKEOCmQ4TnZ9sGEAEiA1lDZmFrZS1yZWRhY3RlZC1jaGFpbhQo5Lq6');
    expect(saved[0]?.[0]).toEqual({
      type: 'redacted_thinking',
      data: 'EpQCCnEIhAIKEOCmQ4TnZ9sGEAEiA1lDZmFrZS1yZWRhY3RlZC1jaGFpbhQo5Lq6',
    });
  });

  it('fails explicitly on known unsupported semantic blocks', async () => {
    await expect(
      fromEvents([
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: {} } },
        { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} } },
      ]),
    ).rejects.toThrow('unsupported content block type "server_tool_use"');
  });

  it('tolerates block types newer than the modelled set instead of failing the turn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const events = await fromEvents([
      { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'quantum_flux_state', flux: 'new' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]);
    expect(events.map((event) => event.type)).toContain('response.output_item.added');
    expect((events[2]?.item as Json).type).toBe('reasoning');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('quantum_flux_state'));
  });

  it('accumulates compaction deltas into the stored block', async () => {
    const saved: Json[][] = [];
    await fromEvents(
      [
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: {} } },
        { type: 'content_block_start', index: 0, content_block: { type: 'compaction', content: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'compaction_delta', content: 'summary', encrypted_content: 'enc' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'now', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ],
      async (nativeContent) => {
        saved.push(nativeContent);
      },
    );
    expect(saved[0]?.[0]).toEqual({ type: 'compaction', content: 'summary', encrypted_content: 'enc' });
  });

  it('fails on a delta type it cannot interpret', async () => {
    await expect(
      fromEvents([
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: {} } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'mystery_delta', text: 'x' } },
      ]),
    ).rejects.toThrow('Unknown Claude delta type: mystery_delta');
  });

  it('fails when the upstream stream ends before message_stop', async () => {
    await expect(collect(readFixture('claude-broken-stream.sse'))).rejects.toThrow('Claude stream ended before message_stop');
  });

  it('fails when the stream never starts', async () => {
    await expect(collect('event: ping\ndata: {"type":"ping"}\n\n')).rejects.toThrow('Claude stream ended before message_stop');
  });

  it('fails on an upstream error event without claiming completion', async () => {
    const seen: ResponsesEvent[] = [];
    let failure: Error | undefined;
    try {
      for await (const event of translateClaudeStream({ events: parseSseStream(toByteChunks(readFixture('claude-error.sse'))), meta: META })) {
        seen.push(event);
      }
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toBe('Overloaded');
    expect(seen.some((event) => event.type === 'response.output_text.delta')).toBe(true);
    expect(seen.some((event) => event.type === 'response.completed')).toBe(false);
  });

  it('rejects deltas for unknown content blocks instead of guessing', async () => {
    await expect(
      fromEvents([
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: {} } },
        { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'x' } },
      ]),
    ).rejects.toThrow('content block that was never opened');
  });

  it('rejects a content block opened out of order', async () => {
    await expect(
      fromEvents([
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: {} } },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      ]),
    ).rejects.toThrow('out of order');
  });

  it('rejects a second delta or stop for a block that already closed', async () => {
    const closed = [
      { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_stop', index: 0 },
    ];
    await expect(fromEvents([...closed, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }])).rejects.toThrow(
      'already closed content block',
    );
    await expect(fromEvents([...closed, { type: 'content_block_stop', index: 0 }])).rejects.toThrow('already closed content block');
  });

  it('rejects a delta kind that does not match the block', async () => {
    await expect(
      fromEvents([
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: {} } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      ]),
    ).rejects.toThrow('input_json_delta" delta for a message content block');
  });

  it('rejects a tool_use block without an id', async () => {
    await expect(
      fromEvents([
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: {} } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'x', input: {} } },
      ]),
    ).rejects.toThrow('tool_use block without an id');
  });

  it('rejects message_delta while a block is still open and without a stop reason', async () => {
    await expect(
      fromEvents([
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: {} } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      ]),
    ).rejects.toThrow('content block still open');
    await expect(
      fromEvents([
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: {} } },
        { type: 'message_delta', delta: {} },
      ]),
    ).rejects.toThrow('unknown stop_reason');
  });

  it('rejects message_stop without message_delta and a second message_start', async () => {
    await expect(
      fromEvents([
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: {} } },
        { type: 'message_stop' },
      ]),
    ).rejects.toThrow('ended without message_delta');
    await expect(
      fromEvents([
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: {} } },
        { type: 'message_start', message: { id: 'msg_2', usage: {} } },
      ]),
    ).rejects.toThrow('message_start twice');
  });

  it('keeps the message_start counters that message_delta does not repeat', async () => {
    // Supervisor stream probe: message_delta only carries the cumulative output counter.
    const events = await fromEvents([
      {
        type: 'message_start',
        message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: { input_tokens: 10, cache_creation_input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 1 } },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_test', name: 'test', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ]);
    expect((events.at(-1)?.response as Json).usage).toEqual({
      input_tokens: 15,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens: 4,
      total_tokens: 19,
    });
  });

  it('persists tool state before the tool item is reported complete', async () => {
    // Supervisor stream probe: a failed state write must not expose a tool call the next turn
    // could not replay.
    const emitted: ResponsesEvent[] = [];
    let failure: Error | undefined;
    try {
      for await (const event of translateClaudeStream({
        events: (async function* toStream() {
          yield* readClaudeEvents();
        })(),
        meta: META,
        saveState: async () => {
          throw new Error('state write failed');
        },
      })) {
        emitted.push(event);
      }
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toBe('state write failed');
    expect(emitted.map((event) => event.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.function_call_arguments.delta',
    ]);
    expect(emitted.some((event) => event.type === 'response.output_item.done')).toBe(false);
    expect(emitted.some((event) => event.type === 'response.function_call_arguments.done')).toBe(false);
  });

  it('leaves no completed tool and no record when the stream dies after the first of two tools', async () => {
    // Review round 1 / B: an early upstream error between tools must not expose tool a as a
    // replayable half-turn; the only save happens at a validated message_stop.
    const saved: Json[][] = [];
    const completed: string[] = [];
    let failure: Error | undefined;
    try {
      for await (const event of translateClaudeStream({
        events: (async function* toStream() {
          yield validStart;
          yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_a', name: 'first', input: {} } };
          yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } };
          yield { type: 'content_block_stop', index: 0 };
          throw new Error('upstream closed the stream');
        })(),
        meta: META,
        saveState: async (content) => {
          saved.push(content);
        },
      })) {
        if (event.type === 'response.output_item.done' && (event.item as Json).type === 'function_call') completed.push(String((event.item as Json).call_id));
      }
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toBe('upstream closed the stream');
    expect(completed).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('fails instead of repairing malformed tool arguments', async () => {
    // Supervisor stream probe: `{"x":` is not repaired into `{}` and does not complete.
    const emitted: ResponsesEvent[] = [];
    let failure: (Error & { status?: number }) | undefined;
    try {
      for await (const event of translateClaudeStream({ events: (async function* toStream() { yield* readClaudeEvents('{"x":'); })(), meta: META })) {
        emitted.push(event);
      }
    } catch (error) {
      failure = error as Error & { status?: number };
    }
    expect(failure?.status).toBe(502);
    expect(failure?.message).toContain('invalid tool arguments');
    expect(emitted.some((event) => event.type === 'response.completed')).toBe(false);
  });

  const validStart: ResponsesEvent = { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: { input_tokens: 1, output_tokens: 1 } } };
  const endTurn: ResponsesEvent[] = [
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];

  it('seeds the accumulator from nonempty content_block_start text', async () => {
    // Supervisor stream-validation probe: start-carried text must not become empty output.
    const events = await fromEvents([
      validStart,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Hello from start' } },
      { type: 'content_block_stop', index: 0 },
      ...endTurn,
    ]);
    const terminal = events.at(-1)?.response as Json;
    expect((terminal.output as Json[])[0]?.content).toEqual([
      { type: 'output_text', text: 'Hello from start', annotations: [], logprobs: [] },
    ]);
  });

  it('keeps a nonempty tool input carried by content_block_start', async () => {
    // Supervisor stream-validation probe: native input {x:1} must not collapse to {}.
    const saved: Json[][] = [];
    const events = await fromEvents(
      [
        validStart,
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_a', name: 'lookup', input: { x: 1 } } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ],
      async (nativeContent) => {
        saved.push(nativeContent);
      },
    );
    const terminal = events.at(-1)?.response as Json;
    expect((terminal.output as Json[])[0]).toMatchObject({ call_id: 'toolu_a', arguments: '{"x":1}' });
    expect(saved[0]?.[0]).toMatchObject({ type: 'tool_use', id: 'toolu_a', input: { x: 1 } });
  });

  it('rejects message_start without required message fields', async () => {
    // Supervisor stream-validation probe: message:{} must not be accepted.
    await expect(fromEvents([{ type: 'message_start', message: {} }, ...endTurn])).rejects.toThrow('message_start has no message id');
  });

  it('rejects a tool_use block without a name', async () => {
    // Supervisor stream-validation probe: name must not default to "".
    await expect(
      fromEvents([
        validStart,
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_a', input: {} } },
      ]),
    ).rejects.toThrow('without a name');
  });

  it('rejects a content block started after message_delta', async () => {
    // Supervisor stream-validation probe: no new blocks after the terminal delta.
    await expect(
      fromEvents([validStart, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'message_stop' }]),
    ).rejects.toThrow('content block after message_delta');
  });

  it('rejects a second message_stop instead of emitting two terminals', async () => {
    // Supervisor stream-validation probe: duplicate terminal must fail.
    const events: ResponsesEvent[] = [];
    let failure: Error | undefined;
    try {
      for await (const event of translateClaudeStream({ events: (async function* toStream() { yield* [validStart, ...endTurn, { type: 'message_stop' }]; })(), meta: META })) {
        events.push(event);
      }
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toContain('after message_stop');
    expect(events.filter((event) => event.type === 'response.completed')).toHaveLength(1);
  });

  it('rejects a reused tool_use id and malformed delta fields', async () => {
    await expect(
      fromEvents([
        validStart,
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_a', name: 'one', input: {} } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_a', name: 'two', input: {} } },
      ]),
    ).rejects.toThrow('reused the tool_use id');
    await expect(
      fromEvents([
        validStart,
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 42 } },
      ]),
    ).rejects.toThrow('text_delta without string text');
  });

  it('defers every tool completion until the full native turn is saved', async () => {
    // Supervisor partial-state probe: when the single full-turn save fails, no tool may look
    // completed and no partial record may exist.
    const saved: Json[][] = [];
    const completed: (string | undefined)[] = [];
    let failure: Error | undefined;
    try {
      for await (const event of translateClaudeStream({
        events: (async function* toStream() {
          yield* [
            validStart,
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'test', signature: 'fake-test-signature' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_a', name: 'first', input: {} } },
            { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
            { type: 'content_block_stop', index: 1 },
            { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_b', name: 'second', input: {} } },
            { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } },
            { type: 'content_block_stop', index: 2 },
            { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
            { type: 'message_stop' },
          ];
        })(),
        meta: META,
        saveState: async (content) => {
          if (content.filter((block) => block.type === 'tool_use').length === 2) throw new Error('cannot persist full assistant turn');
          saved.push(content);
        },
      })) {
        if (event.type === 'response.output_item.done' && (event.item as Json).type === 'function_call') completed.push(String((event.item as Json).call_id));
      }
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toBe('cannot persist full assistant turn');
    expect(completed).toEqual([]);
    expect(saved).toEqual([]);
  });
});

const readClaudeEvents = (argumentsJson = '{"x":1}'): ResponsesEvent[] => [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_test', name: 'test', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: argumentsJson } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
  { type: 'message_stop' },
];
