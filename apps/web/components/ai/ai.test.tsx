// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiSettingsCard } from './ai-settings-card';
import { Answer, type AnswerData } from './answer';
import { Chat, type AskHandlers } from './chat';

afterEach(cleanup);

const answer = (over: Partial<AnswerData> = {}): AnswerData => ({
  text: 'Finding 1 (confidence: medium): CPU on vps-1 peaked at 97.3 % [E2].\nMissing evidence: deployments.',
  evidence: [
    {
      id: 'E1',
      tool: 'getIncidents',
      status: 'ok',
      gaps: [],
      sources: [{ label: 'Incident: CPU high', href: '/i/1' }],
      data: {},
    },
    {
      id: 'E2',
      tool: 'getInfrastructureMetrics',
      status: 'ok',
      gaps: [],
      sources: [{ label: 'Infrastructure', href: '/infra' }],
      data: { hosts: [] },
    },
  ],
  missing: ['Deployments: source not connected'],
  confidence: 'medium',
  validation: 'verified',
  problems: [],
  ...over,
});

describe('Answer (WB-14 §8)', () => {
  it('turns citations into chips that open the evidence panel with source links', async () => {
    const user = userEvent.setup();
    render(<Answer data={answer()} />);
    expect(screen.getByText('Confidence: medium')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Evidence E2' }));
    const panel = screen.getByRole('region', { name: 'Evidence E2' });
    expect(panel).toHaveTextContent('Host metrics');
    expect(within(panel).getByRole('link', { name: 'Infrastructure' })).toHaveAttribute('href', '/infra');
    expect(screen.getByRole('list', { name: 'Missing evidence' })).toHaveTextContent(
      'Deployments: source not connected',
    );
  });

  it('warns about unverified and partial answers', () => {
    const { rerender } = render(
      <Answer
        data={answer({ validation: 'unverified', problems: ['99.1 does not appear in the evidence'] })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/not verified/);
    expect(screen.getByRole('alert')).toHaveTextContent('99.1 does not appear in the evidence');
    rerender(<Answer data={answer({ validation: 'partial' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/incomplete/);
  });
});

function fakeAsk() {
  let h: AskHandlers | null = null;
  const ask = vi.fn((_content: string, handlers: AskHandlers) => {
    h = handlers;
    return () => {};
  });
  return {
    ask,
    emit: (event: string, data: unknown) => act(() => h!.onEvent(event, data)),
    close: () => act(() => h!.onClose()),
  };
}

describe('Chat (UC-14-01)', () => {
  it('shows each tool step while it runs, then the answer', async () => {
    const user = userEvent.setup();
    const f = fakeAsk();
    render(<Chat messages={[]} ask={f.ask} onDone={vi.fn()} />);
    await user.type(screen.getByLabelText('Ask about this product'), 'Why was it slow yesterday?');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(f.ask).toHaveBeenCalledWith('Why was it slow yesterday?', expect.anything());
    expect(screen.getByText('Why was it slow yesterday?')).toBeInTheDocument();
    f.emit('tool', { tool: 'getIncidents', evidenceId: 'E1', status: 'running' });
    expect(screen.getByText('Checking incidents…')).toBeInTheDocument();
    f.emit('tool', { tool: 'getIncidents', evidenceId: 'E1', status: 'ok' });
    expect(screen.getByText('Checked incidents')).toBeInTheDocument();
    f.emit('answer', answer());
    f.emit('done', {});
    expect(screen.getByText(/peaked at 97.3 %/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask' })).toBeEnabled();
  });

  it('shows a stream error and lets the user try again', async () => {
    const user = userEvent.setup();
    let h: AskHandlers | null = null;
    const ask = vi.fn((_c: string, handlers: AskHandlers) => {
      h = handlers;
      return () => {};
    });
    render(<Chat messages={[]} ask={ask} onDone={vi.fn()} />);
    await user.type(screen.getByLabelText('Ask about this product'), 'Hi');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    act(() => h!.onError('The AI assistant is turned off for this organization'));
    expect(screen.getByRole('alert')).toHaveTextContent('turned off');
    expect(screen.getByRole('button', { name: 'Ask' })).toBeEnabled();
  });
});

describe('Chat stream errors', () => {
  it('shows an error event from the server and ends the turn', async () => {
    const user = userEvent.setup();
    const f = fakeAsk();
    render(<Chat messages={[]} ask={f.ask} onDone={vi.fn()} />);
    await user.type(screen.getByLabelText('Ask about this product'), 'Hi');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    f.emit('error', { message: 'The investigation failed; please try again.' });
    expect(screen.getByRole('alert')).toHaveTextContent('The investigation failed');
    expect(screen.getByRole('button', { name: 'Ask' })).toBeEnabled();
  });
});

describe('AiSettingsCard (UC-14-06)', () => {
  it('shows the provider and turns AI off', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(
      <AiSettingsCard
        settings={{ disabled: false, available: true, provider: 'gemini>groq', model: 'gemini-2.5-flash' }}
        onChange={onChange}
      />,
    );
    expect(screen.getByText(/gemini-2.5-flash/)).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'AI assistant' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('explains when the platform has no provider', () => {
    render(
      <AiSettingsCard
        settings={{ disabled: false, available: false, provider: null, model: null }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/No AI provider is configured/)).toBeInTheDocument();
  });
});
