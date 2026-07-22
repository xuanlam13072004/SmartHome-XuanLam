--
-- PostgreSQL database dump
--


-- Dumped from database version 18.3
-- Dumped by pg_dump version 18.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.set_updated_at() OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: accounts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    username text NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    full_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.accounts OWNER TO postgres;

--
-- Name: device_commands; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.device_commands (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    mac character varying(17) NOT NULL,
    command text NOT NULL,
    status text DEFAULT 'pending'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    error_log text,
    event_version bigint DEFAULT 0 NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT device_commands_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'acked'::text, 'failed'::text, 'timeout'::text])))
);


ALTER TABLE public.device_commands OWNER TO postgres;

CREATE TABLE public.command_outbox (
    command_id uuid NOT NULL,
    payload jsonb NOT NULL,
    published_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.command_outbox OWNER TO postgres;

--
-- Name: device_metadata; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.device_metadata (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    mac character varying(17) NOT NULL,
    name text NOT NULL,
    product_id text NOT NULL,
    gateway_id text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT check_mac_format CHECK (((mac)::text ~ '^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$'::text))
);


ALTER TABLE public.device_metadata OWNER TO postgres;

--
-- Name: factory_devices; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.factory_devices (
    mac text NOT NULL,
    secret_key text NOT NULL,
    product_id text NOT NULL,
    is_claimed boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.factory_devices OWNER TO postgres;

--
-- Name: user_sessions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.user_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    refresh_token_hash text NOT NULL,
    is_active boolean DEFAULT true,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.user_sessions OWNER TO postgres;

--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: device_commands device_commands_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_commands
    ADD CONSTRAINT device_commands_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.command_outbox
    ADD CONSTRAINT command_outbox_pkey PRIMARY KEY (command_id);


--
-- Name: device_metadata device_metadata_mac_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_metadata
    ADD CONSTRAINT device_metadata_mac_key UNIQUE (mac);


--
-- Name: device_metadata device_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_metadata
    ADD CONSTRAINT device_metadata_pkey PRIMARY KEY (id);


--
-- Name: factory_devices factory_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.factory_devices
    ADD CONSTRAINT factory_devices_pkey PRIMARY KEY (mac);


--
-- Name: device_metadata unique_device_name_per_owner; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_metadata
    ADD CONSTRAINT unique_device_name_per_owner UNIQUE (owner_id, name);


--
-- Name: accounts unique_email; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT unique_email UNIQUE (email);


--
-- Name: device_metadata unique_owner_mac; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_metadata
    ADD CONSTRAINT unique_owner_mac UNIQUE (owner_id, mac);


--
-- Name: user_sessions unique_token_hash; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT unique_token_hash UNIQUE (refresh_token_hash);


--
-- Name: accounts unique_username; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT unique_username UNIQUE (username);


--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);


--
-- Name: idx_device_commands_active_timeout; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_commands_active_timeout ON public.device_commands USING btree (updated_at) WHERE (status = ANY (ARRAY['sending'::text, 'sent'::text]));


--
-- Name: idx_device_commands_lookup; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_commands_lookup ON public.device_commands USING btree (owner_id, mac, status);


--
-- Name: idx_device_commands_pending; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_commands_pending ON public.device_commands USING btree (status, updated_at) WHERE (status = ANY (ARRAY['pending'::text, 'sent'::text]));


--
-- Name: idx_device_commands_timeline; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_commands_timeline ON public.device_commands USING btree (owner_id, mac, created_at DESC);

CREATE INDEX idx_command_outbox_pending ON public.command_outbox USING btree (created_at) WHERE (published_at IS NULL);


--
-- Name: idx_device_mac; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_mac ON public.device_metadata USING btree (mac) WITH (deduplicate_items='true');


--
-- Name: idx_device_owner; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_owner ON public.device_metadata USING btree (owner_id) WITH (deduplicate_items='true');


--
-- Name: idx_owner; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_owner ON public.user_sessions USING btree (owner_id) WITH (deduplicate_items='true');


--
-- Name: idx_user_sessions_expires_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_user_sessions_expires_at ON public.user_sessions USING btree (expires_at);


--
-- Name: device_commands trg_device_commands_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_device_commands_updated_at BEFORE UPDATE ON public.device_commands FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: device_metadata trg_device_metadata_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_device_metadata_updated_at BEFORE UPDATE ON public.device_metadata FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: device_commands device_commands_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_commands
    ADD CONSTRAINT device_commands_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.command_outbox
    ADD CONSTRAINT command_outbox_command_id_fkey FOREIGN KEY (command_id) REFERENCES public.device_commands(id) ON DELETE CASCADE;


--
-- Name: device_metadata device_metadata_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_metadata
    ADD CONSTRAINT device_metadata_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: device_commands fk_command_owner_mac; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_commands
    ADD CONSTRAINT fk_command_owner_mac FOREIGN KEY (owner_id, mac) REFERENCES public.device_metadata(owner_id, mac) ON DELETE CASCADE;


--
-- Name: user_sessions user_sessions_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


CREATE TABLE public.device_shadow_outbox (
    id bigserial PRIMARY KEY,
    mac character varying(17) NOT NULL,
    operation text NOT NULL CHECK (operation IN ('upsert', 'unpair', 'rename')),
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    processed_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_device_shadow_outbox_pending ON public.device_shadow_outbox (id) WHERE processed_at IS NULL;
CREATE INDEX idx_device_shadow_outbox_mac_pending ON public.device_shadow_outbox (mac, id) WHERE processed_at IS NULL;


--
-- PostgreSQL database dump complete
--
