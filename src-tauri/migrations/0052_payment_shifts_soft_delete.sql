-- "Remover" on a turno used to physically DELETE the row (and its whole
-- append-only history chain). That hid it everywhere, but also meant a
-- later reimport of the same source file had no memory of it ever having
-- existed and would silently recreate it. A soft delete keeps the row (so
-- a reimport can recognize it and surface it for review — see
-- `findDuplicatePaymentShifts`) while still excluding it from every normal
-- list/report, same as the append-only history rows already excluded via
-- HEAD_SHIFT_CONDITION. NULL = not deleted (every existing row).
ALTER TABLE payment_shifts ADD COLUMN deleted_at TEXT;
