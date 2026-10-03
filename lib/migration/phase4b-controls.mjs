import { proposedLegacyFreezeSQL } from './phase4a-readiness.mjs'

// SQL generators only. No credentials, connection, production execution or authority activation.
const lock = `SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
LOCK TABLE public.clients, public.visits, public.ai_reminders, public.client_actions, public.client_action_events IN SHARE ROW EXCLUSIVE MODE;`
function rpcPermissions(verb) {
  return `DO $$ DECLARE f record; BEGIN
IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('eye_action_create','eye_action_edit','eye_action_complete','eye_action_cancel','eye_action_replace','eye_action_reopen')) <> 6 THEN RAISE EXCEPTION 'Unexpected canonical RPC inventory'; END IF;
FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('eye_action_create','eye_action_edit','eye_action_complete','eye_action_cancel','eye_action_replace','eye_action_reopen') LOOP
EXECUTE format('${verb} EXECUTE ON FUNCTION %s ${verb==='REVOKE'?'FROM':'TO'} authenticated',f.signature); END LOOP; END $$;`
}
export function fullLegacyFreezeSQL() { return proposedLegacyFreezeSQL() }

/** Covers already-running commands and revoked RPCs via table locks + ALWAYS triggers. */
export function canonicalFenceSQL() {
  return `BEGIN;
${lock}
${rpcPermissions('REVOKE')}
CREATE FUNCTION eye_private.phase4_canonical_fenced() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Canonical operational maintenance fence'; END; $$;
REVOKE ALL ON FUNCTION eye_private.phase4_canonical_fenced() FROM PUBLIC,anon,authenticated,service_role;
${['client_actions','client_action_events'].map(t=>`CREATE TRIGGER phase4_canonical_fenced BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.${t} FOR EACH STATEMENT EXECUTE FUNCTION eye_private.phase4_canonical_fenced();
ALTER TABLE public.${t} ENABLE ALWAYS TRIGGER phase4_canonical_fenced;`).join('\n')}
COMMIT;`
}
export function releaseCanonicalFenceSQL() {
  return `BEGIN;\n${lock}\n${['client_actions','client_action_events'].map(t=>`DROP TRIGGER phase4_canonical_fenced ON public.${t};`).join('\n')}\nDROP FUNCTION eye_private.phase4_canonical_fenced();\n${rpcPermissions('GRANT')}\nCOMMIT;`
}

/** Install while full freeze still exists, before releasing unrelated CRM writes.
 * Existing operational values cannot change. New clients/visits can omit legacy work.
 * Ownership/link moves and DELETE/TRUNCATE remain fenced to protect canonical evidence/FKs.
 */
export function narrowLegacyGuardsSQL() {
  return `BEGIN;
${lock}
CREATE FUNCTION eye_private.phase4_legacy_operational_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') OR TG_TABLE_NAME='ai_reminders' THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Legacy operational writes fenced';
  END IF;
  IF TG_TABLE_NAME='clients' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.next_action IS NOT NULL OR NEW.next_followup IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Legacy operational writes fenced'; END IF;
    ELSIF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.next_action IS DISTINCT FROM OLD.next_action OR NEW.next_followup IS DISTINCT FROM OLD.next_followup THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Legacy operational writes fenced';
    END IF;
  ELSIF TG_TABLE_NAME='visits' AND TG_OP='UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.client_id IS DISTINCT FROM OLD.client_id THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Legacy operational relationships fenced'; END IF;
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION eye_private.phase4_legacy_operational_guard() FROM PUBLIC,anon,authenticated,service_role;
${['clients','visits','ai_reminders'].map(t=>`CREATE TRIGGER phase4_legacy_operational_guard BEFORE INSERT OR UPDATE OR DELETE ON public.${t} FOR EACH ROW EXECUTE FUNCTION eye_private.phase4_legacy_operational_guard();
CREATE TRIGGER phase4_legacy_truncate_guard BEFORE TRUNCATE ON public.${t} FOR EACH STATEMENT EXECUTE FUNCTION eye_private.phase4_legacy_operational_guard();
ALTER TABLE public.${t} ENABLE ALWAYS TRIGGER phase4_legacy_operational_guard;
ALTER TABLE public.${t} ENABLE ALWAYS TRIGGER phase4_legacy_truncate_guard;`).join('\n')}
COMMIT;`
}
export function releaseFullLegacyFreezeSQL() {
  return `BEGIN;\n${lock}\n${['clients','visits','ai_reminders'].map(t=>`DROP TRIGGER phase4_legacy_frozen ON public.${t};`).join('\n')}\nDROP FUNCTION eye_private.phase4_legacy_frozen();\nCOMMIT;`
}

export function cutoverTrafficPlan(deployments) {
  return { oldDeployments: deployments, fencing: 'Database ALWAYS guards on clients/visits/ai_reminders; canonical table fence until activation verification; all production aliases moved to reviewed deployment.',
    evidenceRequired: ['all aliases inventoried', 'legacy full freeze verified from old direct clients and service_role', 'pending Inngest events inventoried or preserved with IDs', 'final snapshot after freeze', 'canonical fence verified'],
    rollback: { authority: 'CANONICAL', maintenance: 'ON', deployment: 'same verified canonical-reading artifact', databaseFence: 'canonicalFenceSQL', legacyGuards: 'retain', allowOldLegacyRollback: false },
    activationAuthorized: false }
}
