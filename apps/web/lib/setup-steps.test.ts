import { describe, expect, it } from 'vitest';
import { buildSetupSteps } from './setup-steps';

const base = { orgId: 'o1', productId: 'p1', environments: 0, agents: 0, canManage: true };

describe('buildSetupSteps', () => {
  it('lists the whole path to monitoring, in order', () => {
    expect(buildSetupSteps(base).map((s) => s.id)).toEqual([
      'environments',
      'servers',
      'google',
      'databases',
      'aws',
      'code-and-cloud',
      'websites',
      'team',
    ]);
  });

  it('marks environments done once one exists', () => {
    expect(buildSetupSteps(base)[0]!.status).toBe('todo');
    expect(buildSetupSteps({ ...base, environments: 1 })[0]!.status).toBe('done');
  });

  it('links the servers step to Agents and marks it done once an agent exists', () => {
    const servers = (agents: number) => buildSetupSteps({ ...base, agents }).find((s) => s.id === 'servers')!;
    expect(servers(0)).toMatchObject({
      status: 'todo',
      href: '/orgs/o1/products/p1/agents',
      actionLabel: 'Add server',
    });
    expect(servers(1).status).toBe('done');
  });

  it('marks unbuilt steps as coming soon, without a link', () => {
    for (const step of buildSetupSteps(base).filter(
      (s) => !['environments', 'servers', 'aws', 'team'].includes(s.id),
    )) {
      expect(step.status, step.id).toBe('soon');
      expect(step.href, step.id).toBeUndefined();
    }
  });

  it('links the team step to members', () => {
    expect(buildSetupSteps(base).at(-1)).toMatchObject({ status: 'todo', href: '/orgs/o1/members' });
  });

  it('every step says what it collects', () => {
    for (const step of buildSetupSteps(base)) expect(step.collects.length, step.id).toBeGreaterThan(10);
  });
});
