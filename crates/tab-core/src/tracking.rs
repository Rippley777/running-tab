//! Local, opt-in metadata observer. No file contents, diffs, hooks or app inspection.
use crate::{Result, git, sanitize_remote};
use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub idle_seconds: u64,
    pub merge_seconds: u64,
    pub minimum_seconds: u64,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            idle_seconds: 600,
            merge_seconds: 300,
            minimum_seconds: 300,
        }
    }
}
impl Settings {
    pub fn validate(&self) -> Result<()> {
        if self.idle_seconds < 60
            || self.idle_seconds > 7200
            || self.merge_seconds < 30
            || self.merge_seconds > self.idle_seconds
            || self.minimum_seconds > 3600
        {
            return Err(
                "Use idle 1–120 minutes, merge 30 seconds–idle, minimum 0–60 minutes.".into(),
            );
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub at: u64,
    pub kind: String,
    pub detail: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub repository_id: String,
    pub branch: String,
    pub started_at: u64,
    pub ended_at: u64,
    pub inferred_seconds: u64,
    pub evidence: Vec<Evidence>,
    pub state: String,
}
impl Session {
    fn event(&mut self, at: u64, kind: &str, detail: &str) {
        if self.evidence.len() < 498 {
            self.evidence.push(Evidence {
                at,
                kind: kind.into(),
                detail: detail.into(),
            });
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub id: String,
    pub workspace_id: String,
    pub server_id: Option<String>,
    pub identity: String,
    pub name: String,
    pub path: PathBuf,
    pub remote: Option<String>,
    pub branch: String,
    pub default_branch: Option<String>,
    pub mode: String,
    pub last_activity: Option<u64>,
    pub error: Option<String>,
    #[serde(default)]
    pub file_id: String,
    #[serde(skip)]
    baseline: Option<Sample>,
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Tracker {
    pub repositories: Vec<Repository>,
    pub sessions: Vec<Session>,
    pub settings: Settings,
    #[serde(default)]
    pub workspaces: Vec<PathBuf>,
    #[serde(skip)]
    pub last_poll: Option<u64>,
}
#[derive(Clone, Debug)]
pub struct Sample {
    pub fingerprint: u64,
    pub branch: String,
    pub head: String,
}
fn text(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect()
}
fn root(path: &Path) -> Result<PathBuf> {
    let canonical = std::fs::canonicalize(path).map_err(|_| "Directory is unavailable")?;
    let top = git(&canonical, &["rev-parse", "--show-toplevel"])?;
    std::fs::canonicalize(top.trim()).map_err(|_| "Select a working Git repository".into())
}
fn file_id(path: &Path) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let Ok(m) = std::fs::metadata(path) {
            return format!("{}:{}", m.dev(), m.ino());
        }
    }
    path.to_string_lossy().to_string()
}
pub fn inspect(path: &Path, workspace: &str) -> Result<Repository> {
    let path = root(path)?;
    let remote = git(&path, &["remote", "get-url", "origin"])
        .ok()
        .and_then(|r| sanitize_remote(&r).ok());
    let id = uuid::Uuid::new_v4().to_string();
    let branch = git(&path, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .unwrap_or_else(|_| "HEAD".into());
    let default_branch = git(
        &path,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )
    .ok()
    .map(|s| text(s.trim().trim_start_matches("origin/"), 120));
    Ok(Repository {
        id: id.clone(),
        workspace_id: workspace.into(),
        server_id: None,
        identity: remote.clone().unwrap_or_else(|| format!("local/{id}")),
        name: text(
            path.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("Repository"),
            120,
        ),
        file_id: file_id(&path),
        path,
        remote,
        branch: text(branch.trim(), 120),
        default_branch,
        mode: "manual".into(),
        last_activity: None,
        error: None,
        baseline: None,
    })
}
fn ignored(path: &str) -> bool {
    path.split('/').any(|s| {
        matches!(
            s,
            "node_modules" | "target" | "dist" | "build" | ".next" | "coverage" | "vendor" | ".git"
        )
    }) || path.ends_with(".lock")
        || path.ends_with("-lock.json")
        || path.ends_with(".log")
        || path.ends_with(".running-tab.json")
}
pub fn sample(repo: &Repository) -> Result<Sample> {
    if std::fs::canonicalize(&repo.path).ok().as_ref() != Some(&repo.path)
        || file_id(&repo.path) != repo.file_id
    {
        return Err(
            "Repository moved or changed identity; select it again before observing.".into(),
        );
    }
    // ls-files enumerates names; stat inspects metadata only. Never follows symlinks.
    let files = git(
        &repo.path,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
    )?;
    let mut hash = DefaultHasher::new();
    let mut names: Vec<_> = files
        .split('\0')
        .filter(|s| !s.is_empty() && !ignored(s))
        .collect();
    names.sort_unstable();
    names.dedup();
    if names.len() > 20000 {
        return Err("Repository exceeds the 20,000-file observation limit.".into());
    }
    for name in names {
        let relative = Path::new(name);
        if relative.is_absolute()
            || relative
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            continue;
        }
        let path = repo.path.join(relative);
        // Canonicalization checks parent symlinks as well as the leaf.
        if path
            .canonicalize()
            .is_ok_and(|p| !p.starts_with(&repo.path))
        {
            continue;
        }
        if let Ok(meta) = std::fs::symlink_metadata(path)
            && meta.is_file()
        {
            name.hash(&mut hash);
            meta.len().hash(&mut hash);
            meta.modified().ok().hash(&mut hash);
        }
    }
    let branch = git(&repo.path, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .unwrap_or_else(|_| "HEAD".into());
    let head = git(&repo.path, &["rev-parse", "--verify", "HEAD"]).unwrap_or_default();
    Ok(Sample {
        fingerprint: hash.finish(),
        branch: text(branch.trim(), 120),
        head: text(head.trim(), 64),
    })
}
pub fn discover(path: &Path) -> Result<Vec<PathBuf>> {
    let selected = std::fs::canonicalize(path).map_err(|_| "Workspace directory unavailable")?;
    let mut stack = vec![(selected, 0)];
    let mut out = Vec::new();
    let mut visited = 0;
    while let Some((dir, depth)) = stack.pop() {
        visited += 1;
        if visited > 2000 || out.len() >= 100 {
            break;
        }
        if dir.join(".git").exists() {
            if let Ok(r) = root(&dir) {
                out.push(r);
            }
            continue;
        }
        if depth >= 4 {
            continue;
        }
        if let Ok(children) = std::fs::read_dir(&dir) {
            for child in children.flatten() {
                if child
                    .file_type()
                    .is_ok_and(|t| t.is_dir() && !t.is_symlink())
                {
                    let name = child.file_name().to_string_lossy().to_string();
                    if !name.starts_with('.') && !ignored(&name) {
                        stack.push((child.path(), depth + 1));
                    }
                }
            }
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}
impl Tracker {
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let mut t: Self = serde_json::from_slice(
            &std::fs::read(path).map_err(|_| "Local activity could not be read")?,
        )
        .map_err(|_| "Local activity is invalid; restore its backup before tracking")?;
        // A restart is a boundary; never credit the gap since the previous process.
        for s in &mut t.sessions {
            if ["active", "paused"].contains(&s.state.as_str()) {
                s.state = "completed".into();
                s.event(
                    s.ended_at,
                    "interrupted",
                    "Application restarted; offline gap excluded.",
                );
            }
        }
        Ok(t)
    }
    pub fn save(&self, path: &Path) -> Result<()> {
        let parent = path.parent().ok_or("Invalid activity store")?;
        std::fs::create_dir_all(parent).map_err(|_| "Cannot create local activity store")?;
        let tmp = path.with_extension("tmp");
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp).map_err(|_| "Cannot save local activity")?;
        use std::io::Write;
        f.write_all(&serde_json::to_vec(self).map_err(|_| "Cannot encode local activity")?)
            .map_err(|_| "Cannot write local activity")?;
        f.sync_all().map_err(|_| "Cannot persist local activity")?;
        std::fs::rename(tmp, path).map_err(|_| "Cannot replace local activity store".into())
    }
    pub fn add(&mut self, path: &Path, workspace: &str) -> Result<Repository> {
        let r = inspect(path, workspace)?;
        if let Some(existing) = self
            .repositories
            .iter_mut()
            .find(|e| e.workspace_id == workspace && (e.path == r.path || e.file_id == r.file_id))
        {
            existing.path = r.path;
            existing.name = r.name;
            existing.remote = r.remote;
            return Ok(existing.clone());
        }
        if self.repositories.len() >= 200 {
            return Err("Limit of 200 approved repository paths reached.".into());
        }
        self.repositories.push(r.clone());
        Ok(r)
    }
    pub fn finish(&mut self, repo_id: &str, reason: &str) {
        for s in &mut self.sessions {
            if s.repository_id == repo_id && ["active", "paused"].contains(&s.state.as_str()) {
                s.state = "completed".into();
                s.event(s.ended_at, "completed", reason);
            }
        }
    }
    pub fn reset_baselines(&mut self) {
        for r in &mut self.repositories {
            r.baseline = None;
        }
        self.last_poll = None;
    }
    pub fn poll(&mut self, workspace: &str, at: u64) {
        let samples: Vec<_> = self
            .repositories
            .iter()
            .filter(|r| r.workspace_id == workspace && r.mode != "manual" && r.server_id.is_some())
            .map(|r| (r.id.clone(), sample(r)))
            .collect();
        self.observe(samples, at);
    }
    pub fn observe(&mut self, samples: Vec<(String, Result<Sample>)>, at: u64) {
        let interrupted = self
            .last_poll
            .is_some_and(|last| at < last || at.saturating_sub(last) > 90);
        if interrupted {
            let ids: Vec<_> = self.repositories.iter().map(|r| r.id.clone()).collect();
            for id in ids {
                self.finish(&id, "Sleep or observation gap; gap excluded.");
            }
            self.reset_baselines();
        }
        self.last_poll = Some(at);
        let changed: Vec<_> = samples
            .iter()
            .filter_map(|(id, s)| {
                let r = self.repositories.iter().find(|r| &r.id == id)?;
                let old = r.baseline.as_ref()?;
                let new = s.as_ref().ok()?;
                (old.fingerprint != new.fingerprint
                    || old.head != new.head
                    || old.branch != new.branch)
                    .then_some(id.clone())
            })
            .collect();
        let simultaneous = changed.len() > 1;
        for (id, result) in samples {
            let Some(index) = self.repositories.iter().position(|r| r.id == id) else {
                continue;
            };
            let new = match result {
                Ok(s) => s,
                Err(e) => {
                    self.finish(&id, "Observation interrupted; duration needs review.");
                    self.repositories[index].error = Some(e);
                    self.repositories[index].baseline = None;
                    continue;
                }
            };
            self.repositories[index].error = None;
            let old = self.repositories[index].baseline.replace(new.clone());
            self.repositories[index].branch = new.branch.clone();
            let Some(old) = old else { continue };
            let branch_changed = old.branch != new.branch;
            let file_changed = old.fingerprint != new.fingerprint;
            let commit_changed = old.head != new.head;
            if branch_changed {
                self.finish(&id, "Branch changed; prior session ended.");
            }
            let activity = file_changed || branch_changed || commit_changed;
            if activity {
                // A change of repository closes other open sessions; they cannot earn concurrent time.
                let others: Vec<_> = self
                    .sessions
                    .iter()
                    .filter(|s| {
                        s.repository_id != id && ["active", "paused"].contains(&s.state.as_str())
                    })
                    .map(|s| s.repository_id.clone())
                    .collect();
                for other in others {
                    self.finish(&other, "Repository changed; verify context.");
                }
                let current = self.sessions.iter().position(|s| {
                    s.repository_id == id && ["active", "paused"].contains(&s.state.as_str())
                });
                let current = if let Some(i) = current {
                    if at.saturating_sub(self.sessions[i].ended_at) > self.settings.merge_seconds
                        || at.saturating_sub(self.sessions[i].started_at) > 86400
                        || self.sessions[i].evidence.len() > 490
                    {
                        self.finish(&id, "Activity gap; no time inferred across gap.");
                        None
                    } else {
                        Some(i)
                    }
                } else {
                    None
                };
                let i = current.unwrap_or_else(|| {
                    self.sessions.push(Session {
                        id: uuid::Uuid::new_v4().to_string(),
                        repository_id: id.clone(),
                        branch: new.branch.clone(),
                        started_at: at,
                        ended_at: at,
                        inferred_seconds: 0,
                        evidence: vec![Evidence {
                            at,
                            kind: "started".into(),
                            detail: "Metadata activity detected".into(),
                        }],
                        state: "active".into(),
                    });
                    self.sessions.len() - 1
                });
                let session = &mut self.sessions[i];
                let previous_file = session
                    .evidence
                    .iter()
                    .rev()
                    .find(|e| e.kind == "file_activity")
                    .map(|e| e.at);
                // Only intervals bracketed by file changes count. Commits/branch switches add zero.
                if file_changed
                    && !session.evidence.iter().any(|e| e.kind == "simultaneous")
                    && !branch_changed
                    && !simultaneous
                    && previous_file == Some(session.ended_at)
                {
                    session.inferred_seconds += at.saturating_sub(session.ended_at);
                }
                session.ended_at = at;
                session.state = "active".into();
                if simultaneous {
                    session.inferred_seconds = 0;
                    session.event(
                        at,
                        "simultaneous",
                        "Multiple repositories changed; enter duration manually.",
                    );
                }
                if branch_changed {
                    session.event(
                        at,
                        "branch_changed",
                        "Branch transition detected; check mapping.",
                    );
                }
                if commit_changed {
                    session.event(at, "commit_detected", &new.head);
                }
                if file_changed && !branch_changed {
                    session.event(
                        at,
                        "file_activity",
                        "File metadata changed; contents were not read.",
                    );
                }
                self.repositories[index].last_activity = Some(at);
            } else if let Some(i) = self.sessions.iter().position(|s| {
                s.repository_id == id && ["active", "paused"].contains(&s.state.as_str())
            }) {
                let gap = at.saturating_sub(self.sessions[i].ended_at);
                if gap >= self.settings.idle_seconds {
                    self.finish(&id, "Idle threshold reached; idle time excluded.");
                } else if gap >= self.settings.merge_seconds && self.sessions[i].state != "paused" {
                    let s = &mut self.sessions[i];
                    s.state = "paused".into();
                    s.event(
                        s.ended_at,
                        "idle",
                        "No recent file activity; idle time excluded.",
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn repository(id: &str) -> Repository {
        Repository {
            id: id.into(),
            workspace_id: "w".into(),
            server_id: Some(id.into()),
            identity: format!("local/{id}"),
            name: id.into(),
            path: PathBuf::from("/not-inspected"),
            remote: None,
            branch: "main".into(),
            default_branch: None,
            mode: "assisted".into(),
            last_activity: None,
            error: None,
            file_id: id.into(),
            baseline: None,
        }
    }
    fn tracker() -> Tracker {
        Tracker {
            repositories: vec![repository("one")],
            ..Default::default()
        }
    }
    fn observation(t: &mut Tracker, at: u64, fingerprint: u64, branch: &str, head: &str) {
        t.observe(
            vec![(
                "one".into(),
                Ok(Sample {
                    fingerprint,
                    branch: branch.into(),
                    head: head.into(),
                }),
            )],
            at,
        );
    }
    #[test]
    fn normal_85_minute_session_and_repeated_scans() {
        let mut t = tracker();
        observation(&mut t, 0, 0, "main", "a");
        for n in 1..=171 {
            observation(&mut t, n * 30, n, "main", "a");
        }
        assert_eq!(t.sessions.len(), 1);
        assert_eq!(t.sessions[0].inferred_seconds, 5100);
        observation(&mut t, 5160, 171, "main", "a");
        assert_eq!(t.sessions[0].inferred_seconds, 5100);
        t.finish("one", "Review");
        assert_eq!(t.sessions[0].state, "completed");
    }
    #[test]
    fn commit_only_is_not_duration() {
        let mut t = tracker();
        observation(&mut t, 0, 0, "main", "a");
        for n in 1..=20 {
            observation(&mut t, n * 30, 0, "main", if n < 10 { "b" } else { "c" });
        }
        assert!(t.sessions.iter().all(|s| s.inferred_seconds == 0));
    }
    #[test]
    fn idle_pauses_and_completes_without_tail_credit() {
        let mut t = tracker();
        observation(&mut t, 0, 0, "main", "a");
        observation(&mut t, 30, 1, "main", "a");
        observation(&mut t, 60, 2, "main", "a");
        for at in (90..=360).step_by(30) {
            observation(&mut t, at, 2, "main", "a");
        }
        assert_eq!(t.sessions[0].state, "paused");
        assert_eq!(t.sessions[0].ended_at, 60);
        for at in (390..=660).step_by(30) {
            observation(&mut t, at, 2, "main", "a");
        }
        assert_eq!(t.sessions[0].state, "completed");
        assert_eq!(t.sessions[0].inferred_seconds, 30);
    }
    #[test]
    fn short_gap_merges_and_long_gap_does_not() {
        let mut t = tracker();
        observation(&mut t, 0, 0, "main", "a");
        observation(&mut t, 30, 1, "main", "a");
        for at in (60..=300).step_by(30) {
            observation(&mut t, at, 1, "main", "a");
        }
        observation(&mut t, 330, 2, "main", "a");
        assert_eq!(t.sessions[0].inferred_seconds, 300);
        for at in (360..=660).step_by(30) {
            observation(&mut t, at, 2, "main", "a");
        }
        observation(&mut t, 690, 3, "main", "a");
        assert_eq!(t.sessions.len(), 2);
        assert_eq!(t.sessions[1].inferred_seconds, 0);
    }
    #[test]
    fn branch_switch_closes_session_and_checkout_is_not_work() {
        let mut t = tracker();
        observation(&mut t, 0, 0, "main", "a");
        observation(&mut t, 30, 1, "main", "a");
        observation(&mut t, 60, 2, "main", "a");
        observation(&mut t, 90, 3, "feature/b", "b");
        assert_eq!(t.sessions.len(), 2);
        assert_eq!(t.sessions[0].state, "completed");
        assert_eq!(t.sessions[1].inferred_seconds, 0);
        observation(&mut t, 120, 4, "feature/b", "b");
        assert_eq!(t.sessions[1].inferred_seconds, 0);
        observation(&mut t, 150, 5, "feature/b", "b");
        assert_eq!(t.sessions[1].inferred_seconds, 30);
    }
    #[test]
    fn sleep_clock_rollback_and_error_break_continuity() {
        let mut t = tracker();
        observation(&mut t, 0, 0, "main", "a");
        observation(&mut t, 30, 1, "main", "a");
        observation(&mut t, 60, 2, "main", "a");
        observation(&mut t, 5000, 3, "main", "a");
        assert_eq!(t.sessions[0].inferred_seconds, 30);
        assert_eq!(t.sessions[0].state, "completed");
        observation(&mut t, 5030, 4, "main", "a");
        observation(&mut t, 2, 5, "main", "a");
        assert_eq!(t.sessions[1].state, "completed");
        observation(&mut t, 32, 6, "main", "a");
        t.observe(
            vec![("one".into(), Err("Repository unavailable".into()))],
            62,
        );
        assert!(t.sessions.iter().all(|s| s.state == "completed"));
    }
    #[test]
    fn simultaneous_and_switched_repositories_never_double_count() {
        let mut t = tracker();
        t.repositories.push(repository("two"));
        let pair = |a, b| {
            vec![
                (
                    "one".into(),
                    Ok(Sample {
                        fingerprint: a,
                        branch: "main".into(),
                        head: "a".into(),
                    }),
                ),
                (
                    "two".into(),
                    Ok(Sample {
                        fingerprint: b,
                        branch: "main".into(),
                        head: "a".into(),
                    }),
                ),
            ]
        };
        t.observe(pair(0, 0), 0);
        t.observe(pair(1, 1), 30);
        t.observe(pair(2, 2), 60);
        assert!(t.sessions.iter().all(|s| s.inferred_seconds == 0));
        t.observe(pair(2, 3), 90);
        assert!(t.sessions.iter().all(|s| s.inferred_seconds == 0));
        assert_eq!(t.sessions.iter().filter(|s| s.state == "active").count(), 1);
    }
    #[test]
    fn restart_preserves_ids_and_excludes_unobserved_gap() {
        let dir = temp();
        let store = dir.join("activity.json");
        let mut t = tracker();
        observation(&mut t, 0, 0, "main", "a");
        observation(&mut t, 30, 1, "main", "a");
        t.save(&store).unwrap();
        let id = t.sessions[0].id.clone();
        let mut loaded = Tracker::load(&store).unwrap();
        assert_eq!(loaded.sessions[0].id, id);
        assert_eq!(loaded.sessions[0].state, "completed");
        observation(&mut loaded, 10000, 3, "main", "a");
        assert_eq!(loaded.sessions.len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
    fn temp() -> PathBuf {
        let p = std::env::temp_dir().join(format!("running-tab-tracking-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }
    fn init(p: &Path) {
        std::fs::create_dir_all(p).unwrap();
        assert!(
            std::process::Command::new("git")
                .args(["init", "-q"])
                .arg(p)
                .status()
                .unwrap()
                .success()
        );
    }
    #[test]
    fn discovery_is_bounded_and_supports_no_remote_canonical_and_renamed_repositories() {
        let dir = temp();
        let path = dir.join("repo");
        init(&path);
        let deep = dir.join("a/b/c/d/e/repo");
        init(&deep);
        let hidden = dir.join("node_modules/repo");
        init(&hidden);
        let found = discover(&dir).unwrap();
        assert_eq!(found.len(), 1);
        let mut t = Tracker::default();
        let r = t.add(&path, "w").unwrap();
        assert!(r.remote.is_none());
        assert!(r.identity.starts_with("local/"));
        assert_eq!(r.mode, "manual");
        assert_eq!(t.add(&path.join("."), "w").unwrap().id, r.id);
        let moved = dir.join("renamed");
        std::fs::rename(&path, &moved).unwrap();
        assert_eq!(t.add(&moved, "w").unwrap().id, r.id);
        assert_eq!(t.repositories.len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn file_observation_ignores_generated_noise_and_external_symlinks() {
        let dir = temp();
        init(&dir);
        let r = inspect(&dir, "w").unwrap();
        std::fs::write(dir.join("source.rs"), "one").unwrap();
        let a = sample(&r).unwrap();
        std::fs::write(dir.join("source.rs"), "a longer edit").unwrap();
        let b = sample(&r).unwrap();
        assert_ne!(a.fingerprint, b.fingerprint);
        std::fs::create_dir_all(dir.join("dist")).unwrap();
        std::fs::write(dir.join("dist/output.js"), "generated").unwrap();
        assert_eq!(sample(&r).unwrap().fingerprint, b.fingerprint);
        #[cfg(unix)]
        {
            let other = temp();
            std::fs::write(other.join("private"), "private").unwrap();
            std::os::unix::fs::symlink(other.join("private"), dir.join("external")).unwrap();
            assert_eq!(sample(&r).unwrap().fingerprint, b.fingerprint);
            std::fs::remove_dir_all(other).unwrap();
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn disabled_repository_is_not_observed_and_thresholds_are_validated() {
        let mut t = tracker();
        t.repositories[0].mode = "manual".into();
        t.poll("w", 0);
        assert!(t.sessions.is_empty());
        assert!(t.repositories[0].error.is_none());
        assert!(
            Settings {
                idle_seconds: 60,
                merge_seconds: 300,
                minimum_seconds: 300
            }
            .validate()
            .is_err()
        );
    }
    #[test]
    fn midnight_is_utc_continuity_not_a_session_reset() {
        let mut t = tracker();
        observation(&mut t, 86340, 0, "main", "a");
        observation(&mut t, 86370, 1, "main", "a");
        observation(&mut t, 86400, 2, "main", "a");
        assert_eq!(t.sessions[0].inferred_seconds, 30);
    }
}
