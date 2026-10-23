export interface Dependent {
  name: string;
  type: string;
}

/** Dry-run impact (UC-16-04): what depends on the target in the asset graph. Never a cause claim. */
export function assessImpact(input: { action: string; dependents: Dependent[] }): {
  summary: string;
  dependents: Dependent[];
} {
  const { action, dependents } = input;
  return {
    summary: dependents.length
      ? `${action} may interrupt ${dependents.length} dependent${dependents.length === 1 ? '' : 's'}: ${dependents
          .map((d) => d.name)
          .join(', ')}.`
      : `${action} has no known dependents in the asset graph.`,
    dependents,
  };
}
