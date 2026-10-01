CREATE TABLE agreement_term_change (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,agreement_id uuid NOT NULL,effective_on date NOT NULL,fee integer NOT NULL CHECK(fee>0),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(agreement_id,effective_on),FOREIGN KEY(workspace_id,agreement_id) REFERENCES billing_agreement(workspace_id,id)
);
