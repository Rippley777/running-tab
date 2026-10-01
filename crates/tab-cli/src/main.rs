use clap::{Parser, Subcommand};
use serde_json::{Value, json};
use std::{
    io::{self, Write},
    path::PathBuf,
};
use tab_core::{default_client, git_context};
#[derive(Parser)]
#[command(
    name = "tab",
    about = "Intentional time tracking and Git context for Running Tab"
)]
struct Cli {
    #[command(subcommand)]
    command: Action,
}
#[derive(Subcommand)]
enum Action {
    Login,
    Logout,
    Projects,
    Link {
        #[arg(long)]
        project: String,
        #[arg(long)]
        yes: bool,
    },
    Start {
        #[arg(long)]
        project: Option<String>,
        #[arg(long, default_value = "")]
        description: String,
    },
    Stop,
    Status,
    Context {
        #[arg(long)]
        since: String,
        #[arg(long)]
        include_subjects: bool,
        #[arg(long)]
        include_branch: bool,
        #[arg(long)]
        upload: bool,
        #[arg(long)]
        yes: bool,
    },
}
fn confirm(prompt: &str) -> bool {
    print!("{prompt} [y/N] ");
    let _ = io::stdout().flush();
    let mut s = String::new();
    io::stdin().read_line(&mut s).is_ok() && s.trim().eq_ignore_ascii_case("y")
}
fn run() -> tab_core::Result<()> {
    let cli = Cli::parse();
    let client = default_client()?.for_cli();
    let key = uuid::Uuid::new_v4().to_string();
    let cwd = std::env::current_dir().map_err(|_| "Cannot access current directory")?;
    let file: PathBuf = cwd.join(".running-tab.json");
    let result = match cli.command {
        Action::Login => {
            print!("Paste the CLI token from Settings → Developer tools: ");
            io::stdout().flush().map_err(|_| "Cannot read input")?;
            let mut token = String::new();
            io::stdin()
                .read_line(&mut token)
                .map_err(|_| "Cannot read token")?;
            client.connect(token.trim())?;
            json!({"connected":true,"storage":"system keychain"})
        }
        Action::Logout => {
            let _ = client.request("POST", "/api/sign-out", Some(json!({})), None);
            client.forget_token()?;
            json!({"signedOut":true})
        }
        Action::Projects => client.request("GET", "/api/v1/projects", None, None)?,
        Action::Link { project, yes } => {
            let context = git_context(&cwd, "1970-01-01", false, false)?;
            println!(
                "Repository identity: {}\nProject: {}\nNo source code or filesystem paths will be uploaded.",
                context.identity, project
            );
            if !yes && !confirm("Link this repository?") {
                return Ok(());
            }
            let data = client.request(
                "POST",
                "/api/v1/repositories",
                Some(json!({"projectId":project,"identity":context.identity,"alias":""})),
                Some(&key),
            )?;
            std::fs::write(
                file,
                serde_json::to_string_pretty(
                    &json!({"projectId":project,"identity":context.identity}),
                )
                .unwrap(),
            )
            .map_err(|_| "Unable to write .running-tab.json")?;
            data
        }
        Action::Start {
            project,
            description,
        } => {
            let project = match project {
                Some(p) => p,
                None => {
                    let local: Value = serde_json::from_str(
                        &std::fs::read_to_string(file)
                            .map_err(|_| "Run tab link --project <id> first")?,
                    )
                    .map_err(|_| "Invalid local mapping")?;
                    local["projectId"]
                        .as_str()
                        .ok_or("Missing project ID")?
                        .to_owned()
                }
            };
            client.request("POST","/api/v1/timer",Some(json!({"action":"start","projectId":project,"description":description,"billable":true})),Some(&key))?
        }
        Action::Stop => {
            let state = client.request("GET", "/api/v1/timer", None, None)?;
            let version = state["timer"]["version"]
                .as_i64()
                .ok_or("No active timer")?;
            client.request(
                "POST",
                "/api/v1/timer",
                Some(json!({"action":"stop","version":version})),
                Some(&key),
            )?
        }
        Action::Status => client.request("GET", "/api/v1/timer", None, None)?,
        Action::Context {
            since,
            include_subjects,
            include_branch,
            upload,
            yes,
        } => {
            let ctx = git_context(&cwd, &since, include_subjects, include_branch)?;
            let value = serde_json::to_value(ctx).unwrap();
            if upload {
                println!("{}", serde_json::to_string_pretty(&value).unwrap());
                if !yes && !confirm("Upload exactly this metadata?") {
                    return Ok(());
                }
                client.request("POST", "/api/v1/activity", Some(value), Some(&key))?
            } else {
                value
            }
        }
    };
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
