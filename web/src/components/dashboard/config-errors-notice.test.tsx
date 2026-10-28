// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ConfigErrorsNotice } from './config-errors-notice';

const errors: Parameters<typeof ConfigErrorsNotice>[0]['errors'] & object = {
  total: 3,
  items: [
    {
      code: 'mixed_exact_times',
      tripId: 'mixed-1',
      message: 'Frequency rows mix exact_times 1 and 0.',
    },
    { code: 'unusable_stop_times', tripId: 'bad-times', message: 'The last stop has no time.' },
    { code: 'frequency_too_dense', tripId: 'dense', message: 'A row allows over 2000 instances.' },
  ],
};

function renderNotice(value: Parameters<typeof ConfigErrorsNotice>[0]['errors']) {
  return render(
    <MemoryRouter>
      <ConfigErrorsNotice errors={value} />
    </MemoryRouter>,
  );
}

describe('ConfigErrorsNotice', () => {
  it('is hidden when there are no errors, or the schedule is not ready', () => {
    const { container, rerender } = renderNotice({ total: 0, items: [] });
    expect(container).toBeEmptyDOMElement();
    rerender(
      <MemoryRouter>
        <ConfigErrorsNotice errors={null} />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('states the number of errors and that the trips are excluded', () => {
    renderNotice(errors);
    expect(screen.getByRole('alert')).toHaveTextContent(
      '3 schedule configuration errors: the trips concerned are excluded from the counts and lists',
    );
  });

  it('counts errors, not trips: one trip with two codes is two errors', () => {
    renderNotice({
      total: 2,
      items: [
        { code: 'mixed_exact_times', tripId: 'twice', message: 'one' },
        { code: 'unusable_stop_times', tripId: 'twice', message: 'two' },
      ],
    });
    expect(screen.getByRole('alert')).toHaveTextContent('2 schedule configuration errors');
  });

  it('uses the singular for one error', () => {
    renderNotice({ total: 1, items: errors.items.slice(0, 1) });
    expect(screen.getByRole('alert')).toHaveTextContent('1 schedule configuration error:');
  });

  it('expands to each trip with its message and a link to the trip', async () => {
    renderNotice(errors);
    expect(screen.queryByText('mixed-1')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /show the trips/i }));

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByRole('link', { name: 'mixed-1' })).toHaveAttribute(
      'href',
      '/trips/mixed-1',
    );
    expect(items[0]).toHaveTextContent('Frequency rows mix exact_times 1 and 0.');
    expect(items[1]).toHaveTextContent('The last stop has no time.');
    expect(items[2]).toHaveTextContent('A row allows over 2000 instances.');
    expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument();
  });

  it('notes when more errors exist than the items returned', async () => {
    renderNotice({ total: 250, items: errors.items.slice() });
    await userEvent.click(screen.getByRole('button', { name: /show the trips/i }));
    expect(screen.getByText('Showing the first 3 of 250 errors.')).toBeInTheDocument();
  });
});
