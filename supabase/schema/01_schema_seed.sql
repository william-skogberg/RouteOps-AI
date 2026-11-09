-- RouteOps AI: schema and synthetic Helsinki demo data
-- Run only in a dedicated Supabase demo project. No real customer data.

BEGIN;

CREATE TABLE IF NOT EXISTS public.vehicles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code text NOT NULL UNIQUE,
    capacity_units integer NOT NULL CHECK (capacity_units > 0),
    status text NOT NULL DEFAULT 'available'
        CHECK (status IN ('available', 'unavailable')),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bookings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reference text NOT NULL UNIQUE,
    pickup_name text NOT NULL,
    pickup_lat double precision NOT NULL CHECK (pickup_lat BETWEEN -90 AND 90),
    pickup_lon double precision NOT NULL CHECK (pickup_lon BETWEEN -180 AND 180),
    load_units integer NOT NULL DEFAULT 1 CHECK (load_units > 0),
    planned_date date NOT NULL DEFAULT (CURRENT_DATE + 1),
    window_start time NOT NULL,
    window_end time NOT NULL,
    assigned_vehicle_id uuid REFERENCES public.vehicles(id),
    status text NOT NULL DEFAULT 'assigned'
        CHECK (status IN ('pending', 'assigned', 'completed', 'cancelled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (window_end > window_start)
);

CREATE TABLE IF NOT EXISTS public.incidents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    vehicle_id uuid NOT NULL REFERENCES public.vehicles(id),
    description text NOT NULL,
    status text NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'resolved')),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.route_proposals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id uuid NOT NULL REFERENCES public.incidents(id),
    status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'approved', 'rejected', 'applied')),
    explanation text,
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.route_proposal_stops (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    proposal_id uuid NOT NULL REFERENCES public.route_proposals(id) ON DELETE CASCADE,
    booking_id uuid NOT NULL REFERENCES public.bookings(id),
    vehicle_id uuid NOT NULL REFERENCES public.vehicles(id),
    stop_order integer NOT NULL CHECK (stop_order > 0),
    UNIQUE (proposal_id, booking_id),
    UNIQUE (proposal_id, vehicle_id, stop_order)
);

ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_proposal_stops ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.vehicles, public.bookings, public.incidents,
    public.route_proposals, public.route_proposal_stops
    FROM anon, authenticated;

INSERT INTO public.vehicles (code, capacity_units) VALUES
    ('VAN-01', 8), ('VAN-02', 8), ('VAN-03', 8)
ON CONFLICT (code) DO NOTHING;

WITH samples(reference, pickup_name, pickup_lat, pickup_lon,
             window_start, window_end, vehicle_code) AS (
    VALUES
    ('RO-001', 'Kamppi',           60.1695, 24.9315, TIME '09:00', TIME '11:00', 'VAN-01'),
    ('RO-002', 'Ruoholahti',       60.1627, 24.9062, TIME '09:30', TIME '11:30', 'VAN-01'),
    ('RO-003', 'Lauttasaari',      60.1589, 24.8855, TIME '10:00', TIME '12:00', 'VAN-01'),
    ('RO-004', 'Töölö',            60.1810, 24.9210, TIME '10:30', TIME '12:30', 'VAN-01'),
    ('RO-005', 'Meilahti',         60.1905, 24.9064, TIME '11:00', TIME '13:00', 'VAN-01'),
    ('RO-006', 'Munkkiniemi',      60.1971, 24.8774, TIME '11:30', TIME '13:30', 'VAN-01'),
    ('RO-007', 'Kallio',           60.1846, 24.9528, TIME '09:00', TIME '11:00', 'VAN-02'),
    ('RO-008', 'Hakaniemi',        60.1790, 24.9503, TIME '09:30', TIME '11:30', 'VAN-02'),
    ('RO-009', 'Sörnäinen',        60.1882, 24.9648, TIME '10:00', TIME '12:00', 'VAN-02'),
    ('RO-010', 'Kalasatama',       60.1867, 24.9787, TIME '10:30', TIME '12:30', 'VAN-02'),
    ('RO-011', 'Kulosaari',        60.1846, 25.0127, TIME '11:00', TIME '13:00', 'VAN-02'),
    ('RO-012', 'Pasila',           60.1985, 24.9320, TIME '09:00', TIME '11:00', 'VAN-03'),
    ('RO-013', 'Käpylä',           60.2136, 24.9490, TIME '09:30', TIME '11:30', 'VAN-03'),
    ('RO-014', 'Oulunkylä',        60.2280, 24.9648, TIME '10:00', TIME '12:00', 'VAN-03'),
    ('RO-015', 'Pukinmäki',        60.2437, 24.9892, TIME '10:30', TIME '12:30', 'VAN-03')
)
INSERT INTO public.bookings (
    reference, pickup_name, pickup_lat, pickup_lon,
    window_start, window_end, assigned_vehicle_id
)
SELECT s.reference, s.pickup_name, s.pickup_lat, s.pickup_lon,
       s.window_start, s.window_end, v.id
FROM samples AS s
JOIN public.vehicles AS v ON v.code = s.vehicle_code
ON CONFLICT (reference) DO NOTHING;

COMMIT;

SELECT v.code, v.status, COUNT(b.id) AS bookings
FROM public.vehicles v
LEFT JOIN public.bookings b ON b.assigned_vehicle_id = v.id
GROUP BY v.code, v.status
ORDER BY v.code;
