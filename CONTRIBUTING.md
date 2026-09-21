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
| Major batch of changes | increment segment 2, e.g. `1.41.0.0` → `1.42.0.0` | many changes at once, a reworked area, anything an operator should read release notes before taking |
| Small feature | increment segment 3, e.g. `1.42.0.0` → `1.42.1.0` | one new capability that does not change how anything existing behaves |
| Bug fix | increment segment 4, e.g. `1.42.0.0` → `1.42.0.1` | a fix to already-released behavior, with no new capability |

The fourth segment exists so a fix is never mistaken for a feature. It resets
whenever any segment to its left moves: `1.41.0.3` + a small feature → `1.41.1.0`,
and the next fix on top of that is `1.41.1.1`. Release identities always carry
all four canonical numeric segments.

Two consequences worth knowing before you reach for tooling:

- **`release-it` and `npm publish` assume three-segment SemVer.** They are not
  part of Nassaj's release path. This private, unpublished package validates the
  exact four-part identity with `release.sh` and the governed GitHub workflow.
- **Bump the version in the same commit as the change it describes**, so a
  deployed node's `/status` names exactly the code it is running.

## Releases

### Release authorization / إذن الإصدار

A general request such as “publish the changes” (`انشر التعديلات`) does not
authorize a GitHub push or the creation of a GitHub Release. Each remote
operation requires separate, explicit owner authorization that names GitHub,
states whether `push` and/or a GitHub Release is intended, and identifies the
target ref or release version.

لا يُعد طلب عام مثل «انشر التعديلات» إذناً بدفع التغييرات إلى GitHub أو إنشاء
GitHub Release. تتطلب كل عملية بعيدة إذناً مستقلاً وصريحاً من المالك يسمّي
GitHub، ويحدد هل المقصود `push` و/أو GitHub Release، ويعيّن المرجع أو رقم
الإصدار المستهدف.

Prepare the exact version locally, review and commit it, then build and verify
the release locally and upload the prebuilt assets to GitHub. Do not dispatch
GitHub Actions builds or change billing/spending limits. Before pushing a
branch or tag, verify that its workflow triggers cannot start hosted builds.
See the [local release publication guide](docs/local-release-publication.md)
and [ADR-150](alkindy/decisions/adr150-local-release-publication.md).

المسار المعتمد بقرار المالك في 2026-09-09: البناء والتحقق محلياً، ثم دفع الكود
والوسم ورفع حزم الإصدار الجاهزة إلى GitHub. لا تشغيل لبناء Actions ولا تعديل
للفوترة. نشر العميل المحلي وتحديث عقد الأسطول مرحلتان مستقلتان عن إصدار GitHub.

The version preparation script never reads `.env`,
creates tags, pushes, publishes to npm, or mutates anything unless `--write` is
provided explicitly.

```bash
./release.sh 1.42.0.0          # validate only
./release.sh 1.42.0.0 --write  # update package.json and package-lock.json
```

Before building the release, update `CHANGELOG.md` and the human-facing
Arabic wiki page `docs/team-wiki/00-updates.md` with an entry headed by the
exact four-part release number. Version preparation fails closed if that wiki
entry is absent. Build an exact, clean, reviewed release candidate while
preserving concurrent work in the live tree; run the full quality and security
gates locally. Bind package/lock versions, source commit, tag, runtime assets
and manifest to the same identity. Publish the complete GitHub Release only
after verifying uploaded assets, then verify `releases/latest` and updater
discovery. A successful push alone is not a release. This path does not publish
to npm.

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0-or-later License](LICENSE), including the additional terms specified in Section 7 of the LICENSE file.
