// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RoleSelect } from './role-select';

const options = () => screen.getAllByRole('option').map((o) => o.textContent);

describe('RoleSelect', () => {
  it('offers every role to owners', () => {
    render(<RoleSelect id="r" actorRole="owner" value="viewer" onChange={vi.fn()} />);
    expect(options()).toEqual(['Owner', 'Admin', 'Operator', 'Analyst', 'Viewer']);
  });

  it('offers only roles at or below an admin', () => {
    render(<RoleSelect id="r" actorRole="admin" value="viewer" onChange={vi.fn()} />);
    expect(options()).toEqual(['Admin', 'Operator', 'Analyst', 'Viewer']);
  });

  it('reports the chosen role', async () => {
    const onChange = vi.fn();
    render(<RoleSelect id="r" actorRole="owner" value="viewer" onChange={onChange} />);
    await userEvent.selectOptions(screen.getByRole('combobox'), 'analyst');
    expect(onChange).toHaveBeenCalledWith('analyst');
  });
});
