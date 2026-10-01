CREATE TABLE payment_setup (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,client_id uuid NOT NULL,profile_id uuid NOT NULL,provider text NOT NULL CHECK(provider='stripe_test'),account_id text NOT NULL,session_id text NOT NULL,terms_version text NOT NULL,frequency text NOT NULL,amount_policy text NOT NULL,accepted_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,expires_at timestamptz NOT NULL,UNIQUE(provider,account_id,session_id),FOREIGN KEY(workspace_id,client_id) REFERENCES client(workspace_id,id),FOREIGN KEY(workspace_id,profile_id) REFERENCES client_payment_profile(workspace_id,id));
ALTER TABLE auto_charge_consent ADD COLUMN setup_session_id text UNIQUE;
CREATE TABLE delivery_outbox (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES workspace(id),invoice_id uuid,kind text NOT NULL CHECK(kind IN ('invoice','receipt','digest')),dedup_key text NOT NULL UNIQUE,state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','processing','sent','failed')),attempts integer NOT NULL DEFAULT 0,error_code text,created_at timestamptz NOT NULL DEFAULT now(),sent_at timestamptz,FOREIGN KEY(workspace_id,invoice_id) REFERENCES invoice(workspace_id,id));
ALTER TABLE workspace ADD COLUMN digest_enabled boolean NOT NULL DEFAULT false;
CREATE FUNCTION guard_issued_line() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM invoice WHERE id=OLD.invoice_id AND issuance_state IN ('queued','issued')) THEN RAISE EXCEPTION 'Issued or queued invoice lines are immutable'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER issued_line_locked BEFORE UPDATE OR DELETE ON invoice_line FOR EACH ROW EXECUTE FUNCTION guard_issued_line();
CREATE FUNCTION guard_financial_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.issuance_state IN ('queued','issued') AND (NEW.client_id,NEW.currency,NEW.revision,NEW.subtotal,NEW.discount,NEW.tax_bps,NEW.tax,NEW.total,NEW.memo,NEW.po_reference,NEW.business_snapshot,NEW.client_snapshot) IS DISTINCT FROM (OLD.client_id,OLD.currency,OLD.revision,OLD.subtotal,OLD.discount,OLD.tax_bps,OLD.tax,OLD.total,OLD.memo,OLD.po_reference,OLD.business_snapshot,OLD.client_snapshot) THEN RAISE EXCEPTION 'Issued financial identity is immutable'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER issued_invoice_locked BEFORE UPDATE ON invoice FOR EACH ROW EXECUTE FUNCTION guard_financial_identity();
