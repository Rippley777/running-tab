use serde_json::Value;
use std::sync::Mutex;
use tab_core::{Client, default_client};
use tauri::{Manager, State};
struct NativeState {
    client: Client,
    repository: Mutex<Option<std::path::PathBuf>>,
    tracking: Mutex<TrackingState>,
}
struct TrackingState {
    tracker: tab_core::tracking::Tracker,
    path: std::path::PathBuf,
    workspace: Option<String>,
    error: Option<String>,
}
#[tauri::command]
async fn tracking_state(
    state: State<'_, NativeState>,
    workspace_id: String,
) -> Result<Value, String> {
    let local = state
        .tracking
        .lock()
        .map_err(|_| "Activity state unavailable")?;
    if let Some(error) = &local.error {
        return Err(error.clone());
    }
    if local.workspace.as_ref() != Some(&workspace_id) {
        return Err("Open your authenticated workspace before viewing local activity.".into());
    }
    Ok(serde_json::json!({
        "repositories":local.tracker.repositories.iter().filter(|r|r.workspace_id==workspace_id).collect::<Vec<_>>(),
        "sessions":local.tracker.sessions.iter().filter(|s| local.tracker.repositories.iter().any(|r|r.id==s.repository_id&&r.workspace_id==workspace_id)).collect::<Vec<_>>(),
        "settings":local.tracker.settings,
    }))
}
#[tauri::command]
async fn tracking_discover(
    state: State<'_, NativeState>,
    workspace_id: String,
    workspace: bool,
    manual_path: Option<String>,
) -> Result<Value, String> {
    {
        let local = state
            .tracking
            .lock()
            .map_err(|_| "Activity state unavailable")?;
        if local.workspace.as_ref() != Some(&workspace_id) {
            return Err("Open your authenticated workspace first".into());
        }
    }
    let path = if let Some(p) = manual_path {
        std::path::PathBuf::from(p)
    } else {
        rfd::AsyncFileDialog::new()
            .set_title(if workspace {
                "Choose an approved workspace (up to four levels)"
            } else {
                "Choose a repository"
            })
            .pick_folder()
            .await
            .ok_or("Selection cancelled")?
            .path()
            .to_path_buf()
    };
    let selected = path.clone();
    let paths = tauri::async_runtime::spawn_blocking(move || {
        if workspace {
            tab_core::tracking::discover(&path)
        } else {
            Ok(vec![path])
        }
    })
    .await
    .map_err(|_| "Discovery failed")??;
    let mut local = state
        .tracking
        .lock()
        .map_err(|_| "Activity state unavailable")?;
    if local.workspace.as_ref() != Some(&workspace_id) {
        return Err("Workspace changed during selection".into());
    }
    if local.error.is_some() {
        return Err("Local activity storage needs repair before tracking".into());
    }
    for path in paths {
        local.tracker.add(&path, &workspace_id)?;
    }
    if workspace {
        let canonical = std::fs::canonicalize(selected).map_err(|_| "Workspace unavailable")?;
        if !local.tracker.workspaces.contains(&canonical) {
            local.tracker.workspaces.push(canonical);
        }
    }
    local.tracker.save(&local.path)?;
    Ok(serde_json::json!({"ok":true}))
}
#[tauri::command]
async fn tracking_configure(
    state: State<'_, NativeState>,
    repository_id: String,
    server_id: Option<String>,
    mode: String,
) -> Result<(), String> {
    if !["manual", "assisted", "automatic"].contains(&mode.as_str()) {
        return Err("Unknown tracking mode".into());
    }
    let mut local = state
        .tracking
        .lock()
        .map_err(|_| "Activity state unavailable")?;
    if !local
        .tracker
        .repositories
        .iter()
        .any(|r| r.id == repository_id && Some(&r.workspace_id) == local.workspace.as_ref())
    {
        return Err("Repository is outside the active workspace".into());
    }
    local
        .tracker
        .finish(&repository_id, "Tracking configuration changed");
    let r = local
        .tracker
        .repositories
        .iter_mut()
        .find(|r| r.id == repository_id)
        .ok_or("Repository not found")?;
    r.server_id = server_id;
    r.mode = mode;
    local.tracker.reset_baselines();
    local.tracker.save(&local.path)
}
#[tauri::command]
async fn tracking_settings(
    state: State<'_, NativeState>,
    settings: tab_core::tracking::Settings,
) -> Result<(), String> {
    settings.validate()?;
    let mut local = state
        .tracking
        .lock()
        .map_err(|_| "Activity state unavailable")?;
    if local.workspace.is_none() {
        return Err("Open your authenticated workspace first".into());
    }
    local.tracker.settings = settings;
    local.tracker.save(&local.path)
}
#[tauri::command]
async fn tracking_finish(
    state: State<'_, NativeState>,
    repository_id: String,
) -> Result<(), String> {
    let mut local = state
        .tracking
        .lock()
        .map_err(|_| "Activity state unavailable")?;
    if !local
        .tracker
        .repositories
        .iter()
        .any(|r| r.id == repository_id && Some(&r.workspace_id) == local.workspace.as_ref())
    {
        return Err("Repository is outside the active workspace".into());
    }
    local.tracker.finish(&repository_id, "Finished for review");
    local.tracker.save(&local.path)
}
#[tauri::command]
async fn tracking_remove_session(state: State<'_, NativeState>, id: String) -> Result<(), String> {
    let mut local = state
        .tracking
        .lock()
        .map_err(|_| "Activity state unavailable")?;
    if let Some(session) = local.tracker.sessions.iter().find(|s| s.id == id)
        && !local.tracker.repositories.iter().any(|r| {
            r.id == session.repository_id && Some(&r.workspace_id) == local.workspace.as_ref()
        })
    {
        return Err("Session is outside the active workspace".into());
    }
    local.tracker.sessions.retain(|s| s.id != id);
    local.tracker.save(&local.path)
}
#[tauri::command]
async fn open_compact_timer(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("timer") {
        window.show().map_err(|_| "Unable to show timer")?;
        return window
            .set_focus()
            .map_err(|_| "Unable to focus timer".into());
    }
    tauri::WebviewWindowBuilder::new(&app, "timer", tauri::WebviewUrl::App("timer".into()))
        .title("Running Tab · Timer")
        .inner_size(480.0, 460.0)
        .min_inner_size(360.0, 380.0)
        .always_on_top(true)
        .build()
        .map_err(|_| "Unable to open timer".to_string())?;
    Ok(())
}
#[tauri::command]
async fn api_request(
    state: State<'_, NativeState>,
    method: String,
    path: String,
    body: Option<Value>,
    key: Option<String>,
) -> Result<Value, String> {
    let client = state.client.clone();
    let snapshot_request = method == "GET" && path.starts_with("/api/v1/snapshot?");
    let result = tauri::async_runtime::spawn_blocking(move || {
        client.request(&method, &path, body, key.as_deref())
    })
    .await
    .map_err(|_| "Native request task failed".to_owned())??;
    if snapshot_request {
        let workspace = result["workspace"]["id"]
            .as_str()
            .ok_or("Workspace response has no identity")?
            .to_owned();
        let mut local = state
            .tracking
            .lock()
            .map_err(|_| "Activity state unavailable")?;
        if local.workspace.as_ref() != Some(&workspace) {
            let ids: Vec<_> = local
                .tracker
                .repositories
                .iter()
                .map(|r| r.id.clone())
                .collect();
            for id in ids {
                local.tracker.finish(&id, "Workspace changed");
            }
            local.tracker.reset_baselines();
            local.workspace = Some(workspace);
        }
    }
    Ok(result)
}
#[tauri::command]
async fn demo_login(state: State<'_, NativeState>) -> Result<(), String> {
    let client = state.client.clone();
    tauri::async_runtime::spawn_blocking(move || client.login_demo())
        .await
        .map_err(|_| "Sign-in task failed".to_owned())?
}
#[tauri::command]
async fn connect_device(state: State<'_, NativeState>, token: String) -> Result<(), String> {
    let client = state.client.clone();
    tauri::async_runtime::spawn_blocking(move || client.connect(&token))
        .await
        .map_err(|_| "Sign-in task failed".to_owned())?
}
#[tauri::command]
async fn sign_out(state: State<'_, NativeState>) -> Result<(), String> {
    {
        let mut local = state
            .tracking
            .lock()
            .map_err(|_| "Activity state unavailable")?;
        let ids: Vec<_> = local
            .tracker
            .repositories
            .iter()
            .map(|r| r.id.clone())
            .collect();
        for id in ids {
            local.tracker.finish(&id, "Signed out");
        }
        local.workspace = None;
        local.tracker.reset_baselines();
        if let Err(error) = local.tracker.save(&local.path) {
            local.error = Some(error);
        }
    }
    let client = state.client.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = client.request("POST", "/api/sign-out", Some(serde_json::json!({})), None);
        client.forget_token()
    })
    .await
    .map_err(|_| "Sign-out task failed".to_owned())?
}
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid URL")?;
    let app = std::env::var("RUNNING_TAB_APP_URL").unwrap_or_else(|_| {
        option_env!("RUNNING_TAB_APP_URL")
            .unwrap_or("http://localhost:1420")
            .to_owned()
    });
    let configured = url::Url::parse(&app).map_err(|_| "Invalid app URL")?;
    let same_origin = parsed.origin() == configured.origin();
    let stripe = parsed.scheme() == "https"
        && matches!(
            parsed.host_str(),
            Some(
                "connect.stripe.com"
                    | "invoice.stripe.com"
                    | "pay.stripe.com"
                    | "checkout.stripe.com"
                    | "billing.stripe.com"
                    | "files.stripe.com"
            )
        );
    if !same_origin && !stripe {
        return Err("External destination is not on the trusted list.".into());
    }
    open::that(url).map_err(|_| "Could not open the browser".into())
}
#[tauri::command]
async fn export_csv(state: State<'_, NativeState>, kind: String) -> Result<bool, String> {
    if ![
        "time",
        "invoices",
        "lines",
        "payments",
        "adjustments",
        "retainers",
    ]
    .contains(&kind.as_str())
    {
        return Err("Unsupported export".into());
    }
    let client = state.client.clone();
    let kind2 = kind.clone();
    let text = tauri::async_runtime::spawn_blocking(move || {
        client.request_text("GET", &format!("/api/v1/exports/{kind2}"), None, None)
    })
    .await
    .map_err(|_| "Export failed")??;
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_file_name(format!("running-tab-{kind}.csv"))
        .add_filter("CSV", &["csv"])
        .save_file()
        .await
    else {
        return Ok(false);
    };
    std::fs::write(file.path(), text).map_err(|_| "The export could not be saved".to_owned())?;
    Ok(true)
}
#[tauri::command]
async fn select_repository(state: State<'_, NativeState>) -> Result<String, String> {
    let Some(folder) = rfd::AsyncFileDialog::new()
        .set_title("Select a Git repository")
        .pick_folder()
        .await
    else {
        return Err("Selection cancelled".into());
    };
    let path = folder.path().to_path_buf();
    let path2 = path.clone();
    let identity = tauri::async_runtime::spawn_blocking(move || {
        tab_core::git_context(&path2, "1970-01-01", false, false).map(|c| c.identity)
    })
    .await
    .map_err(|_| "Git task failed")??;
    *state
        .repository
        .lock()
        .map_err(|_| "Repository state unavailable")? = Some(path);
    Ok(identity)
}
#[tauri::command]
async fn git_preview(
    state: State<'_, NativeState>,
    since: String,
    subjects: bool,
    branches: bool,
) -> Result<tab_core::GitContext, String> {
    let path = state
        .repository
        .lock()
        .map_err(|_| "Repository state unavailable")?
        .clone()
        .ok_or("Select a repository first")?;
    tauri::async_runtime::spawn_blocking(move || {
        tab_core::git_context(&path, &since, subjects, branches)
    })
    .await
    .map_err(|_| "Git task failed".to_owned())?
}
pub fn run() {
    let client = match default_client() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            return;
        }
    };
    tauri::Builder::default()
        .setup(move |app| {
            let path = app
                .path()
                .app_local_data_dir()?
                .join("development-activity-v1.json");
            let (tracker, error) = match tab_core::tracking::Tracker::load(&path) {
                Ok(t) => (t, None),
                Err(e) => (Default::default(), Some(e)),
            };
            app.manage(NativeState {
                client,
                repository: Mutex::new(None),
                tracking: Mutex::new(TrackingState {
                    tracker,
                    path,
                    workspace: None,
                    error,
                }),
            });
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(30));
                    let state = handle.state::<NativeState>();
                    if let Ok(mut local) = state.tracking.lock()
                        && local.error.is_none()
                        && let Some(workspace) = local.workspace.clone()
                    {
                        local.tracker.poll(&workspace, tab_core::tracking::now());
                        if let Err(error) = local.tracker.save(&local.path) {
                            local.error = Some(error);
                        }
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tracking_state,
            tracking_discover,
            tracking_configure,
            tracking_settings,
            tracking_finish,
            tracking_remove_session,
            api_request,
            demo_login,
            connect_device,
            sign_out,
            open_url,
            export_csv,
            select_repository,
            git_preview,
            open_compact_timer
        ])
        .run(tauri::generate_context!())
        .expect("Unable to run the native application");
}
