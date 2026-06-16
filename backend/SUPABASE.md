# Supabase (HIPAA) setup

Klove stores all records in **Supabase PostgreSQL**. The code is wired; finishing the connection
needs two secrets that API keys can't substitute for, plus the compliance steps below.

Project: `xgydnhqpsebszhpsbgaq` (https://xgydnhqpsebszhpsbgaq.supabase.co)

## 1. Secrets to fill into `.env`

Already set: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`.

Still required:

| Var | Where to get it | Used for |
|-----|-----------------|----------|
| `DATABASE_URL` / `DIRECT_URL` password + region | Dashboard → **Project Settings → Database → Connection string** (copy the **Transaction** pooler URL for `DATABASE_URL`, the **Session** URL for `DIRECT_URL`) | Prisma's Postgres connection |
| `SUPABASE_SERVICE_ROLE_KEY` | Dashboard → **Project Settings → API keys** → `sb_secret_…` | Server-side Storage uploads to the private bucket + admin writes |
| `SUPABASE_JWT_SECRET` *(optional)* | Dashboard → **Project Settings → API → JWT Settings** | Verifying Supabase Auth tokens (only when client auth is wired) |

In `.env`, replace `<DB-PASSWORD>` and `<REGION>` in both `DATABASE_URL` and `DIRECT_URL` with the
values from the dashboard connection string.

> **Use the pooler, not the direct host.** The direct `db.<ref>.supabase.co` host is **IPv6-only**
> (verified: it has an AAAA record but no A record) and is unreachable from IPv4-only networks and
> most CI. Use the **Session/Transaction pooler** strings (`aws-0-<region>.pooler.supabase.com`,
> username `postgres.<ref>`) — Dashboard → **Connect** → "Session pooler" / "Transaction pooler".
> `DATABASE_URL` = Transaction pooler (6543), `DIRECT_URL` = Session pooler (5432).

> Note: the publishable key (`sb_publishable_…`) is the **public** key — safe in clients, but it is
> NOT enough for the backend. Prisma needs the database password; Storage needs the `sb_secret_…` key.

## 2. Schema — ALREADY DEPLOYED ✅

The 24 Klove tables + RLS were applied directly to project `xgydnhqpsebszhpsbgaq` (region
`us-east-2`) via the Supabase Management API, and the Prisma migration is baselined in
`_prisma_migrations`. So `npm run db:migrate` is now a no-op (reports "already applied"). Nothing to
run for the schema. To confirm later: `npm run db:studio` (needs the password below) or the
Supabase Table editor.

Still to do for Storage (file uploads):

1. Storage → New bucket → name `health-documents`, **Private**.
2. (RLS is already applied via `prisma/rls.sql` — deny-by-default on every table.)

> Note: there is also a separate set of pre-existing `snake_case` tables in this project
> (`persons`, `records`, `appointments`, `households`, …) from other tooling. The Klove backend
> uses the PascalCase Prisma tables and does not touch those.

Verify:

```bash
npm run db:studio       # browse the live Supabase tables
npm run dev             # /health should report storage:"live:supabase"
```

## 3. HIPAA compliance (beyond the code)

Storing PHI in Supabase is only compliant with these in place:

- **Sign a BAA with Supabase** and enable the **HIPAA add-on** (Team/Enterprise plan). Do not put
  real PHI in the project until the BAA is signed.
- **BAAs with every other PHI processor**: Anthropic (extraction), the records aggregator. Keep
  outbound email PHI-free so Resend stays out of scope.
- **RLS enabled** (`prisma/rls.sql`) — defense-in-depth; the backend also enforces `where: { userId }`.
- **Private Storage bucket** + signed URLs only (already how `services/storage.ts` works).
- **Encrypted secrets at rest**: OAuth/IMAP tokens are envelope-encrypted (`services/crypto.ts`);
  set `HEALTH_ENCRYPTION_KEY` in production.
- **No PHI in logs**: review Fastify request logging before go-live.

Until the BAA is signed, point the project at **synthetic data only**.
