//! Synapse 桌面端（Tauri 2）后端。
//!
//! 桌面场景下，数据应该是一份**可备份、可搬走的文件**，而不是藏在 WebView 的
//! IndexedDB 里。所以这里把 core 的整个 KV 存成一个 JSON 文件，
//! 通过 `kv_load / kv_set / kv_remove` 三个命令暴露给前端。
//!
//! 前端（apps/web）在检测到 `window.__TAURI_INTERNALS__` 时会自动切到这个后端，
//! core 与业务代码完全不感知平台差异。

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{Manager, State};

/// 常驻内存的 KV 镜像 + 落盘路径。
struct KvState {
    path: PathBuf,
    data: Mutex<BTreeMap<String, Value>>,
}

fn read_store(path: &PathBuf) -> BTreeMap<String, Value> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<BTreeMap<String, Value>>(&text).unwrap_or_default(),
        Err(_) => BTreeMap::new(),
    }
}

fn write_store(state: &KvState) -> Result<(), String> {
    let data = state.data.lock().map_err(|_| "KV 锁已被污染".to_string())?;
    let text = serde_json::to_string_pretty(&*data).map_err(|error| error.to_string())?;
    fs::write(&state.path, text).map_err(|error| error.to_string())
}

/// 一次性读出全部 KV（前端启动时装进内存镜像）。
#[tauri::command]
fn kv_load(state: State<KvState>) -> Result<String, String> {
    let data = state.data.lock().map_err(|_| "KV 锁已被污染".to_string())?;
    serde_json::to_string(&*data).map_err(|error| error.to_string())
}

/// 写入一个键（值已是 JSON 文本），并立即落盘。
#[tauri::command]
fn kv_set(key: String, value: String, state: State<KvState>) -> Result<(), String> {
    let parsed: Value = serde_json::from_str(&value).map_err(|error| error.to_string())?;
    {
        let mut data = state.data.lock().map_err(|_| "KV 锁已被污染".to_string())?;
        data.insert(key, parsed);
    }
    write_store(&state)
}

/// 删除一个键，并立即落盘。
#[tauri::command]
fn kv_remove(key: String, state: State<KvState>) -> Result<(), String> {
    {
        let mut data = state.data.lock().map_err(|_| "KV 锁已被污染".to_string())?;
        data.remove(&key);
    }
    write_store(&state)
}

/// HTTP 响应（body 保持原始文本，由前端决定是否 JSON.parse）。
#[derive(Serialize)]
pub struct HttpResponsePayload {
    pub status: u16,
    pub body: String,
}

fn run_http(
    method: &str,
    url: &str,
    headers: &serde_json::Map<String, Value>,
    body: Option<String>,
) -> Result<HttpResponsePayload, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(120))
        .build();

    let mut request = agent.request(method, url);
    for (name, value) in headers {
        if let Some(text) = value.as_str() {
            request = request.set(name, text);
        }
    }

    let outcome = match body {
        Some(text) => request.send_string(&text),
        None => request.call(),
    };

    let response = match outcome {
        Ok(response) => response,
        // 4xx/5xx 在 ureq 里走 Err(Status)：业务上仍要拿到状态码与响应体
        Err(ureq::Error::Status(_, response)) => response,
        Err(other) => return Err(other.to_string()),
    };

    let status = response.status();
    let text = response.into_string().map_err(|error| error.to_string())?;
    Ok(HttpResponsePayload { status, body: text })
}

/// 由 Rust 侧代发 HTTP：绕开 WebView 的 CORS，同时不把网络逻辑塞进前端。
#[tauri::command]
async fn http_request(
    method: String,
    url: String,
    headers: Option<Value>,
    body: Option<String>,
) -> Result<HttpResponsePayload, String> {
    let header_map = headers
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    // ureq 是阻塞的：放到阻塞线程池，别卡住 async 运行时
    tauri::async_runtime::spawn_blocking(move || run_http(&method, &url, &header_map, body))
        .await
        .map_err(|error| error.to_string())?
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 数据文件放在系统约定的应用数据目录，卸载/备份都能找到
            let dir = app.path().app_data_dir()?;
            fs::create_dir_all(&dir)?;
            let path = dir.join("synapse-kv.json");
            let data = read_store(&path);
            app.manage(KvState {
                path,
                data: Mutex::new(data),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            kv_load,
            kv_set,
            kv_remove,
            http_request
        ])
        .run(tauri::generate_context!())
        .expect("运行 Synapse 桌面端失败");
}
