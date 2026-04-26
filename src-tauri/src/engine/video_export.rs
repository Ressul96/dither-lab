// FFmpeg-based video export session manager.
// Spawns a system `ffmpeg` process for each export, feeds raw RGBA frames to
// stdin, then closes the pipe to produce the final encoded file. The session
// is kept in Tauri-managed state so the JS side only has to issue frame writes.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoExportConfig {
    pub output_path: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    #[serde(default = "default_codec")]
    pub codec: String,
    #[serde(default = "default_quality")]
    pub quality: u32,
    #[serde(default = "default_preset")]
    pub preset: String,
    #[serde(default)]
    pub pix_fmt: Option<String>,
}

fn default_codec() -> String {
    "libx264".to_string()
}
fn default_quality() -> u32 {
    18
}
fn default_preset() -> String {
    "medium".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegAvailability {
    pub available: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegFinishResponse {
    pub output_path: String,
    pub exit_code: i32,
    pub stderr_tail: String,
}

struct ActiveSession {
    child: Child,
    stdin: Option<ChildStdin>,
    output_path: String,
    expected_bytes_per_frame: usize,
}

#[derive(Default)]
pub struct VideoExportState {
    session: Mutex<Option<ActiveSession>>,
}

impl VideoExportState {
    pub fn new() -> Self {
        Self::default()
    }
}

fn ffmpeg_binary() -> &'static str {
    "ffmpeg"
}

#[tauri::command]
pub fn ffmpeg_check_available() -> FfmpegAvailability {
    match Command::new(ffmpeg_binary()).arg("-version").output() {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .map(|line| line.to_string());
            FfmpegAvailability {
                available: true,
                version,
                error: None,
            }
        }
        Ok(output) => FfmpegAvailability {
            available: false,
            version: None,
            error: Some(format!(
                "ffmpeg exited with status {}",
                output.status
            )),
        },
        Err(error) => FfmpegAvailability {
            available: false,
            version: None,
            error: Some(error.to_string()),
        },
    }
}

#[tauri::command]
pub fn ffmpeg_start_encode(
    config: VideoExportConfig,
    state: State<'_, VideoExportState>,
) -> Result<(), String> {
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("An export session is already active".into());
    }

    if config.width == 0 || config.height == 0 {
        return Err("Invalid frame dimensions".into());
    }
    if !config.fps.is_finite() || config.fps <= 0.0 {
        return Err("Invalid fps".into());
    }

    let output_path = PathBuf::from(&config.output_path);
    if let Some(parent) = output_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(format!(
                "Output directory does not exist: {}",
                parent.display()
            ));
        }
    }

    let size_arg = format!("{}x{}", config.width, config.height);
    let fps_arg = format_fps(config.fps);
    let crf_arg = config.quality.to_string();
    let pix_fmt_out = config.pix_fmt.clone().unwrap_or_else(|| "yuv420p".into());

    let mut command = Command::new(ffmpeg_binary());
    command
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-f")
        .arg("rawvideo")
        .arg("-pix_fmt")
        .arg("rgba")
        .arg("-s")
        .arg(&size_arg)
        .arg("-r")
        .arg(&fps_arg)
        .arg("-i")
        .arg("-")
        .arg("-c:v")
        .arg(&config.codec)
        .arg("-preset")
        .arg(&config.preset)
        .arg("-crf")
        .arg(&crf_arg)
        .arg("-pix_fmt")
        .arg(&pix_fmt_out)
        .arg("-movflags")
        .arg("+faststart")
        .arg(&config.output_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn ffmpeg: {}", e))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open ffmpeg stdin".to_string())?;

    let expected = (config.width as usize)
        .checked_mul(config.height as usize)
        .and_then(|v| v.checked_mul(4))
        .ok_or_else(|| "Frame dimensions overflow".to_string())?;

    *guard = Some(ActiveSession {
        child,
        stdin: Some(stdin),
        output_path: config.output_path.clone(),
        expected_bytes_per_frame: expected,
    });

    Ok(())
}

#[tauri::command]
pub fn ffmpeg_write_frame(
    pixels: Vec<u8>,
    state: State<'_, VideoExportState>,
) -> Result<(), String> {
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "No active export session".to_string())?;

    if pixels.len() != session.expected_bytes_per_frame {
        return Err(format!(
            "Frame payload size mismatch: got {} bytes, expected {}",
            pixels.len(),
            session.expected_bytes_per_frame
        ));
    }

    let stdin = session
        .stdin
        .as_mut()
        .ok_or_else(|| "Export session already closed".to_string())?;

    stdin
        .write_all(&pixels)
        .map_err(|e| format!("Failed to write frame to ffmpeg: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn ffmpeg_finish_encode(
    state: State<'_, VideoExportState>,
) -> Result<FfmpegFinishResponse, String> {
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    let mut session = guard
        .take()
        .ok_or_else(|| "No active export session".to_string())?;

    drop(session.stdin.take());

    let output = session
        .child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for ffmpeg: {}", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code().unwrap_or(-1);

    if !output.status.success() {
        return Err(format!(
            "ffmpeg exited with status {}: {}",
            exit_code,
            tail_lines(&stderr, 20)
        ));
    }

    Ok(FfmpegFinishResponse {
        output_path: session.output_path,
        exit_code,
        stderr_tail: tail_lines(&stderr, 20),
    })
}

#[tauri::command]
pub fn ffmpeg_cancel_encode(state: State<'_, VideoExportState>) -> Result<(), String> {
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    let Some(mut session) = guard.take() else {
        return Ok(());
    };

    drop(session.stdin.take());
    let _ = session.child.kill();
    let _ = session.child.wait();

    if !session.output_path.is_empty() {
        let _ = std::fs::remove_file(&session.output_path);
    }
    Ok(())
}

fn format_fps(fps: f64) -> String {
    let rounded = fps.round();
    if (fps - rounded).abs() < 1e-6 {
        format!("{}", rounded as i64)
    } else {
        format!("{:.4}", fps)
    }
}

fn tail_lines(text: &str, max_lines: usize) -> String {
    let collected: Vec<&str> = text.lines().collect();
    let start = collected.len().saturating_sub(max_lines);
    collected[start..].join("\n")
}
