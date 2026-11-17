-- 204: rooms. Each account arranges the devices it can see into its own rooms;
-- the room of a device is stored on that account's membership row, so a
-- shared device can sit in different rooms for the owner and for members, and
-- unpairing or losing access removes it from the room automatically.

CREATE TABLE public.rooms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    name text NOT NULL,
    icon text NOT NULL DEFAULT 'home',
    position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    UNIQUE (id, account_id),
    CHECK (length(btrim(name)) BETWEEN 1 AND 60),
    CHECK (icon ~ '^[a-z][a-z0-9_]{0,31}$')
);

CREATE UNIQUE INDEX uq_rooms_account_name ON public.rooms (account_id, lower(btrim(name)));
CREATE INDEX idx_rooms_account_position ON public.rooms (account_id, position, created_at);

ALTER TABLE public.device_memberships ADD COLUMN room_id uuid;

-- A room of another account can never be referenced; deleting a room leaves
-- its devices unassigned (only room_id is cleared).
ALTER TABLE public.device_memberships
    ADD CONSTRAINT device_memberships_room_fkey
    FOREIGN KEY (room_id, account_id) REFERENCES public.rooms (id, account_id)
    ON DELETE SET NULL (room_id);

CREATE INDEX idx_device_memberships_room
    ON public.device_memberships (room_id)
    WHERE room_id IS NOT NULL;

CREATE TRIGGER trg_rooms_updated_at
    BEFORE UPDATE ON public.rooms
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
