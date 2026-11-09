# Activepieces workflow (manual reconstruction)

This workflow runs in the user's private Activepieces Cloud workspace; it is **not deployed from this Git repository**.

## Steps

1. **Manual Trigger** to run a demo.
2. **HTTP GET** to the deployed Supabase read function; header `x-routeops-token` comes from a private credential.
3. **Router**: choose Branch 1 when `body.summary.open_incident_count > 0`. Otherwise end without optimization.
4. **HTTP POST** to `routeops-optimize`; JSON body contains `vehicle_code` mapped from the first open incident (`body.open_incidents[0].vehicle_code`).
5. **Run Agent** (RouteOps Incident Analyst): receives both the read API's full `body` and the optimizer API's full `body` via Activepieces dynamic variables.
6. **Create Approval Links** (Approval Legacy).
7. **Wait for Approval** (Approval Legacy), pausing until a reviewer selects Approve or Disapprove.

The prototype analyses only the **first** open incident. Multiple concurrent incidents would require a loop and conflict-handling logic.

## Prompt and agent behavior

The agent identifies affected bookings, reports available capacity, explains the optimizer's proposed reassignment and ETA estimates, and flags missing business data. It must not claim real-world feasibility or perform database mutations.

The model used is the Activepieces-hosted Expert credits option; exact model identity is managed by the provider and is not claimed here.

## Manual tests observed

| Test | Observed result | Caveat |
| --- | --- | --- |
| Read endpoint | Three vehicles, fifteen bookings, one incident, five affected bookings | Synthetic data |
| Route optimizer | Candidate proposal for five affected bookings, 8/8 and 7/8 vehicle loads | Based on modeled assumptions |
| Agent report | Structured incident, constraints and recovery recommendations | AI output was reviewed, not independently scored |
| Router | Open incident count > 0 selected Branch 1 | No-incident path not independently validated |
| Approval | Approved / Yes observed | No database write |
| Rejection | Approved / No observed | No database write |

**Not tested yet:** automated unit tests, multiple incidents, invalid credentials, expired workflow approval links, OSRM outage recovery and DB decision persistence.

## Important note

The Activepieces approval links should be treated as sensitive access URLs. Do not commit them to version control or include them in public screenshots.
