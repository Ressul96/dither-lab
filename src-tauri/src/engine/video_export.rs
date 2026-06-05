// FFmpeg-based video export session manager.
// Spawns a system `ffmpeg` process for each export, feeds raw RGBA frames to
// stdin, then closes the pipe to produce the final encoded file. The session
// is kept in Tauri-managed state so the JS side only has to issue frame writes.

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread::{self, JoinHandle};
use tauri::State;

use super::error::EngineError;

const STDERR_TAIL_BYTES: usize = 64 * 1024;

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
    // Optional audio passthrough. When `audio_source_path` is set the
    // ffmpeg pipeline opens it as a second input, trims to the requested
    // window, and re-encodes to AAC so the resulting MP4/MOV always has
    // a portable audio stream. Setting only the path (no trim) muxes the
    // full source audio.
    #[serde(default)]
    pub audio_source_path: Option<String>,
    #[serde(default)]
    pub audio_start_seconds: f64,
    #[serde(default)]
    pub audio_duration_seconds: f64,
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
    stderr_thread: Option<JoinHandle<String>>,
    output_path: String,
    expected_bytes_per_frame: usize,
    finished: bool,
}

impl Drop for ActiveSession {
    fn drop(&mut self) {
        drop(self.stdin.take());
        if !self.finished {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        if let Some(stderr_thread) = self.stderr_thread.take() {
            let _ = stderr_thread.join();
        }
    }
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
            error: Some(format!("ffmpeg exited with status {}", output.status)),
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
) -> Result<(), EngineError> {
    let mut guard = state.session.lock().map_err(|e| {
        EngineError::lock_poisoned(format!("Video export session lock poisoned: {e}"))
    })?;
    if guard.is_some() {
        return Err(EngineError::conflict("An export session is already active"));
    }

    if config.width == 0 || config.height == 0 {
        return Err(EngineError::invalid_input("Invalid frame dimensions"));
    }
    if !config.fps.is_finite() || config.fps <= 0.0 {
        return Err(EngineError::invalid_input("Invalid fps"));
    }

    let output_path = PathBuf::from(&config.output_path);
    if let Some(parent) = output_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(EngineError::invalid_input(format!(
                "Output directory does not exist: {}",
                parent.display()
            )));
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
        // Input 0: raw RGBA frames piped from JS.
        .arg("-f")
        .arg("rawvideo")
        .arg("-pix_fmt")
        .arg("rgba")
        .arg("-s")
        .arg(&size_arg)
        .arg("-r")
        .arg(&fps_arg)
        .arg("-i")
        .arg("-");

    // Input 1 (optional): audio source. Trim flags go *before* `-i` so
    // ffmpeg does a fast input-side seek instead of decoding the whole
    // file. Audio re-encodes to AAC because `-c:a copy` is fragile across
    // container/codec combos (e.g. PCM-in-MOV → MP4 cannot copy).
    let has_audio = config.audio_source_path.as_deref().is_some_and(|p| !p.is_empty());
    if has_audio {
        let path = config.audio_source_path.as_deref().unwrap();
        if config.audio_start_seconds > 0.0 {
            command.arg("-ss").arg(format!("{:.6}", config.audio_start_seconds));
        }
        if config.audio_duration_seconds > 0.0 {
            command.arg("-t").arg(format!("{:.6}", config.audio_duration_seconds));
        }
        command.arg("-i").arg(path);
    }

    command.arg("-map").arg("0:v:0").arg("-c:v").arg(&config.codec);
    if config.codec.starts_with("prores") {
        // ProRes is driven by a profile (default HQ=3) + 10-bit 4:2:2. It has no
        // -preset/-crf knobs — passing the x264 ones makes prores_ks error out.
        command
            .arg("-profile:v")
            .arg("3")
            .arg("-pix_fmt")
            .arg(config.pix_fmt.clone().unwrap_or_else(|| "yuv422p10le".into()));
    } else {
        command
            .arg("-preset")
            .arg(&config.preset)
            .arg("-crf")
            .arg(&crf_arg)
            .arg("-pix_fmt")
            .arg(&pix_fmt_out);
    }

    if has_audio {
        // `0?` makes the audio stream optional — if the source video has
        // no audio track ffmpeg silently produces a video-only output
        // instead of failing the entire export.
        command
            .arg("-map")
            .arg("1:a:0?")
            .arg("-c:a")
            .arg("aac")
            .arg("-b:a")
            .arg("192k")
            .arg("-shortest");
    }

    command
        .arg("-movflags")
        .arg("+faststart")
        .arg(&config.output_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| EngineError::process(format!("Failed to spawn ffmpeg: {e}")))?;

    let Some(stdin) = child.stdin.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(EngineError::process("Failed to open ffmpeg stdin"));
    };

    let Some(stderr) = child.stderr.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(EngineError::process("Failed to open ffmpeg stderr"));
    };

    let expected = (config.width as usize)
        .checked_mul(config.height as usize)
        .and_then(|v| v.checked_mul(4))
        .ok_or_else(|| EngineError::invalid_input("Frame dimensions overflow"))?;

    *guard = Some(ActiveSession {
        child,
        stdin: Some(stdin),
        stderr_thread: Some(spawn_stderr_drain(stderr)),
        output_path: config.output_path.clone(),
        expected_bytes_per_frame: expected,
        finished: false,
    });

    Ok(())
}

#[tauri::command]
pub fn ffmpeg_write_frame(
    pixels: Vec<u8>,
    state: State<'_, VideoExportState>,
) -> Result<(), EngineError> {
    let mut guard = state.session.lock().map_err(|e| {
        EngineError::lock_poisoned(format!("Video export session lock poisoned: {e}"))
    })?;
    let session = guard
        .as_mut()
        .ok_or_else(|| EngineError::not_found("No active export session"))?;

    if pixels.len() != session.expected_bytes_per_frame {
        return Err(EngineError::invalid_input(format!(
            "Frame payload size mismatch: got {} bytes, expected {}",
            pixels.len(),
            session.expected_bytes_per_frame
        )));
    }

    let stdin = session
        .stdin
        .as_mut()
        .ok_or_else(|| EngineError::conflict("Export session already closed"))?;

    stdin
        .write_all(&pixels)
        .map_err(|e| EngineError::io(format!("Failed to write frame to ffmpeg: {e}")))?;
    Ok(())
}

#[tauri::command]
pub fn ffmpeg_finish_encode(
    state: State<'_, VideoExportState>,
) -> Result<FfmpegFinishResponse, EngineError> {
    // Take the session out of the mutex in a tight inner scope so the lock
    // is released before we wait on ffmpeg. child.wait() blocks until ffmpeg
    // flushes the trailer (can take seconds on a long encode); holding the
    // mutex through it would freeze every concurrent Tauri command that
    // touches the export state (cancel, status, etc.) for the same duration.
    let mut session = {
        let mut guard = state.session.lock().map_err(|e| {
            EngineError::lock_poisoned(format!("Video export session lock poisoned: {e}"))
        })?;
        guard
            .take()
            .ok_or_else(|| EngineError::not_found("No active export session"))?
    };

    drop(session.stdin.take());

    let status = session
        .child
        .wait()
        .map_err(|e| EngineError::process(format!("Failed to wait for ffmpeg: {e}")))?;
    session.finished = true;

    let stderr = join_stderr_tail(session.stderr_thread.take());
    let exit_code = status.code().unwrap_or(-1);

    if !status.success() {
        return Err(EngineError::process(format!(
            "ffmpeg exited with status {}: {}",
            exit_code,
            tail_lines(&stderr, 20)
        )));
    }

    Ok(FfmpegFinishResponse {
        output_path: session.output_path.clone(),
        exit_code,
        stderr_tail: tail_lines(&stderr, 20),
    })
}

#[tauri::command]
pub fn ffmpeg_cancel_encode(state: State<'_, VideoExportState>) -> Result<(), EngineError> {
    // Take the session out under the lock, then release it before we kill +
    // wait + remove the partial file. kill() is fast but wait() can still
    // hang briefly on Windows if ffmpeg is mid-flush, and remove_file() is
    // disk I/O — none of these should serialize against other commands.
    let mut session = {
        let mut guard = state.session.lock().map_err(|e| {
            EngineError::lock_poisoned(format!("Video export session lock poisoned: {e}"))
        })?;
        let Some(session) = guard.take() else {
            return Ok(());
        };
        session
    };

    drop(session.stdin.take());
    let _ = session.child.kill();
    let _ = session.child.wait();
    session.finished = true;
    let _ = join_stderr_tail(session.stderr_thread.take());

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

fn spawn_stderr_drain(mut stderr: ChildStderr) -> JoinHandle<String> {
    thread::spawn(move || {
        let mut tail = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            match stderr.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    tail.extend_from_slice(&buffer[..n]);
                    if tail.len() > STDERR_TAIL_BYTES {
                        let overflow = tail.len() - STDERR_TAIL_BYTES;
                        tail.drain(0..overflow);
                    }
                }
                Err(_) => break,
            }
        }
        String::from_utf8_lossy(&tail).to_string()
    })
}

fn join_stderr_tail(stderr_thread: Option<JoinHandle<String>>) -> String {
    stderr_thread
        .and_then(|thread| thread.join().ok())
        .unwrap_or_default()
}
