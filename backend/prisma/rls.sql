-- Row Level Security for Klove (HIPAA defense-in-depth).
--
-- The backend connects with the service-role key, which BYPASSES RLS, and enforces per-user
-- ownership in every query (where: { userId }). RLS here is a second line of defense: it ensures
-- that if anything ever reaches these tables via the public PostgREST API (anon / authenticated
-- roles, e.g. a future direct supabase-js client), it gets NOTHING unless an explicit policy allows.
--
-- Strategy: enable RLS on every table with NO permissive policy for anon/authenticated → deny all.
-- (Service-role still has full access because it bypasses RLS.) When you later expose direct client
-- access, add owner-scoped policies like the commented example at the bottom.
--
-- Apply this in the Supabase SQL editor (or psql) AFTER running the Prisma migration.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'User','DataSourceConnection','HealthDocument','ExtractionJob',
    'Observation','Condition','MedicationStatement','DiagnosticReport','AllergyIntolerance',
    'Profile','InsurancePlan','Appointment','HealthAlert',
    'Session','CallTarget','CallResult',
    'Household','HouseholdMembership','ConsentGrant',
    'Task','Reminder','Request','AuditEvent','Message'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;

-- Example owner-scoped policy to ENABLE later for direct client reads (keep disabled while only the
-- service-role backend touches the DB). Maps Supabase auth.uid() → User.authUserId → row.userId.
--
-- CREATE POLICY "own observations" ON public.\"Observation\"
--   FOR SELECT TO authenticated
--   USING (
--     "userId" IN (SELECT id FROM public."User" WHERE "authUserId" = auth.uid()::text)
--   );
