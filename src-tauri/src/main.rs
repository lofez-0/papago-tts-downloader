// 릴리스 빌드에서 콘솔 창이 뜨지 않게 한다.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod tts;

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{ipc::Response, Manager, State};

struct AppState {
    client: reqwest::Client,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TtsRequest {
    text: String,
    language: String,
    gender: String,
    speed: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveRequest {
    #[serde(flatten)]
    tts: TtsRequest,
    dir: String,
    file_name: String,
}

/// 미리듣기: mp3 바이트를 그대로 돌려준다 (JS에서는 ArrayBuffer로 받음).
#[tauri::command]
async fn preview(state: State<'_, AppState>, req: TtsRequest) -> Result<Response, String> {
    let audio = tts::synthesize(&state.client, &req.text, &req.language, &req.gender, req.speed).await?;
    Ok(Response::new(audio))
}

/// 음성을 받아 폴더에 저장하고, 실제로 저장된 파일 경로를 돌려준다.
#[tauri::command]
async fn save(state: State<'_, AppState>, req: SaveRequest) -> Result<String, String> {
    let dir = PathBuf::from(req.dir.trim());
    if req.dir.trim().is_empty() {
        return Err("저장 폴더를 먼저 골라 주세요.".into());
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("저장 폴더를 만들 수 없습니다: {e}"))?;

    let t = &req.tts;
    let audio = tts::synthesize(&state.client, &t.text, &t.language, &t.gender, t.speed).await?;
    let path = write_unique(&dir, &sanitize_file_name(&req.file_name), &audio)?;
    Ok(path.to_string_lossy().into_owned())
}

/// 저장해 둔 mp3를 다시 읽어 재생할 때 쓴다.
#[tauri::command]
fn read_audio(path: String) -> Result<Response, String> {
    let path = Path::new(&path);
    let is_mp3 = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("mp3"));
    if !is_mp3 {
        return Err("mp3 파일만 열 수 있습니다.".into());
    }
    std::fs::read(path)
        .map(Response::new)
        .map_err(|e| format!("파일을 열 수 없습니다: {e}"))
}

/// 파일 탐색기에서 파일(또는 폴더)을 보여 준다.
#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    let path = PathBuf::from(&path);
    if !path.exists() {
        return Err("파일이나 폴더가 없습니다. 이동되었거나 삭제되었을 수 있습니다.".into());
    }
    open_in_file_manager(&path).map_err(|e| format!("파일 탐색기를 열 수 없습니다: {e}"))
}

#[cfg(target_os = "windows")]
fn open_in_file_manager(path: &Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("explorer");
    if path.is_dir() {
        cmd.arg(path);
    } else {
        // explorer는 따옴표 처리가 특이해서 인자를 직접 만들어 넘긴다.
        cmd.raw_arg(format!("/select,\"{}\"", path.display()));
    }
    cmd.spawn().map(|_| ())
}

#[cfg(target_os = "macos")]
fn open_in_file_manager(path: &Path) -> std::io::Result<()> {
    std::process::Command::new("open").arg("-R").arg(path).spawn().map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_in_file_manager(path: &Path) -> std::io::Result<()> {
    let target = if path.is_dir() { path } else { path.parent().unwrap_or(path) };
    std::process::Command::new("xdg-open").arg(target).spawn().map(|_| ())
}

/// 기본 저장 폴더: 다운로드\Papago TTS
#[tauri::command]
fn default_dir(app: tauri::AppHandle) -> String {
    app.path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .map(|d| d.join("Papago TTS").to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 파일 이름에 쓸 수 없는 문자를 지우고 길이를 줄인다.
fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { ' ' } else { c })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned: String = cleaned.chars().take(60).collect();
    let cleaned = cleaned.trim_end_matches(['.', ' ']).to_string();

    // Windows 예약 이름 피하기
    let upper = cleaned.to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&upper.as_str())
        || ((upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.len() == 4
            && upper.as_bytes()[3].is_ascii_digit());
    if cleaned.is_empty() || reserved {
        "tts".into()
    } else {
        cleaned
    }
}

/// 같은 이름이 있으면 "이름 (2).mp3"처럼 번호를 붙여 새 파일로 쓴다.
fn write_unique(dir: &Path, stem: &str, data: &[u8]) -> Result<PathBuf, String> {
    for n in 1..1000 {
        let name = if n == 1 { format!("{stem}.mp3") } else { format!("{stem} ({n}).mp3") };
        let path = dir.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                f.write_all(data).map_err(|e| format!("파일을 저장할 수 없습니다: {e}"))?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("파일을 저장할 수 없습니다: {e}")),
        }
    }
    Err("같은 이름의 파일이 너무 많습니다.".into())
}

fn main() {
    let client = tts::build_client().expect("HTTP 클라이언트를 만들 수 없습니다");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { client })
        .invoke_handler(tauri::generate_handler![preview, save, read_audio, reveal, default_dir])
        .run(tauri::generate_context!())
        .expect("프로그램을 실행하는 중 오류가 발생했습니다");
}

#[cfg(test)]
mod tests {
    use super::sanitize_file_name;

    #[test]
    fn sanitizes_names() {
        assert_eq!(sanitize_file_name("001_안녕: 세상?"), "001_안녕 세상");
        assert_eq!(sanitize_file_name("   "), "tts");
        assert_eq!(sanitize_file_name("CON"), "tts");
        assert_eq!(sanitize_file_name("끝에 점..."), "끝에 점");
    }
}
