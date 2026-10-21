# ADR 0002: Toolchain and version floors

Status: Proposed
Date: 2026-10-22
Deciders: tech lead

## Context

Global constraints require exact pinned versions and reproducible builds. Newer majors exist (TypeScript 7, Vitest 5, NestJS 12, Next.js 16) but their APIs have not been validated for this codebase.

## Decision

- Runtime floors: Node.js 22, PostgreSQL 16 (images use 17.6), Redis 7.2 (images use 7.4.6), Go 1.23.
- Package manager: pnpm 9.15.9 through corepack (`packageManager` field). Turborepo 2.5.8.
- Language and test: TypeScript 5.9.3, Vitest 3.2.7, ESLint 9.39.5, typescript-eslint 8.40.0, Prettier 3.6.2.
- Frameworks: NestJS 11.2.7 on Fastify 5, Next.js 15.5.28, React 19.1.10, Zod 3.25.76.
- Container images pinned by tag in development and by digest in releases.
- No `^` or `~` ranges in any `package.json`; `pnpm-lock.yaml` is committed.

## Consequences

- Upgrades to newer majors are deliberate tasks with their own tests.
- Security patches inside a major are applied by bumping the exact version.

## References

- Master plan Global Constraints, §6.3; task M1.1
