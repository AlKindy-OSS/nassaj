# Contributing to CloudCLI UI

Thanks for your interest in contributing to CloudCLI UI! Before you start, please take a moment to read through this guide.

## Before You Start

- **Search first.** Check [existing issues](https://github.com/siteboon/claudecodeui/issues) and [pull requests](https://github.com/siteboon/claudecodeui/pulls) to avoid duplicating work.
- **Discuss first** for new features. Open an [issue](https://github.com/siteboon/claudecodeui/issues/new) to discuss your idea before investing time in implementation. We may already have plans or opinions on how it should work.
- **Bug fixes are always welcome.** If you spot a bug, feel free to open a PR directly.

## Prerequisites

- [Node.js](https://nodejs.org/) 22 or later
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and configured

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/<your-username>/claudecodeui.git
   cd claudecodeui
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the development server:
   ```bash
   npm run dev
   ```
5. Create a branch for your changes:
   ```bash
   git checkout -b feat/your-feature-name
   ```

## Project Structure

```
claudecodeui/
├── src/              # React frontend (Vite + Tailwind)
│   ├── components/   # UI components
│   ├── contexts/     # React context providers
│   ├── hooks/        # Custom React hooks
│   ├── i18n/         # Internationalization and translations
│   ├── lib/          # Shared frontend libraries
│   ├── types/        # TypeScript type definitions
│   └── utils/        # Frontend utilities
├── server/           # Express backend
│   ├── routes/       # API route handlers
│   ├── middleware/    # Express middleware
│   ├── database/     # SQLite database layer
│   └── tools/        # CLI tool integrations
├── shared/           # Code shared between client and server
└── public/           # Static assets, icons, PWA manifest
```

## Development Workflow

- `npm run dev` — Start both the frontend and backend in development mode
- `npm run build` — Create a production build
- `npm run server` — Start only the backend server
- `npm run client` — Start only the Vite dev server

## Making Changes

### Bug Fixes

- Reference the issue number in your PR if one exists
- Describe how to reproduce the bug in your PR description
- Add a screenshot or recording for visual bugs

### New Features

- Keep the scope focused — one feature per PR
- Include screenshots or recordings for UI changes

### Documentation

- Documentation improvements are always welcome
- Keep language clear and concise

## Commit Convention

We follow [Conventional Commits](https://conventionalcommits.org/) to generate release notes automatically. Every commit message should follow this format:

```
<type>(optional scope): <description>
```

Use imperative, present tense: "add feature" not "added feature" or "adds feature".

### Types

| Type | Description |
|------|-------------|
| `feat` | A new feature |
| `fix` | A bug fix |
| `perf` | A performance improvement |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `docs` | Documentation only |
| `style` | CSS, formatting, visual changes |
| `chore` | Maintenance, dependencies, config |
| `ci` | CI/CD pipeline changes |
| `test` | Adding or updating tests |
| `build` | Build system changes |

### Examples

```bash
feat: add conversation search
feat(i18n): add Japanese language support
fix: redirect unauthenticated users to login
fix(editor): syntax highlighting for .env files
perf: lazy load code editor component
refactor(chat): extract message list component
docs: update API configuration guide
```

### Breaking Changes

Add `!` after the type or include `BREAKING CHANGE:` in the commit footer:

```bash
feat!: redesign settings page layout
```

## Pull Requests

- Give your PR a clear, descriptive title following the commit convention above
- Fill in the PR description with what changed and why
- Link any related issues
- Include screenshots for UI changes
- Make sure the build passes (`npm run build`)
- Keep PRs focused — avoid unrelated changes

## Versioning

Four levels, from the largest change to the smallest. The version in
`package.json` is the single source of truth; the UI, `/status` and the git tag
all read it.

| Level | Shape | When |
|---|---|---|
| Major batch of changes | `X.n` → e.g. `1.36` → `1.37` | many changes at once, a reworked area, anything an operator should read release notes before taking |
| Small feature | `X.x.n` → e.g. `1.36.0` → `1.36.1` | one new capability that does not change how anything existing behaves |
| Bug fix | `X.x.0.n` → e.g. `1.36.0` → `1.36.0.1` | a fix to already-released behavior, with no new capability |

The fourth segment exists so a fix is never mistaken for a feature. It resets
whenever any segment to its left moves: `1.36.0.3` + a small feature → `1.36.1`,
and the next fix on top of that is `1.36.1.1`.

Two consequences worth knowing before you reach for tooling:

- **`release-it` and `npm publish` assume three-segment SemVer.** A four-segment
  version is accepted by `npm install` for this (private, unpublished) package
  and compares correctly in the client's version check, which walks the dot
  segments numerically. If this package is ever published to a registry, drop
  the fourth segment for that publish rather than renaming the scheme.
- **Bump the version in the same commit as the change it describes**, so a
  deployed node's `/status` names exactly the code it is running.

## Releases

Releases are managed by maintainers using [release-it](https://github.com/release-it/release-it) with the [conventional changelog plugin](https://github.com/release-it/conventional-changelog).

```bash
npm run release           # interactive (prompts for version bump)
npm run release -- patch  # patch release
npm run release -- minor  # minor release
```

This automatically:
- Bumps the version based on commit types (`feat` = minor, `fix` = patch)
- Generates categorized release notes
- Updates `CHANGELOG.md`
- Creates a git tag and GitHub Release
- Publishes to npm

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0-or-later License](LICENSE), including the additional terms specified in Section 7 of the LICENSE file.