// RouteOps AI — read-only route recovery optimizer (demo MVP).
// Deploy as Edge Function: routeops-optimize
// POST { "vehicle_code": "VAN-02" } with x-routeops-token.
// Does not write to the database; OSRM demo service is for small-scale testing only.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SECRET = Deno.env.get("ROUTEOPS_API_TOKEN") ?? "";
const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DEPOT = { name: "Helsinki Central (assumed depot)", lat: 60.1713, lon: 24.9410 };
const START_SECONDS = 8 * 3600 + 30 * 60;
const SERVICE_SECONDS = 10 * 60;
const DRIVE_BUFFER = 1.20;
const BEAM_WIDTH = 70;
const MAX_BOOKINGS = 30;

interface Vehicle {
  id: string;
  code: string;
  status: "available" | "unavailable";
  capacity_units: number;
}
interface Booking {
  id: string;
  reference: string;
  pickup_name: string;
  pickup_lat: number;
  pickup_lon: number;
  load_units: number;
  planned_date: string;
  window_start: string;
  window_end: string;
  assigned_vehicle_id: string | null;
  status: string;
}
interface Incident {
  id: string;
  vehicle_id: string;
  description: string;
  status: string;
}
interface Matrices {
  durations: number[][];
  distances: number[][];
}
interface Stop {
  booking: Booking;
  arrival_sec: number;
  service_start_sec: number;
  service_end_sec: number;
  leg_drive_sec: number;
  leg_distance_m: number;
}
interface RouteEvaluation {
  valid: boolean;
  reason?: string;
  stops: Stop[];
  load: number;
  drive_sec: number;
  distance_m: number;
  finish_sec: number;
}
interface Candidate {
  routes: Record<string, Booking[]>;
  evaluations: Record<string, RouteEvaluation>;
  score: number;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
function seconds(time: string): number {
  const parts = time.split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error("Invalid booking time");
  }
  return parts[0] * 3600 + parts[1] * 60 + (parts[2] ?? 0);
}
function clock(s: number): string {
  const min = Math.round(s / 60);
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
function round(n: number, digits = 1): number {
  return Number(n.toFixed(digits));
}

async function osrmMatrix(bookings: Booking[]): Promise<Matrices> {
  const coords = [
    `${DEPOT.lon},${DEPOT.lat}`,
    ...bookings.map((b) => `${b.pickup_lon},${b.pickup_lat}`),
  ].join(";");
  const url = `https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration,distance`;
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Routing service HTTP ${response.status}`);
  const data = await response.json();
  const size = bookings.length + 1;
  if (data.code !== "Ok" || !Array.isArray(data.durations) || !Array.isArray(data.distances)) {
    throw new Error("Routing service returned an invalid matrix");
  }
  for (const matrix of [data.durations, data.distances]) {
    if (
      matrix.length !== size ||
      matrix.some((row: unknown) =>
        !Array.isArray(row) ||
        row.length !== size ||
        row.some((v: unknown) => typeof v !== "number" || !Number.isFinite(v) || v < 0)
      )
    ) {
      throw new Error("Some locations have no valid driving route");
    }
  }
  return { durations: data.durations, distances: data.distances };
}

function evaluate(
  stops: Booking[], vehicle: Vehicle, matrix: Matrices, indexById: Map<string, number>,
): RouteEvaluation {
  const load = stops.reduce((sum, b) => sum + b.load_units, 0);
  if (load > vehicle.capacity_units) {
    return { valid: false, reason: "capacity_exceeded", stops: [], load, drive_sec: 0, distance_m: 0, finish_sec: START_SECONDS };
  }
  let time = START_SECONDS;
  let previous = 0;
  let drive_sec = 0;
  let distance_m = 0;
  const scheduled: Stop[] = [];
  for (const booking of stops) {
    const next = indexById.get(booking.id);
    if (next === undefined) throw new Error("Booking index not found");
    const drive = matrix.durations[previous][next] * DRIVE_BUFFER;
    const distance = matrix.distances[previous][next];
    const arrival = time + drive;
    const start = Math.max(arrival, seconds(booking.window_start));
    if (start > seconds(booking.window_end)) {
      return { valid: false, reason: `missed_window_${booking.reference}`, stops: scheduled, load, drive_sec, distance_m, finish_sec: time };
    }
    time = start + SERVICE_SECONDS;
    scheduled.push({
      booking, arrival_sec: arrival, service_start_sec: start,
      service_end_sec: time, leg_drive_sec: drive, leg_distance_m: distance,
    });
    drive_sec += drive;
    distance_m += distance;
    previous = next;
  }
  return { valid: true, stops: scheduled, load, drive_sec, distance_m, finish_sec: time };
}

function computeCandidate(
  routes: Record<string, Booking[]>, vehicles: Vehicle[], matrix: Matrices,
  indexById: Map<string, number>,
): Candidate | null {
  const evaluations: Record<string, RouteEvaluation> = {};
  let totalDrive = 0;
  let totalDistance = 0;
  for (const vehicle of vehicles) {
    const result = evaluate(routes[vehicle.code], vehicle, matrix, indexById);
    if (!result.valid) return null;
    evaluations[vehicle.code] = result;
    totalDrive += result.drive_sec;
    totalDistance += result.distance_m;
  }
  return { routes, evaluations, score: totalDrive + totalDistance / 100000 };
}

function beamSearch(
  vehicles: Vehicle[], existing: Booking[], affected: Booking[], matrix: Matrices,
  indexById: Map<string, number>,
): Candidate | null {
  const initial: Record<string, Booking[]> = {};
  for (const vehicle of vehicles) {
    initial[vehicle.code] = existing
      .filter((b) => b.assigned_vehicle_id === vehicle.id)
      .sort((a, b) => seconds(a.window_start) - seconds(b.window_start) || a.reference.localeCompare(b.reference));
  }
  const first = computeCandidate(initial, vehicles, matrix, indexById);
  if (!first) return null;
  let beam: Candidate[] = [first];
  const pending = [...affected].sort((a, b) => seconds(a.window_end) - seconds(b.window_end));
  for (const booking of pending) {
    const next: Candidate[] = [];
    const seen = new Set<string>();
    for (const current of beam) {
      for (const vehicle of vehicles) {
        const route = current.routes[vehicle.code];
        for (let position = 0; position <= route.length; position++) {
          const routes: Record<string, Booking[]> = { ...current.routes };
          routes[vehicle.code] = [...route.slice(0, position), booking, ...route.slice(position)];
          const key = vehicles.map((v) => routes[v.code].map((b) => b.reference).join(",")).join("|");
          if (seen.has(key)) continue;
          seen.add(key);
          const candidate = computeCandidate(routes, vehicles, matrix, indexById);
          if (candidate) next.push(candidate);
        }
      }
    }
    if (!next.length) return null;
    next.sort((a, b) => a.score - b.score);
    beam = next.slice(0, BEAM_WIDTH);
  }
  return beam[0] ?? null;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed. Use POST." }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY || !SECRET) return json({ error: "Server configuration missing" }, 503);
  if (!safeEqual(request.headers.get("x-routeops-token") ?? "", SECRET)) {
    return json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await request.json().catch(() => ({}));
    const vehicleCode = typeof body?.vehicle_code === "string" ? body.vehicle_code : "VAN-02";
    if (!/^VAN-[A-Z0-9-]{2,12}$/.test(vehicleCode)) return json({ error: "Invalid vehicle_code" }, 400);

    const [vRes, iRes] = await Promise.all([
      db.from("vehicles").select("id,code,status,capacity_units").order("code"),
      db.from("incidents").select("id,vehicle_id,description,status").eq("status", "open"),
    ]);
    if (vRes.error || iRes.error) return json({ error: "Could not load vehicles or incidents" }, 500);
    const vehicles = (vRes.data ?? []) as Vehicle[];
    const allIncidents = (iRes.data ?? []) as Incident[];
    const failed = vehicles.find((v) => v.code === vehicleCode);
    if (!failed) return json({ error: "Vehicle not found" }, 404);
    const incident = allIncidents.find((i) => i.vehicle_id === failed.id);
    if (!incident || failed.status !== "unavailable") {
      return json({ error: "This vehicle has no open incident and unavailable status" }, 409);
    }

    const aRes = await db.from("bookings")
      .select("id,reference,pickup_name,pickup_lat,pickup_lon,load_units,planned_date,window_start,window_end,assigned_vehicle_id,status")
      .eq("assigned_vehicle_id", failed.id).eq("status", "assigned");
    if (aRes.error) return json({ error: "Could not load affected bookings" }, 500);
    const affectedAll = (aRes.data ?? []) as Booking[];
    if (!affectedAll.length) return json({ status: "no_action_needed", vehicle_code: vehicleCode, affected_bookings: 0 });

    const dates = [...new Set(affectedAll.map((b) => b.planned_date))];
    if (dates.length !== 1) return json({ error: "Multiple booking dates require separate optimization runs" }, 409);
    const date = dates[0];
    const bRes = await db.from("bookings")
      .select("id,reference,pickup_name,pickup_lat,pickup_lon,load_units,planned_date,window_start,window_end,assigned_vehicle_id,status")
      .eq("planned_date", date).eq("status", "assigned");
    if (bRes.error) return json({ error: "Could not load booking data" }, 500);
    const allBookings = (bRes.data ?? []) as Booking[];
    if (allBookings.length > MAX_BOOKINGS) return json({ error: "MVP supports a maximum of 30 bookings per day" }, 422);
    const affected = allBookings.filter((b) => b.assigned_vehicle_id === failed.id);
    const available = vehicles.filter((v) => v.status === "available");
    const existing = allBookings.filter((b) => available.some((v) => v.id === b.assigned_vehicle_id));
    if (allBookings.some((b) =>
      b.assigned_vehicle_id &&
      !available.some((v) => v.id === b.assigned_vehicle_id) &&
      b.assigned_vehicle_id !== failed.id
    )) {
      return json({ error: "Other unavailable vehicles have bookings; resolve incidents separately" }, 409);
    }
    if (allBookings.some((b) => !b.assigned_vehicle_id)) {
      return json({ error: "Unassigned bookings are not supported by this MVP" }, 409);
    }
    if (!available.length) return json({ status: "no_feasible_plan", reason: "No available vehicles" }, 200);
    const spare = available.reduce((acc, v) => {
      const original = existing.filter((b) => b.assigned_vehicle_id === v.id)
        .reduce((n, b) => n + b.load_units, 0);
      return acc + Math.max(0, v.capacity_units - original);
    }, 0);
    const needed = affected.reduce((sum, b) => sum + b.load_units, 0);
    if (spare < needed) {
      return json({
        status: "no_feasible_plan", reason: "Insufficient total vehicle capacity",
        needed_units: needed, free_units: spare,
      });
    }

    const matrix = await osrmMatrix(allBookings);
    const indexById = new Map(allBookings.map((b, i) => [b.id, i + 1]));
    const result = beamSearch(available, existing, affected, matrix, indexById);
    const assumptions = {
      depot: DEPOT,
      shift_start_local: "08:30",
      time_zone: "Europe/Helsinki",
      service_minutes_per_pickup: SERVICE_SECONDS / 60,
      drive_time_buffer_percent: (DRIVE_BUFFER - 1) * 100,
      original_stop_order: "Inferred from pickup window start; actual route order not recorded",
      time_window_rule: "Pickup service must begin before window end",
      traffic_and_real_time_road_conditions: "Not modelled",
    };
    if (!result) {
      return json({
        status: "no_feasible_plan_found",
        incident: { id: incident.id, vehicle_code: failed.code, description: incident.description },
        affected_booking_references: affected.map((b) => b.reference),
        routing_source: "OSRM public demo / OSM road network",
        constraints_checked: ["vehicle capacity", "OSRM estimated drive times", "booking time windows"],
        assumptions,
        warning: "No feasible plan found by the heuristic under the stated assumptions; this does not prove no solution exists.",
      });
    }

    const routes = available.map((vehicle) => {
      const evalRoute = result.evaluations[vehicle.code];
      return {
        vehicle_code: vehicle.code,
        capacity_units: vehicle.capacity_units,
        assigned_load_units: evalRoute.load,
        spare_capacity_units: vehicle.capacity_units - evalRoute.load,
        estimated_drive_minutes_with_buffer: round(evalRoute.drive_sec / 60),
        estimated_road_km: round(evalRoute.distance_m / 1000),
        estimated_finish_local: clock(evalRoute.finish_sec),
        stops: evalRoute.stops.map((stop, i) => ({
          order: i + 1,
          reference: stop.booking.reference,
          pickup_name: stop.booking.pickup_name,
          window: `${stop.booking.window_start.slice(0, 5)}-${stop.booking.window_end.slice(0, 5)}`,
          estimated_service_start_local: clock(stop.service_start_sec),
          estimated_service_end_local: clock(stop.service_end_sec),
          newly_reassigned: stop.booking.assigned_vehicle_id === failed.id,
          load_units: stop.booking.load_units,
        })),
      };
    });
    const assignments = routes.flatMap((r) => r.stops
      .filter((s) => s.newly_reassigned)
      .map((s) => ({
        reference: s.reference, new_vehicle: r.vehicle_code,
        estimated_service_start_local: s.estimated_service_start_local,
      })));

    return json({
      app: "RouteOps AI",
      status: "candidate_feasible_under_assumptions",
      generated_at: new Date().toISOString(),
      planned_date: date,
      incident: { id: incident.id, vehicle_code: failed.code, description: incident.description },
      affected_booking_count: affected.length,
      routing_source: "OSRM public demo / OpenStreetMap (non-commercial demo use only)",
      optimizer: "bounded beam-search insertion heuristic; not guaranteed globally optimal",
      constraints_checked: ["vehicle capacity", "estimated road travel times", "pickup time windows"],
      assumptions,
      proposed_assignments: assignments,
      routes,
      total_estimated_drive_minutes_with_buffer: round(
        routes.reduce((n, r) => n + r.estimated_drive_minutes_with_buffer, 0)
      ),
      human_approval_required: true,
      changes_applied: false,
      warning: "Read-only proposal. Actual feasibility requires checking driver shifts, live traffic, vehicle start positions and customer requirements.",
    });
  } catch (err) {
    console.error("RouteOps optimizer failed", err instanceof Error ? err.message : "unknown error");
    return json({
      error: "Optimization could not be completed; no records changed",
      detail: "Routing service unavailable or input invalid",
    }, 503);
  }
});
