// RouteOps AI — read-only API for trusted server-side workflows.
// Deploy as Supabase Edge Function; production demo deployment may be named "swift-task".
// Set ROUTEOPS_API_TOKEN in Edge Functions > Secrets.
// Disable the platform's "Verify JWT" ONLY because this function uses x-routeops-token.
// Never embed the token in a public frontend or commit it to GitHub.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Supabase server-side configuration is missing");
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let differences = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    differences |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return differences === 0;
}

Deno.serve(async (request) => {
  // No browser CORS support: only trusted server-side callers.
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  const expectedToken = Deno.env.get("ROUTEOPS_API_TOKEN");
  const receivedToken = request.headers.get("x-routeops-token") ?? "";
  if (!expectedToken || !safeEqual(receivedToken, expectedToken)) {
    return json({ error: "Unauthorized" }, 401);
  }

  try {
    const [vehicleResult, bookingResult, incidentResult] = await Promise.all([
      db.from("vehicles")
        .select("id, code, status, capacity_units")
        .order("code"),
      db.from("bookings")
        .select("id, reference, pickup_name, pickup_lat, pickup_lon, load_units, planned_date, window_start, window_end, assigned_vehicle_id, status")
        .neq("status", "cancelled")
        .order("reference"),
      db.from("incidents")
        .select("id, vehicle_id, description, status, created_at")
        .eq("status", "open")
        .order("created_at", { ascending: false }),
    ]);

    if (vehicleResult.error || bookingResult.error || incidentResult.error) {
      console.error("RouteOps database read failed", {
        vehicles: vehicleResult.error?.code,
        bookings: bookingResult.error?.code,
        incidents: incidentResult.error?.code,
      });
      return json({ error: "Could not load operational data" }, 500);
    }

    const vehicles = vehicleResult.data ?? [];
    const bookings = bookingResult.data ?? [];
    const incidents = incidentResult.data ?? [];
    const vehicleCodes = new Map(vehicles.map((v) => [v.id, v.code]));

    const openIncidents = incidents.map((incident) => ({
      ...incident,
      vehicle_code: vehicleCodes.get(incident.vehicle_id) ?? null,
      affected_bookings: bookings
        .filter((b) => b.assigned_vehicle_id === incident.vehicle_id && b.status === "assigned")
        .map((b) => ({ reference: b.reference, pickup_name: b.pickup_name, planned_date: b.planned_date })),
    }));

    return json({
      app: "RouteOps AI",
      snapshot_at: new Date().toISOString(),
      vehicles,
      bookings,
      open_incidents: openIncidents,
      summary: {
        vehicle_count: vehicles.length,
        booking_count: bookings.length,
        open_incident_count: openIncidents.length,
        affected_booking_count: openIncidents.reduce((total, incident) => total + incident.affected_bookings.length, 0),
      },
    });
  } catch (error) {
    console.error("Unexpected RouteOps API error", error);
    return json({ error: "Internal server error" }, 500);
  }
});
