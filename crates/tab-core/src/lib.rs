use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{path::Path, process::Command, time::Duration};
use url::Url;

pub type Result<T> = std::result::Result<T, String>;
#[derive(Clone)]
pub struct Client {
    base: Url,
    app_origin: String,
    http: reqwest::blocking::Client,
    cli_credential: bool,
}
impl Client {
    pub fn new(base: &str, app_origin: &str) -> Result<Self> {
        let url = Url::parse(base).map_err(|_| "Invalid API URL")?;
        let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if url.scheme() != "https" && !(local && cfg!(debug_assertions)) {
            return Err("Cloud connections require HTTPS. HTTP is only allowed on loopback in debug builds.".into());
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err("Credentials are not allowed in API URLs.".into());
        }
        let http = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(25))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("RunningTab/0.1 native")
            .build()
            .map_err(|_| "Unable to initialize HTTP transport")?;
        Ok(Self {
            base: url,
            app_origin: app_origin.to_owned(),
            http,
            cli_credential: false,
        })
    }
    fn entry(&self) -> Result<keyring::Entry> {
        let account = if self.cli_credential {
            format!("{}#cli", self.base)
        } else {
            self.base.to_string()
        };
        keyring::Entry::new("com.runningtab.desktop", &account)
            .map_err(|_| "The system keychain is unavailable. No token was saved.".into())
    }
    pub fn for_cli(mut self) -> Self {
        self.cli_credential = true;
        self
    }
    pub fn save_token(&self, token: &str) -> Result<()> {
        self.entry()?
            .set_password(token)
            .map_err(|_| "Could not save the session in the system keychain.".into())
    }
    pub fn token(&self) -> Option<String> {
        std::env::var("RUNNING_TAB_TOKEN")
            .ok()
            .or_else(|| self.entry().ok()?.get_password().ok())
    }
    pub fn forget_token(&self) -> Result<()> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Could not remove the keychain credential.".into()),
        }
    }
    pub fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        key: Option<&str>,
    ) -> Result<Value> {
        let text = self.request_text(method, path, body, key)?;
        serde_json::from_str(&text).map_err(|_| "The server returned an invalid response.".into())
    }
    pub fn request_text(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        key: Option<&str>,
    ) -> Result<String> {
        if !path.starts_with("/api/")
            || path.contains("..")
            || path.contains('\\')
            || path.contains("%2")
            || path.starts_with("//")
        {
            return Err("Invalid API path.".into());
        }
        let method = match method {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            "PATCH" => reqwest::Method::PATCH,
            "PUT" => reqwest::Method::PUT,
            "DELETE" => reqwest::Method::DELETE,
            _ => return Err("Unsupported method".into()),
        };
        let mut req = self
            .http
            .request(
                method,
                self.base.join(path).map_err(|_| "Invalid API path")?,
            )
            .header("Origin", &self.app_origin);
        if let Some(token) = self.token() {
            req = req.bearer_auth(token);
        }
        if let Some(body) = body {
            req = req.json(&body);
        }
        if let Some(key) = key {
            req = req.header("Idempotency-Key", key);
        }
        let res = req.send().map_err(|_| {
            "Unable to reach your workspace. Input is preserved. Reconnect before retrying."
                .to_owned()
        })?;
        let status = res.status();
        let text = res
            .text()
            .map_err(|_| "The server response was interrupted.")?;
        if !status.is_success() {
            return Err(text);
        }
        Ok(text)
    }
    pub fn login_demo(&self) -> Result<()> {
        let data = self.request("POST", "/api/demo/sign-in", Some(json!({})), None)?;
        let token = data["token"].as_str().ok_or("Sign-in failed")?;
        self.save_token(token)
    }
    pub fn connect(&self, token: &str) -> Result<()> {
        if !token.starts_with("rt_") || token.len() > 200 {
            return Err("Paste a desktop connection token from your signed-in workspace.".into());
        }
        let res = self
            .http
            .get(self.base.join("/api/session").unwrap())
            .bearer_auth(token)
            .send()
            .map_err(|_| "Cannot reach the workspace")?;
        if !res.status().is_success() {
            return Err("This device token is invalid, expired, or revoked.".into());
        }
        self.save_token(token)
    }
}
pub fn default_client() -> Result<Client> {
    let base = std::env::var("RUNNING_TAB_API_URL").unwrap_or_else(|_| {
        option_env!("RUNNING_TAB_API_URL")
            .unwrap_or("http://localhost:3001")
            .to_owned()
    });
    let app = std::env::var("RUNNING_TAB_APP_URL").unwrap_or_else(|_| {
        option_env!("RUNNING_TAB_APP_URL")
            .unwrap_or("http://localhost:1420")
            .to_owned()
    });
    Client::new(&base, &app)
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    #[serde(rename = "ref")]
    pub reference: String,
    pub occurred_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct GitContext {
    pub identity: String,
    pub commits: Vec<Commit>,
}
pub fn sanitize_remote(remote: &str) -> Result<String> {
    let r = remote.trim();
    let (host, path) = if r.contains("://") {
        let u = Url::parse(r).map_err(|_| "Invalid repository remote")?;
        (
            u.host_str().ok_or("Remote has no host")?.to_owned(),
            u.path().trim_start_matches('/').to_owned(),
        )
    } else {
        let (left, right) = r
            .split_once(':')
            .ok_or("Use a hosted repository remote; local paths are never uploaded.")?;
        (
            left.rsplit('@').next().unwrap_or(left).to_owned(),
            right.to_owned(),
        )
    };
    let path = path.trim_end_matches('/').trim_end_matches(".git");
    let identity = format!("{host}/{path}");
    if host.is_empty()
        || !path.contains('/')
        || identity.contains("..")
        || identity.len() > 250
        || !identity
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-/".contains(c))
    {
        return Err("Remote is not a safe hosted repository identity.".into());
    }
    Ok(identity)
}
fn git(path: &Path, args: &[&str]) -> Result<String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    let mut child = Command::new("git")
        .arg("-C")
        .arg(path)
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "pager.log=false",
        ])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Git is not installed")?;
    let stdout = child.stdout.take().ok_or("Git output unavailable")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes);
        (result, bytes)
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < Duration::from_secs(5) => {
                std::thread::sleep(Duration::from_millis(10))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err("Git metadata inspection timed out; tracking paused.".into());
            }
        }
    };
    let (result, bytes) = reader.join().map_err(|_| "Git output task failed")?;
    if !status.success() || result.is_err() || bytes.len() > 16 * 1024 * 1024 {
        return Err("Git metadata unavailable or exceeds the safe size limit.".into());
    }
    String::from_utf8(bytes).map_err(|_| "Git output is not valid UTF-8".into())
}

pub fn git_context(
    path: &Path,
    since: &str,
    subjects: bool,
    branch_names: bool,
) -> Result<GitContext> {
    if since.len() != 10 || !since.chars().all(|c| c.is_ascii_digit() || c == '-') {
        return Err("Use --since YYYY-MM-DD".into());
    }
    let identity = sanitize_remote(&git(path, &["remote", "get-url", "origin"])?)?;
    let head = git(path, &["rev-parse", "--verify", "HEAD"]).unwrap_or_default();
    let branch = if branch_names {
        Some(
            git(path, &["branch", "--show-current"])?
                .trim()
                .chars()
                .take(120)
                .collect::<String>(),
        )
    } else {
        None
    };
    let format = if subjects {
        "--format=%H%x1f%cI%x1f%s"
    } else {
        "--format=%H%x1f%cI"
    };
    let since_arg = format!("--since={since}");
    let output = git(
        path,
        &[
            "--no-pager",
            "log",
            "--no-show-signature",
            "--max-count=100",
            &since_arg,
            format,
            "--",
        ],
    )?;
    let commits = output
        .lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split('\u{1f}').collect();
            if fields.len() < 2 {
                return None;
            }
            Some(Commit {
                reference: fields[0].to_owned(),
                occurred_at: fields[1].to_owned(),
                subject: if subjects {
                    fields.get(2).map(|s| s.chars().take(250).collect())
                } else {
                    None
                },
                branch: if fields[0] == head.trim() {
                    branch.clone()
                } else {
                    None
                },
            })
        })
        .collect();
    Ok(GitContext { identity, commits })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strips_credentials_and_query() {
        assert_eq!(
            sanitize_remote("https://secret:token@github.com/owner/repo.git?token=secret").unwrap(),
            "github.com/owner/repo"
        );
    }
    #[test]
    fn sanitizes_ssh() {
        assert_eq!(
            sanitize_remote("git@github.com:owner/repo.git").unwrap(),
            "github.com/owner/repo"
        );
    }
    #[test]
    fn rejects_paths() {
        assert!(sanitize_remote("/Users/alex/project").is_err());
        assert!(sanitize_remote("file:///Users/alex/project").is_err());
        assert!(sanitize_remote("git@github.com:../secret").is_err());
    }
    #[test]
    fn rejects_remote_plain_http() {
        assert!(Client::new("http://example.com", "https://example.com").is_err());
    }
}

pub mod tracking;
