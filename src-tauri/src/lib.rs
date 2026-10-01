use serde_json::Value;
use std::sync::Mutex;
use tab_core::{Client, default_client};
use tauri::{Manager, State};
struct NativeState {
    client: Client,
    repository: Mutex<Option<std::path::PathBuf>>,
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
    tauri::async_runtime::spawn_blocking(move || {
        client.request(&method, &path, body, key.as_deref())
    })
    .await
    .map_err(|_| "Native request task failed".to_owned())?
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
        .manage(NativeState {
            client,
            repository: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
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
