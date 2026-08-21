# GoodVibes templates

These templates are consumed by the Intel server's `scaffold` tool.

- `minimal/vite-react`: Vite 6 + React 19 + TypeScript + Tailwind 3.
- `minimal/next-app`: Next.js 15 (App Router) + TypeScript + Tailwind 3.
- `full/next-saas`: Next.js 15 SaaS starter, NextAuth v5 + Prisma + Stripe.

Each `template.yaml` inventory matches the shipped tree. Package templates use
pinned, mutually compatible versions rather than floating `latest` ranges.
Tailwind remains on version 3 because these templates use its configuration-file
and PostCSS conventions.

Scaffolding is a dry run by default. File creation, dependency installation,
and Git initialization require separate explicit options.
