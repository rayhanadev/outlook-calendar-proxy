# CalProxy Development Guidelines

This document defines mandatory rules for all AI coding agents working on this codebase.

---

## Quality Gates (ALL MUST PASS)

Before any code is considered complete, it MUST pass all quality gates:

```bash
# 1. Type checking - zero errors allowed
bun run typecheck

# 2. Linting - zero errors allowed
bun run lint

# 3. Format check
bun run format
```

**NO EXCEPTIONS.** Code that fails any gate is not finished.

---

## Project Overview

CalProxy is a Cloudflare Worker that acts as a calendar reconciliation engine between Microsoft Outlook ICS feeds and Google Calendar. It normalizes ICS data to fix timezone issues, UID instability, and other incompatibilities.

### Tech Stack

| Component       | Technology         |
| --------------- | ------------------ |
| Runtime         | Cloudflare Workers |
| State           | Cloudflare KV      |
| Language        | TypeScript         |
| Package Manager | Bun                |

### Key Commands

```bash
bunx wrangler dev        # Local development
bunx wrangler deploy     # Deploy to Cloudflare
bun run lint             # Run oxlint
bun run format           # Format with biome
bun run typecheck        # Type check
```

---

## TypeScript Rules

### NEVER Use `any` or `unknown` as Type Escape Hatches

**NEVER use `any` or `unknown` to bypass type errors.** This is a hard rule with no exceptions.

#### When `unknown` IS allowed:

- Validation function entry points
- Catch block error parameters (`catch (error: unknown)`)

#### When `unknown` is NOT allowed:

- As a lazy replacement for defining proper types
- For function parameters where the type is knowable
- For return types that should be specific

```typescript
// WRONG - Never do this
const data = response as any;

// RIGHT - Use proper types
const data: ResponseData = response;
```

### Type Assertions

Avoid type assertions (`as Type`) unless absolutely necessary. When needed:

- Prefer `satisfies` operator for type checking without widening
- Document why the assertion is safe
- Never use `as any` or `as unknown as Type` chains

### Explicit Return Types

All public functions MUST have explicit return types:

```typescript
// WRONG
export function processCalendar(ics: string) {
	return parseIcs(ics);
}

// RIGHT
export function processCalendar(ics: string): ParsedCalendar {
	return parseIcs(ics);
}
```

---

## Forbidden Patterns

These patterns are NEVER allowed:

```typescript
// Type escape hatches
as any
as unknown as Type
@ts-ignore
@ts-expect-error

// Empty error handling
catch (e) {}
catch (e) { /* ignore */ }

// Lazy typing
items: any[]
data: object
config: {}
```

---

## File Naming Conventions

- Source files: `kebab-case.ts`
- Type files: `types.ts`
- Index files: `index.ts`

---

## Error Handling

### Error Propagation

- Let errors bubble up naturally
- Catch only when you can handle meaningfully
- Always preserve error context
- Log errors at the boundary, not everywhere

---

## Verification Checklist

Before marking ANY task complete:

- [ ] `bun run typecheck` passes with 0 errors
- [ ] `bun run lint` passes with 0 errors
- [ ] `bun run format` runs without issues
- [ ] No `any` types anywhere
- [ ] No `@ts-ignore` or `@ts-expect-error` comments
