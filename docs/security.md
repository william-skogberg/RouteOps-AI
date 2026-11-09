# Security and reliability notes

The application is a **read-only proof of concept**, not production dispatch software.

## Existing controls
- Supabase tables use RLS and do not grant direct access to `anon` or `authenticated`.
- Edge Functions perform a shared-secret check on `x-routeops-token` before querying operational data.
- The privileged Supabase service-role key stays inside the Edge Function environment; it must never appear in a browser or Activepieces prompt.
- Both APIs are read-only. Approval/rejection in Activepieces does not change booking assignments.
- If OSRM routing fails or returns invalid matrix entries, the optimizer fails instead of inventing travel times.
- Capacity and pickup-window rules are checked by deterministic code rather than guessed by a language model.

## Open risks and limitations
- Any exposure of the custom API token permits access until it is rotated. A token appeared in an earlier screenshot, so **rotate it before publication**, and reconfigure Activepieces.
- The shared-token API has no per-client identity, request quotas or dedicated audit trail; use stronger auth and rate limiting for production.
- The service-role key bypasses RLS. The code's restricted query paths therefore need ongoing review; keeping RLS on does not protect against mistakes in these privileged functions.
- Legacy approval URLs are potentially bearer-style capabilities. Restrict sharing and expire/replace them as needed.
- Current approval outcomes live in the flow's execution history, not in `route_proposals`; persistence/auditability is a future feature.
- Original route sequences, depot, vehicle start times, service durations and shift constraints are assumptions.
- OSRM public demo is not an SLA-backed commercial service. Avoid high-volume calls.
- A hardcoded fallback of VAN-02 remains in the optimizer when `vehicle_code` is missing. Production code should reject missing vehicle codes instead.

## Before public release
1. Rotate the previously exposed `ROUTEOPS_API_TOKEN`.
2. Review any Activepieces export for embedded secrets or approval links.
3. Add negative tests for missing/invalid credentials, capacity violations, impossible routes, blank incidents and backend failures.
4. Remove the default vehicle-code fallback and add explicit input validation.
5. Add proper persistence and authorization if approval ever triggers a write.
