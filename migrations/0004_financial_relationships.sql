ALTER TABLE invoice_line ADD CONSTRAINT line_invoice_identity UNIQUE(workspace_id,invoice_id,id);
ALTER TABLE invoice_source_allocation ADD CONSTRAINT source_line_same_invoice FOREIGN KEY(workspace_id,invoice_id,line_id) REFERENCES invoice_line(workspace_id,invoice_id,id);
ALTER TABLE invoice ADD CONSTRAINT invoice_client_identity UNIQUE(workspace_id,client_id,id);
ALTER TABLE client_access ADD CONSTRAINT access_same_client_invoice FOREIGN KEY(workspace_id,client_id,invoice_id) REFERENCES invoice(workspace_id,client_id,id);
ALTER TABLE client_payment_profile ADD CONSTRAINT profile_client_identity UNIQUE(workspace_id,client_id,id);
ALTER TABLE auto_charge_consent ADD CONSTRAINT consent_same_client_profile FOREIGN KEY(workspace_id,client_id,profile_id) REFERENCES client_payment_profile(workspace_id,client_id,id);
CREATE FUNCTION guard_issued_due_date() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.issuance_state IN ('queued','issued') AND NEW.due_at IS DISTINCT FROM OLD.due_at THEN RAISE EXCEPTION 'Issued payment terms are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER issued_due_date_locked BEFORE UPDATE ON invoice FOR EACH ROW EXECUTE FUNCTION guard_issued_due_date();
