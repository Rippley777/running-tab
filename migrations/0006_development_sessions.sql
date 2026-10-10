-- Local paths/raw file observations never enter these tables.
ALTER TABLE repository_mapping ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE repository_mapping ADD COLUMN tracking_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE repository_mapping ADD COLUMN billable boolean NOT NULL DEFAULT true;
ALTER TABLE repository_mapping ADD COLUMN task_id uuid;
ALTER TABLE repository_mapping ADD COLUMN branch_rules jsonb NOT NULL DEFAULT '[]';
ALTER TABLE repository_mapping ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE repository_mapping ADD CONSTRAINT repository_task FOREIGN KEY(workspace_id,project_id,task_id) REFERENCES project_task(workspace_id,project_id,id);
CREATE TABLE development_session (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, user_id text NOT NULL,
 repository_id uuid NOT NULL, branch text NOT NULL DEFAULT '',
 project_id uuid, task_id uuid, billable boolean NOT NULL DEFAULT false,
 started_at timestamptz NOT NULL, ended_at timestamptz NOT NULL,
 inferred_seconds integer NOT NULL CHECK(inferred_seconds>=0),
 observed_seconds integer NOT NULL DEFAULT 0 CHECK(observed_seconds=0),
 adjusted_seconds integer CHECK(adjusted_seconds>0),
 confidence text NOT NULL CHECK(confidence IN ('low','medium')),
 reason text NOT NULL, description text NOT NULL,
 evidence jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL DEFAULT 'suggested' CHECK(status IN ('suggested','approved','discarded')),
 version integer NOT NULL DEFAULT 1, time_entry_id uuid, approved_at timestamptz,
 deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,time_entry_id),
 CHECK(ended_at>=started_at), CHECK(inferred_seconds<=extract(epoch FROM ended_at-started_at)),
 FOREIGN KEY(workspace_id,user_id) REFERENCES membership(workspace_id,user_id),
 FOREIGN KEY(workspace_id,repository_id) REFERENCES repository_mapping(workspace_id,id),
 FOREIGN KEY(workspace_id,project_id) REFERENCES project(workspace_id,id),
 FOREIGN KEY(workspace_id,project_id,task_id) REFERENCES project_task(workspace_id,project_id,id),
 FOREIGN KEY(workspace_id,time_entry_id) REFERENCES time_entry(workspace_id,id)
);
CREATE INDEX development_session_review ON development_session(workspace_id,started_at DESC);
ALTER TABLE time_entry ADD COLUMN source_session_id uuid;
ALTER TABLE time_entry ADD COLUMN approved_at timestamptz;
ALTER TABLE time_entry ADD CONSTRAINT time_source_session FOREIGN KEY(workspace_id,source_session_id) REFERENCES development_session(workspace_id,id);
CREATE UNIQUE INDEX time_source_session_once ON time_entry(source_session_id) WHERE source_session_id IS NOT NULL;
