// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '@/app';
import { createQueryClient } from '@/lib/query-client';
import { ActivityController } from '@/session/activity-controller';
import { SessionProvider } from '@/session/session-provider';
import { FakeClock } from '@/test/fake-clock';
import { activeStatus, dormantStatus } from '@/test/fixtures';

function renderAt(path: string, status = activeStatus()) {
  const controller = new ActivityController({
    clock: new FakeClock(),
    api: {
      start: () => Promise.resolve(status),
      ping: () => Promise.resolve(status),
    },
  });
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <SessionProvider controller={controller}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe('app shell routes', () => {
  beforeEach(() => {
    // The dashboard fetches its data; the answer does not matter here.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 500 }))),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders the dashboard at /', async () => {
    renderAt('/');
    expect(screen.getByRole('link', { name: /GTFS-RT Debugger/ })).toHaveAttribute('href', '/');
    expect(
      screen.getByRole('heading', { name: /Active trips with realtime data/ }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Live')).toBeInTheDocument();
  });

  it('renders the trip screen with the decoded trip ID and a way back', () => {
    renderAt('/trips/route%2F12%20A');
    expect(screen.getByText('Trip route/12 A')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dashboard/ })).toHaveAttribute('href', '/');
  });

  it('shows the session banner above the page', async () => {
    renderAt('/', dormantStatus('max-duration'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Session ended');
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument();
  });

  it('renders not-found for unknown paths', () => {
    renderAt('/nope');
    expect(screen.getByText('Page not found')).toBeInTheDocument();
  });
});
